// Warteschlange der Fahrer-App (IndexedDB).
//
// Jeder gescannte Frachtbrief landet ZUERST hier und wird erst danach
// gesendet - so geht bei Funkloch oder abgebrochener Verbindung nichts
// verloren. Der Server erkennt Wiederholungen an der clientId, ein Brief
// kommt also nie doppelt im Büro an.
//
// Der Service Worker (public/fahrer/sw.js) liest dieselbe Datenbank, um auf
// Android auch bei geschlossener App nachzusenden (Background Sync).
// Aufbau dort bitte gleich halten: DB "fahrer-app", Stores "queue" + "meta".

const DB_NAME = "fahrer-app";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "clientId" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => { db.close(); resolve(result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

const reqToPromise = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function setMeta(key, value) {
  try { await tx("meta", "readwrite", (s) => s.put(value, key)); } catch { /* egal */ }
}

export async function addToQueue(item) {
  await tx("queue", "readwrite", (s) => s.put(item));
}

export async function listQueue() {
  try {
    return await tx("queue", "readonly", (s) => reqToPromise(s.getAll()));
  } catch {
    return [];
  }
}

export async function removeFromQueue(clientId) {
  await tx("queue", "readwrite", (s) => s.delete(clientId));
}

let running = null;

// Sendet alles aus der Warteschlange. Gibt { gesendet, offen, abgemeldet } zurück.
export function processQueue(apiUrl, token) {
  if (running) return running;
  running = (async () => {
    let gesendet = 0;
    let abgemeldet = false;
    const items = await listQueue();
    for (const item of items.sort((a, b) => a.createdAt - b.createdAt)) {
      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "upload", token, clientId: item.clientId, pages: item.pages }),
        });
        if (res.status === 401) { abgemeldet = true; break; }
        if (!res.ok) continue; // später nochmal
        await removeFromQueue(item.clientId);
        gesendet++;
      } catch {
        break; // kein Netz - Rest später
      }
    }
    const offen = (await listQueue()).length;
    return { gesendet, offen, abgemeldet };
  })().finally(() => { running = null; });
  return running;
}
