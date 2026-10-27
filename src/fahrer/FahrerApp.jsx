// Fahrer-App (/fahrer/): Frachtbrief fotografieren und ans Büro senden.
//
// Bewusst getrennt von der Tourenliste: Fahrer haben KEIN Supabase-Login und
// sehen keine Touren/Umsätze. Anmeldung mit Name + PIN über die Edge Function
// fahrer-api, die ein Token ausgibt (wird auf dem Handy gespeichert).
//
// Ablauf: Foto(s) aufnehmen -> im Handy auf ~2000 px verkleinern (JPEG) ->
// in die Warteschlange (IndexedDB) -> senden. Ohne Netz bleibt der Brief in
// der Warteschlange und wird automatisch nachgesendet.

import { useEffect, useRef, useState } from "react";
import { addToQueue, listQueue, processQueue, setMeta } from "./queue";

const API_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fahrer-api`;
const TOKEN_KEY = "fahrer-token";
const NAME_KEY = "fahrer-name";
const MAX_SEITEN = 8;
const MAX_KANTE = 2000; // Pixel, lange Seite - gut lesbar, ca. 0,3-0,6 MB pro Seite
const JPEG_QUALITAET = 0.8;

const C = {
  bg: "#F3F2EE", ink: "#16202A", muted: "#5B6470", line: "#D9D7D0", card: "#FFFFFF",
  accent: "#C2410C", accentDark: "#9A3412", dark: "#0F161D",
  okBg: "#E3F1E9", ok: "#1F6B44", warnBg: "#FBEFD5", warn: "#7A4F00",
  infoBg: "#E8EEF6", info: "#1E3A5F", errBg: "#FBE4DE", err: "#9B2C12",
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* egal */ } }

async function api(action, data = {}) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...data }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || "Fehler");
    err.status = res.status;
    throw err;
  }
  return body;
}

// Foto verkleinern -> { b64, w, h, thumb }
async function bildVorbereiten(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, MAX_KANTE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITAET);
    const t = document.createElement("canvas");
    const ts = 160 / Math.max(w, h);
    t.width = Math.round(w * ts);
    t.height = Math.round(h * ts);
    t.getContext("2d").drawImage(canvas, 0, 0, t.width, t.height);
    const v = document.createElement("canvas"); // große Vorschau zum Prüfen der Lesbarkeit
    const vs = Math.min(1, 900 / Math.max(w, h));
    v.width = Math.round(w * vs);
    v.height = Math.round(h * vs);
    v.getContext("2d").drawImage(canvas, 0, 0, v.width, v.height);
    return {
      b64: dataUrl.slice(dataUrl.indexOf(",") + 1), w, h,
      thumb: t.toDataURL("image/jpeg", 0.7), preview: v.toDataURL("image/jpeg", 0.75),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function uhrzeit(iso) {
  const d = new Date(iso);
  const heute = new Date();
  const zeit = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === heute.toDateString()) return `heute ${zeit}`;
  return `${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} ${zeit}`;
}

// ------------------------------------------------------------- Bausteine ----
function Screen({ children, dark }) {
  return (
    <div style={{
      minHeight: "100dvh", background: dark ? C.dark : C.bg, color: dark ? "#fff" : C.ink,
      fontFamily: FONT, display: "flex", flexDirection: "column", boxSizing: "border-box",
      paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)",
    }}>
      <div style={{ width: "100%", maxWidth: 520, margin: "0 auto", flex: 1, display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}

const btnBase = {
  display: "flex", alignItems: "center", justifyContent: "center", gap: 10, border: "none",
  borderRadius: 14, fontFamily: FONT, fontWeight: 600, cursor: "pointer", textDecoration: "none",
  WebkitTapHighlightColor: "transparent", boxSizing: "border-box", width: "100%",
};
const btnPrimary = { ...btnBase, height: 60, background: C.accent, color: "#fff", fontSize: 18 };
const btnSecondary = { ...btnBase, height: 52, background: C.card, color: C.ink, fontSize: 16, border: `1px solid ${C.line}` };

function Hinweis({ kind = "info", children }) {
  const map = { info: [C.infoBg, C.info], warn: [C.warnBg, C.warn], err: [C.errBg, C.err], ok: [C.okBg, C.ok] };
  const [bg, fg] = map[kind];
  return (
    <div role={kind === "err" ? "alert" : undefined} style={{ background: bg, color: fg, borderRadius: 12, padding: "12px 14px", fontSize: 15, lineHeight: 1.45 }}>
      {children}
    </div>
  );
}

function ScanIcon({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" /><path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M8 9h8" /><path d="M8 12h8" /><path d="M8 15h5" />
    </svg>
  );
}

// Unsichtbares Datei-Feld, über ein <label> als großer Button bedienbar.
// capture="environment" öffnet direkt die Rückkamera.
function FotoButton({ onFiles, kamera = true, style, children, disabled }) {
  const id = useRef("f" + Math.random().toString(36).slice(2)).current;
  return (
    <label htmlFor={id} style={{ position: "relative", ...style, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? "none" : "auto" }}>
      {children}
      <input
        id={id} type="file" accept="image/*" {...(kamera ? { capture: "environment" } : { multiple: true })}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" }}
        onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ""; if (files.length) onFiles(files); }}
      />
    </label>
  );
}

function StatusChip({ brief }) {
  let text = "Im Büro", bg = C.warnBg, fg = C.warn;
  if (brief.wartet) { text = "Wartet auf Netz"; bg = C.infoBg; fg = C.info; }
  else if (brief.status === "erledigt") { text = "Tour angelegt"; bg = C.okBg; fg = C.ok; }
  else if (brief.status === "verworfen") { text = "Vom Büro aussortiert"; bg = "#ECEAE4"; fg = C.muted; }
  return <span style={{ padding: "4px 10px", borderRadius: 999, background: bg, color: fg, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>{text}</span>;
}

// ------------------------------------------------------------------ App ----
export default function FahrerApp() {
  const [token, setToken] = useState(() => lsGet(TOKEN_KEY));
  const [name, setName] = useState(() => lsGet(NAME_KEY) || "");
  const [lkw, setLkw] = useState(null);
  const [screen, setScreen] = useState("home"); // home | scan | sent
  const [briefe, setBriefe] = useState([]);
  const [wartend, setWartend] = useState([]);
  const [seiten, setSeiten] = useState([]); // aktuelle Aufnahme
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState("");
  const [letzterVersand, setLetzterVersand] = useState(null); // { seiten, offline, zeit }
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);

  function abmelden() {
    lsSet(TOKEN_KEY, null);
    setMeta("token", null);
    setToken(null);
    setBriefe([]);
  }

  async function aktualisieren(tok = token) {
    setWartend(await listQueue());
    if (!tok) return;
    try {
      const me = await api("me", { token: tok });
      setBriefe(me.briefe || []);
      setLkw(me.lkw);
    } catch (err) {
      if (err.status === 401) abmelden();
    }
  }

  async function warteschlangeSenden(tok = token) {
    if (!tok) return;
    const r = await processQueue(API_URL, tok);
    if (r.abgemeldet) abmelden();
    await aktualisieren(tok);
    return r;
  }

  // Start + bei wieder Netz / App wieder im Vordergrund: nachsenden & aktualisieren
  useEffect(() => {
    if (!token) return;
    setMeta("token", token);
    setMeta("apiUrl", API_URL);
    warteschlangeSenden(token);
    const onOnline = () => { setOnline(true); warteschlangeSenden(); };
    const onOffline = () => setOnline(false);
    const onVisible = () => { if (document.visibilityState === "visible") warteschlangeSenden(); };
    const onSwMsg = (e) => { if (e.data && e.data.type === "queue-sent") aktualisieren(); };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    navigator.serviceWorker?.addEventListener("message", onSwMsg);
    const iv = setInterval(() => { listQueue().then((q) => { if (q.length) warteschlangeSenden(); }); }, 30000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker?.removeEventListener("message", onSwMsg);
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function fotosHinzu(files) {
    setFehler("");
    setBusy(true);
    try {
      const neu = [];
      for (const f of files) {
        if (seiten.length + neu.length >= MAX_SEITEN) break;
        neu.push(await bildVorbereiten(f));
      }
      setSeiten((s) => [...s, ...neu]);
      setScreen("scan");
    } catch {
      setFehler("Foto konnte nicht gelesen werden. Bitte nochmal aufnehmen.");
    } finally {
      setBusy(false);
    }
  }

  async function senden() {
    if (!seiten.length) return;
    setBusy(true);
    setFehler("");
    const item = {
      clientId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: Date.now(),
      pages: seiten.map(({ b64, w, h }) => ({ b64, w, h })),
    };
    try {
      await addToQueue(item);
    } catch {
      setBusy(false);
      setFehler("Speichern auf dem Handy fehlgeschlagen. Bitte nochmal versuchen.");
      return;
    }
    // Für Android: falls jetzt kein Netz, sendet der Service Worker später auch bei geschlossener App
    try {
      // getRegistration statt .ready: .ready wartet ewig, falls kein Service Worker läuft
      const reg = await navigator.serviceWorker?.getRegistration("/fahrer/");
      if (reg && reg.active && "sync" in reg) {
        await Promise.race([reg.sync.register("frachtbriefe"), new Promise((r) => setTimeout(r, 2000))]);
      }
    } catch { /* nicht unterstützt (iPhone) - App sendet beim nächsten Öffnen */ }

    const r = await warteschlangeSenden();
    const nochDa = (await listQueue()).some((q) => q.clientId === item.clientId);
    setLetzterVersand({ seiten: seiten.length, offline: nochDa, zeit: new Date(), abgemeldet: r?.abgemeldet });
    setSeiten([]);
    setBusy(false);
    setScreen("sent");
  }

  if (!token) {
    return <Login onLogin={(t, n, l) => { lsSet(TOKEN_KEY, t); lsSet(NAME_KEY, n); setToken(t); setName(n); setLkw(l); setScreen("home"); }} />;
  }

  // ---------------------------------------------------------- Scannen -----
  if (screen === "scan") {
    return (
      <Screen dark>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 8px" }}>
          <button
            aria-label="Abbrechen" onClick={() => { setSeiten([]); setScreen("home"); setFehler(""); }}
            style={{ ...btnBase, width: "auto", height: 44, padding: "0 12px", background: "transparent", color: "#fff", fontSize: 16 }}
          >
            Abbrechen
          </button>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{seiten.length === 1 ? "1 Seite" : `${seiten.length} Seiten`}</div>
          <div style={{ width: 96 }} />
        </div>

        <div style={{ flex: 1, padding: "8px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          {seiten.length > 0 && (
            <div style={{ borderRadius: 16, background: "#26313B", padding: 12, display: "flex", justifyContent: "center" }}>
              <img
                src={seiten[seiten.length - 1].preview} alt={`Seite ${seiten.length}`}
                style={{ maxWidth: "100%", maxHeight: "40dvh", borderRadius: 6, background: "#fff", objectFit: "contain", width: "auto", height: "40dvh" }}
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
            {seiten.map((s, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <img src={s.thumb} alt={`Seite ${i + 1}`} style={{ width: 56, height: 74, objectFit: "cover", borderRadius: 6, border: "2px solid #fff" }} />
                <button
                  aria-label={`Seite ${i + 1} entfernen`}
                  onClick={() => setSeiten((all) => all.filter((_, j) => j !== i))}
                  style={{ position: "absolute", top: -8, right: -8, width: 28, height: 28, borderRadius: 14, border: "none", background: "#fff", color: C.ink, fontSize: 16, fontWeight: 700, cursor: "pointer" }}
                >×</button>
                <span style={{ fontSize: 12, color: "#C9CFD6" }}>Seite {i + 1}</span>
              </div>
            ))}
            {seiten.length < MAX_SEITEN && (
              <FotoButton onFiles={fotosHinzu} disabled={busy} style={{ flexShrink: 0, width: 56, height: 74, borderRadius: 6, border: "2px dashed #8A949E", color: "#C9CFD6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, cursor: "pointer", position: "relative" }}>
                <span aria-hidden="true">+</span><span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Weitere Seite</span>
              </FotoButton>
            )}
          </div>
          <div style={{ fontSize: 14, color: "#C9CFD6", lineHeight: 1.45 }}>
            Ist alles gut lesbar? Sonst Seite mit × entfernen und neu fotografieren. Mehrseitig? Mit + weitere Seite aufnehmen.
          </div>
          {fehler && <Hinweis kind="err">{fehler}</Hinweis>}
        </div>

        <div style={{ padding: "12px 16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
          <button onClick={senden} disabled={busy || !seiten.length} style={{ ...btnPrimary, opacity: busy || !seiten.length ? 0.6 : 1 }}>
            {busy ? "Wird gesendet …" : `Senden (${seiten.length === 1 ? "1 Seite" : `${seiten.length} Seiten`})`}
          </button>
        </div>
      </Screen>
    );
  }

  // ---------------------------------------------------------- Gesendet ----
  if (screen === "sent" && letzterVersand) {
    const off = letzterVersand.offline;
    return (
      <Screen>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 24, padding: "64px 24px 24px" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center" }}>
            <div style={{ width: 96, height: 96, borderRadius: 48, background: off ? C.infoBg : C.okBg, color: off ? C.info : C.ok, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {off ? (
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
              ) : (
                <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              )}
            </div>
            <h1 style={{ margin: 0, fontSize: 28 }}>{off ? "Gespeichert" : "Frachtbrief gesendet"}</h1>
            <p style={{ margin: 0, fontSize: 16, lineHeight: 1.5, color: C.muted }}>
              {off
                ? "Gerade kein Netz. Der Brief ist auf dem Handy sicher gespeichert und geht automatisch raus, sobald wieder Netz da ist."
                : "Das Büro hat ihn jetzt im Eingang. Du musst nichts weiter tun."}
            </p>
          </div>
          <div style={{ borderRadius: 14, background: C.card, border: `1px solid ${C.line}` }}>
            {[
              ["Uhrzeit", letzterVersand.zeit.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })],
              ["Seiten", String(letzterVersand.seiten)],
              ["Fahrer", name],
              ["LKW", lkw || "–"],
            ].map(([k, v], i, arr) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "14px 16px", borderBottom: i < arr.length - 1 ? "1px solid #ECEAE4" : "none", fontSize: 16 }}>
                <span style={{ color: C.muted }}>{k}</span><span style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
          {letzterVersand.abgemeldet && <Hinweis kind="warn">Du wurdest abgemeldet (PIN geändert?). Bitte neu anmelden – der Brief wird danach gesendet.</Hinweis>}
          <div style={{ flex: 1 }} />
          <FotoButton onFiles={fotosHinzu} style={btnPrimary}>Nächsten scannen</FotoButton>
          <button onClick={() => setScreen("home")} style={btnSecondary}>Zur Übersicht</button>
        </div>
      </Screen>
    );
  }

  // ------------------------------------------------------------- Start ----
  const liste = [
    ...wartend.map((q) => ({ id: q.clientId, created_at: new Date(q.createdAt).toISOString(), seiten: q.pages.length, wartet: true })),
    ...briefe.filter((b) => !wartend.some((q) => q.clientId === b.client_id)),
  ];
  const heute = new Date().toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit" });

  return (
    <Screen>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20, padding: "24px 20px 24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <div style={{ fontSize: 15, color: C.muted }}>{heute}</div>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>Hallo {name}</h1>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
            <div style={{ fontSize: 12, color: C.muted }}>LKW diese Woche</div>
            <div style={{ padding: "6px 10px", borderRadius: 8, background: C.ink, color: "#fff", fontSize: 15, fontFamily: "ui-monospace, Menlo, monospace" }}>{lkw || "–"}</div>
          </div>
        </div>

        {!online && <Hinweis kind="info">Kein Netz – du kannst trotzdem scannen. Gesendet wird automatisch, sobald wieder Netz da ist.</Hinweis>}
        {fehler && <Hinweis kind="err">{fehler}</Hinweis>}

        <FotoButton onFiles={fotosHinzu} disabled={busy} style={{ ...btnBase, flexDirection: "column", gap: 12, height: 230, borderRadius: 20, background: C.accent, color: "#fff", position: "relative" }}>
          <ScanIcon size={60} />
          <span style={{ fontSize: 24, fontWeight: 700 }}>{busy ? "Foto wird vorbereitet …" : "Frachtbrief scannen"}</span>
          <span style={{ fontSize: 14, fontWeight: 400, opacity: 0.92 }}>Foto machen · Senden · fertig</span>
        </FotoButton>
        <FotoButton onFiles={fotosHinzu} kamera={false} disabled={busy} style={{ ...btnSecondary, position: "relative" }}>
          Foto aus Galerie wählen
        </FotoButton>

        <InstallHinweis />

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Zuletzt gesendet</h2>
          {liste.length === 0 && <div style={{ color: C.muted, fontSize: 15 }}>Noch nichts gesendet.</div>}
          {liste.slice(0, 15).map((b) => (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, borderRadius: 12, background: C.card, border: `1px solid ${C.line}` }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Frachtbrief · {b.seiten === 1 ? "1 Seite" : `${b.seiten} Seiten`}</div>
                <div style={{ fontSize: 13, color: C.muted }}>{uhrzeit(b.created_at)}</div>
              </div>
              <StatusChip brief={b} />
            </div>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <button onClick={abmelden} style={{ ...btnBase, height: 44, background: "transparent", color: C.muted, fontSize: 14, fontWeight: 500 }}>
          Abmelden ({name})
        </button>
      </div>
    </Screen>
  );
}

// ----------------------------------------------------------- Anmeldung ----
function Login({ onLogin }) {
  const [fahrer, setFahrer] = useState(null); // null = lädt
  const [wahl, setWahl] = useState(() => lsGet(NAME_KEY) || "");
  const [pin, setPin] = useState("");
  const [fehler, setFehler] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api("fahrer").then((r) => setFahrer(r.fahrer || [])).catch(() => { setFahrer([]); setFehler("Keine Verbindung. Bitte mit Internet nochmal öffnen."); });
  }, []);

  async function anmelden(e) {
    e.preventDefault();
    if (!wahl || pin.length < 4) return;
    setBusy(true);
    setFehler("");
    try {
      const r = await api("login", { name: wahl, pin });
      onLogin(r.token, r.name, r.lkw);
    } catch (err) {
      setFehler(err.status ? err.message : "Keine Verbindung. Bitte nochmal versuchen.");
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <form onSubmit={anmelden} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 24, padding: "40px 24px 24px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.muted }}>Royal Logistik · Fahrer</div>
          <h1 style={{ margin: 0, fontSize: 30, lineHeight: 1.15 }}>Wer bist du?</h1>
        </div>
        {fahrer === null && <div style={{ color: C.muted }}>Lade …</div>}
        {fahrer && fahrer.length === 0 && !fehler && (
          <Hinweis kind="warn">Noch keine Fahrer freigeschaltet. Das Büro muss dir zuerst einen PIN geben.</Hinweis>
        )}
        {fahrer && fahrer.length > 0 && (
          <div role="radiogroup" aria-label="Fahrer" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
            {fahrer.map((n) => (
              <button
                key={n} type="button" role="radio" aria-checked={wahl === n} onClick={() => setWahl(n)}
                style={{ height: 56, borderRadius: 12, border: wahl === n ? `2px solid ${C.accent}` : `1px solid ${C.line}`, background: wahl === n ? "#FFF4EE" : C.card, fontFamily: FONT, fontSize: 17, fontWeight: wahl === n ? 700 : 500, color: C.ink, cursor: "pointer" }}
              >{n}</button>
            ))}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label htmlFor="pin" style={{ fontSize: 15, fontWeight: 600 }}>PIN</label>
          <input
            id="pin" type="password" inputMode="numeric" autoComplete="current-password" pattern="[0-9]*" maxLength={6}
            value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            style={{ height: 56, borderRadius: 12, border: `1px solid ${C.line}`, background: C.card, padding: "0 16px", fontSize: 24, letterSpacing: "0.3em", color: C.ink, boxSizing: "border-box", fontFamily: "ui-monospace, Menlo, monospace" }}
          />
          <div style={{ fontSize: 13, color: C.muted }}>Nur einmal nötig – danach bleibt das Handy angemeldet.</div>
        </div>
        {fehler && <Hinweis kind="err">{fehler}</Hinweis>}
        <div style={{ flex: 1 }} />
        <button type="submit" disabled={busy || !wahl || pin.length < 4} style={{ ...btnPrimary, opacity: busy || !wahl || pin.length < 4 ? 0.55 : 1 }}>
          {busy ? "Anmelden …" : "Anmelden"}
        </button>
      </form>
    </Screen>
  );
}

// Hinweis zum Installieren auf dem Startbildschirm (nur wenn noch im Browser)
function InstallHinweis() {
  const [prompt, setPrompt] = useState(null);
  const [zu, setZu] = useState(() => lsGet("fahrer-install-zu") === "1");
  const standalone = typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone);
  const ios = typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);

  useEffect(() => {
    const h = (e) => { e.preventDefault(); setPrompt(e); };
    window.addEventListener("beforeinstallprompt", h);
    return () => window.removeEventListener("beforeinstallprompt", h);
  }, []);

  if (standalone || zu || (!ios && !prompt)) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14, borderRadius: 12, background: C.infoBg, color: C.info, fontSize: 15, lineHeight: 1.45 }}>
      <strong>Als App auf den Startbildschirm legen</strong>
      {ios ? (
        <span>Unten in Safari auf <strong>Teilen</strong> (Quadrat mit Pfeil) tippen, dann <strong>„Zum Home-Bildschirm“</strong>.</span>
      ) : (
        <button onClick={async () => { prompt.prompt(); await prompt.userChoice; setPrompt(null); }} style={{ ...btnBase, height: 44, background: C.info, color: "#fff", fontSize: 15 }}>
          Jetzt installieren
        </button>
      )}
      <button onClick={() => { lsSet("fahrer-install-zu", "1"); setZu(true); }} style={{ ...btnBase, height: 36, background: "transparent", color: C.info, fontSize: 14, fontWeight: 500, width: "auto", alignSelf: "flex-start", padding: 0 }}>
        Ausblenden
      </button>
    </div>
  );
}
