// Service Worker der Fahrer-App (Scope /fahrer/).
//
// 1. Macht die App installierbar (Startbildschirm) und hält die App-Hülle
//    offline verfügbar.
// 2. Background Sync (Android/Chrome): Frachtbriefe, die ohne Netz gescannt
//    wurden, werden nachgesendet, sobald wieder Netz da ist - auch wenn die
//    App geschlossen ist. iPhone kennt das nicht; dort sendet die App beim
//    nächsten Öffnen.
//
// Datenbank-Aufbau muss zu src/fahrer/queue.js passen.

const CACHE = "fahrer-shell-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/fahrer/"])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Seiten-Aufrufe: erst Netz (immer neueste Version), ohne Netz die gespeicherte
// Hülle. Skripte/Bilder der App: aus dem Cache, falls schon geladen.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put("/fahrer/", copy)).catch(() => {});
        return res;
      }).catch(() => caches.match("/fahrer/"))
    );
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fahrer/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }))
    );
  }
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("fahrer-app", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "clientId" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idb(db, store, mode, op) {
  return new Promise((resolve, reject) => {
    const r = op(db.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function sendQueue() {
  const db = await openDb();
  try {
    const token = await idb(db, "meta", "readonly", (s) => s.get("token"));
    const apiUrl = await idb(db, "meta", "readonly", (s) => s.get("apiUrl"));
    if (!token || !apiUrl) return;
    const items = await idb(db, "queue", "readonly", (s) => s.getAll());
    for (const item of items) {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", token, clientId: item.clientId, pages: item.pages }),
      });
      if (res.status === 401) return;
      if (!res.ok) throw new Error("Upload fehlgeschlagen");
      await idb(db, "queue", "readwrite", (s) => s.delete(item.clientId));
    }
    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.postMessage({ type: "queue-sent" }));
  } finally {
    db.close();
  }
}

self.addEventListener("sync", (e) => {
  if (e.tag === "frachtbriefe") e.waitUntil(sendQueue());
});
