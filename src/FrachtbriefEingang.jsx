// Tab "Frachtbrief-Eingang": alle Frachtbriefe, die Fahrer über die
// Fahrer-App (/fahrer/) geschickt haben - schon von der KI ausgelesen.
// "Tour anlegen" öffnet "Neue Tour" vorausgefüllt (gleiche Logik wie
// "Frachtbrief hochladen"); nach dem Speichern wird der Brief erledigt und
// mit der Tour verknüpft (das macht App.jsx).
//
// Unten: Fahrer-Zugänge (PIN je Fahrer) verwalten.

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, FileText, Loader2, PlusCircle, Eye, RotateCcw, Archive, KeyRound, Copy, Smartphone, X } from "lucide-react";
import { supabase } from "./supabaseClient";
import * as db from "./db";

const MARINE = "#0F2A43";
const AMBER_DARK = "#8A5A10";
const BG = "#F5F6F8";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS = "#2F8F6B";
const WARN_BG = "#FDF1DD";

const FAHRER_APP_URL = `${window.location.origin}/fahrer/`;

function zeitText(iso) {
  const d = new Date(iso);
  const heute = new Date();
  const gestern = new Date(Date.now() - 864e5);
  const zeit = d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === heute.toDateString()) return `heute ${zeit}`;
  if (d.toDateString() === gestern.toDateString()) return `gestern ${zeit}`;
  return `${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" })} ${zeit}`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(new Error("Datei konnte nicht gelesen werden."));
    r.readAsDataURL(blob);
  });
}

function Chip({ bg, fg, children, title }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 999, background: bg, color: fg, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function AusleseChip({ row }) {
  if (row.auslese_status === "laeuft") return <Chip bg="#E8EEF6" fg="#1E3A5F"><Loader2 size={11} /> wird ausgelesen</Chip>;
  if (row.auslese_status === "fehler") return <Chip bg={DANGER_BG} fg={DANGER} title={row.auslese_fehler || ""}>Auslesen fehlgeschlagen</Chip>;
  const unsicher = (row.extraktion?.unsichereFelder || []).length;
  if (unsicher > 0) return <Chip bg={WARN_BG} fg={AMBER_DARK} title={`KI unsicher bei: ${row.extraktion.unsichereFelder.join(", ")}`}>{unsicher} Feld{unsicher > 1 ? "er" : ""} prüfen</Chip>;
  return <Chip bg="#E3F1E9" fg={SUCCESS}>vollständig</Chip>;
}

export default function FrachtbriefEingang({ drivers, fleet, tours, onTourAnlegen, onCountChange }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fehler, setFehler] = useState("");
  const [filter, setFilter] = useState("neu");
  const [auswahl, setAuswahl] = useState(null); // Zeile in der Vorschau
  const [vorschauUrl, setVorschauUrl] = useState(null);
  const [busyId, setBusyId] = useState(null);

  async function laden() {
    setFehler("");
    const { data, error } = await supabase
      .from("frachtbrief_eingang").select("*").order("created_at", { ascending: false }).limit(300);
    setLoading(false);
    if (error) { setFehler("Eingang konnte nicht geladen werden."); return; }
    setRows(data || []);
    onCountChange?.((data || []).filter((r) => r.status === "neu").length);
  }

  useEffect(() => {
    laden();
    const iv = setInterval(laden, 20000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auswahl aktuell halten, wenn die Liste neu geladen wurde (z. B. Auslesen fertig)
  useEffect(() => {
    if (auswahl) {
      const neu = rows.find((r) => r.id === auswahl.id);
      if (neu && neu !== auswahl) setAuswahl(neu);
    }
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  async function signedUrl(row) {
    const { data, error } = await supabase.storage.from("frachtbriefe").createSignedUrl(row.datei_pfad, 3600);
    if (error) throw error;
    return data.signedUrl;
  }

  async function zeigen(row) {
    setAuswahl(row);
    setVorschauUrl(null);
    try { setVorschauUrl(await signedUrl(row)); } catch { setFehler("Vorschau konnte nicht geladen werden."); }
  }

  async function oeffnen(row) {
    try { window.open(await signedUrl(row), "_blank", "noopener"); } catch { setFehler("PDF konnte nicht geöffnet werden."); }
  }

  async function setStatus(row, status) {
    setBusyId(row.id);
    const { error } = await supabase.from("frachtbrief_eingang")
      .update({ status, erledigt_at: status === "neu" ? null : new Date().toISOString() }).eq("id", row.id);
    setBusyId(null);
    if (error) setFehler("Ändern fehlgeschlagen.");
    laden();
  }

  // Falls das automatische Auslesen fehlgeschlagen ist: hier aus dem Browser
  // nochmal anstoßen (gleiche Function wie "Frachtbrief hochladen").
  async function erneutAuslesen(row) {
    setBusyId(row.id);
    setFehler("");
    try {
      const { data: blob, error } = await supabase.storage.from("frachtbriefe").download(row.datei_pfad);
      if (error) throw error;
      const b64 = await blobToBase64(blob);
      const extr = await db.extractFrachtbrief(b64, "application/pdf", fleet.map((f) => f.plate).filter(Boolean));
      await supabase.from("frachtbrief_eingang").update({ extraktion: extr, auslese_status: "fertig", auslese_fehler: null }).eq("id", row.id);
    } catch (err) {
      setFehler(err.message || "Auslesen fehlgeschlagen.");
    } finally {
      setBusyId(null);
      laden();
    }
  }

  const counts = useMemo(() => ({
    neu: rows.filter((r) => r.status === "neu").length,
    erledigt: rows.filter((r) => r.status === "erledigt").length,
    verworfen: rows.filter((r) => r.status === "verworfen").length,
    alle: rows.length,
  }), [rows]);
  const sichtbar = filter === "alle" ? rows : rows.filter((r) => r.status === filter);
  const tourById = useMemo(() => new Map(tours.map((t) => [t.id, t])), [tours]);

  const th = { textAlign: "left", padding: "10px 9px", fontSize: 11.5, fontWeight: 600, color: TEXT_MUTED, borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap" };
  const td = { padding: "10px 9px", fontSize: 13, borderBottom: `1px solid ${BORDER}`, verticalAlign: "middle" };
  const mono = { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 4, padding: 4, background: "#E9EDF1", borderRadius: 10, flexWrap: "wrap" }}>
          {[["neu", "Neu"], ["erledigt", "Erledigt"], ["verworfen", "Aussortiert"], ["alle", "Alle"]].map(([k, l]) => (
            <button
              key={k} type="button" onClick={() => setFilter(k)}
              style={{ border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: filter === k ? 600 : 500, cursor: "pointer", background: filter === k ? CARD : "transparent", color: filter === k ? MARINE : TEXT_MUTED, boxShadow: filter === k ? "0 1px 2px rgba(0,0,0,0.06)" : "none" }}
            >
              {l} ({counts[k]})
            </button>
          ))}
        </div>
        <button type="button" className="ghost" onClick={() => { setLoading(true); laden(); }}>
          <RefreshCw size={14} /> Aktualisieren
        </button>
      </div>

      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px" }}>{fehler}</div>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
        <div style={{ flex: "999 1 760px", minWidth: 0, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
            <thead>
              <tr>
                <th style={th}>Eingang</th><th style={th}>Fahrer</th><th style={th}>LKW</th><th style={th}>Auftrags-Nr.</th>
                <th style={th}>Container</th><th style={th}>Kunde</th><th style={th}>Auslesung</th><th style={{ ...th, textAlign: "right" }}>Aktion</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={8} style={{ ...td, color: TEXT_MUTED, textAlign: "center", padding: 28 }}>Lade …</td></tr>
              )}
              {!loading && sichtbar.length === 0 && (
                <tr><td colSpan={8} style={{ ...td, color: TEXT_MUTED, textAlign: "center", padding: 28 }}>
                  {filter === "neu" ? "Keine neuen Frachtbriefe. Sobald ein Fahrer etwas scannt, erscheint es hier." : "Keine Einträge."}
                </td></tr>
              )}
              {sichtbar.map((r) => {
                const e = r.extraktion || {};
                const lkw = e.lkw || r.lkw || "";
                const tour = r.tour_id ? tourById.get(r.tour_id) : null;
                const aktiv = auswahl?.id === r.id;
                return (
                  <tr key={r.id} onClick={() => zeigen(r)} style={{ cursor: "pointer", background: aktiv ? "#FFF7EC" : undefined }}>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {zeitText(r.created_at)}
                      <div style={{ fontSize: 11, color: TEXT_MUTED }}>{r.seiten} Seite{r.seiten > 1 ? "n" : ""}</div>
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>{r.fahrer}</td>
                    <td style={{ ...td, ...mono, whiteSpace: "nowrap" }}>{lkw || "–"}</td>
                    <td style={{ ...td, ...mono }}>{e.auftragsNr || "–"}</td>
                    <td style={{ ...td, ...mono, whiteSpace: "nowrap" }}>{e.containerNr || "–"}</td>
                    <td style={td}>{e.kunde || "–"}</td>
                    <td style={td}><AusleseChip row={r} /></td>
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }} onClick={(ev) => ev.stopPropagation()}>
                      {r.status === "neu" && (
                        <button type="button" className="primary" disabled={r.auslese_status === "laeuft" || busyId === r.id}
                          onClick={() => onTourAnlegen(r)} style={{ padding: "6px 12px", fontSize: 12.5 }}>
                          <PlusCircle size={13} /> Tour anlegen
                        </button>
                      )}
                      {r.status === "erledigt" && (
                        <span style={{ fontSize: 12, color: SUCCESS, fontWeight: 600 }}>
                          {tour ? `Tour ${tour.auftragsNr || ""} angelegt` : "erledigt"}
                        </span>
                      )}
                      {r.status === "verworfen" && <span style={{ fontSize: 12, color: TEXT_MUTED }}>aussortiert</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {auswahl && (
        <div style={{ flex: "1 1 340px", minWidth: 0, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{auswahl.fahrer} · {zeitText(auswahl.created_at)}</div>
                <button type="button" className="ghost" aria-label="Vorschau schließen" onClick={() => { setAuswahl(null); setVorschauUrl(null); }} style={{ padding: "4px 6px" }}>
                  <X size={14} />
                </button>
              </div>
              <div style={{ height: 460, borderRadius: 8, background: BG, border: `1px solid ${BORDER}`, overflow: "hidden" }}>
                {vorschauUrl
                  ? <iframe title="Frachtbrief" src={vorschauUrl} style={{ width: "100%", height: "100%", border: 0 }} />
                  : <div style={{ padding: 30, textAlign: "center", color: TEXT_MUTED, fontSize: 13 }}>Lade Vorschau …</div>}
              </div>
              {auswahl.auslese_status === "fehler" && (
                <div style={{ fontSize: 12, color: DANGER }}>Auslesen fehlgeschlagen: {auswahl.auslese_fehler}</div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                <button type="button" className="ghost" onClick={() => oeffnen(auswahl)}><Eye size={13} /> PDF öffnen</button>
                <button type="button" className="ghost" disabled={busyId === auswahl.id} onClick={() => erneutAuslesen(auswahl)}>
                  {busyId === auswahl.id ? <Loader2 size={13} /> : <RotateCcw size={13} />} Erneut auslesen
                </button>
                {auswahl.status === "neu" ? (
                  <button type="button" className="ghost" disabled={busyId === auswahl.id} onClick={() => setStatus(auswahl, "verworfen")}
                    title="z. B. doppelt geschickt oder kein Frachtbrief">
                    <Archive size={13} /> Aussortieren
                  </button>
                ) : (
                  <button type="button" className="ghost" disabled={busyId === auswahl.id} onClick={() => setStatus(auswahl, "neu")}>
                    <RotateCcw size={13} /> Zurück zu „Neu“
                  </button>
                )}
              </div>
            </>
        </div>
        )}
      </div>
      {!auswahl && sichtbar.length > 0 && (
        <div style={{ fontSize: 12, color: TEXT_MUTED, marginTop: -10, display: "flex", alignItems: "center", gap: 6 }}>
          <FileText size={13} /> Zeile anklicken, um das Original-Foto zu sehen.
        </div>
      )}

      <FahrerZugaenge drivers={drivers} />
    </div>
  );
}

// ----------------------------------------------------- Fahrer-Zugänge ------
function FahrerZugaenge({ drivers }) {
  const [zugaenge, setZugaenge] = useState([]);
  const [pins, setPins] = useState({});
  const [meldung, setMeldung] = useState(null); // { ok, text }
  const [busy, setBusy] = useState(null);
  const [kopiert, setKopiert] = useState(false);

  async function laden() {
    const { data } = await supabase.rpc("fahrer_zugang_liste");
    setZugaenge(data || []);
  }
  useEffect(() => { laden(); }, []);

  async function pinSetzen(name) {
    const pin = (pins[name] || "").trim();
    if (!/^[0-9]{4,6}$/.test(pin)) { setMeldung({ ok: false, text: "PIN muss 4 bis 6 Ziffern haben." }); return; }
    setBusy(name);
    const { error } = await supabase.rpc("set_fahrer_pin", { p_fahrer: name, p_pin: pin });
    setBusy(null);
    if (error) { setMeldung({ ok: false, text: `PIN für ${name} konnte nicht gesetzt werden.` }); return; }
    setPins((p) => ({ ...p, [name]: "" }));
    setMeldung({ ok: true, text: `PIN für ${name} gespeichert. Ein vorher angemeldetes Handy muss sich neu anmelden.` });
    laden();
  }

  async function entziehen(name) {
    if (!window.confirm(`Zugang für ${name} entziehen? Das Handy wird sofort abgemeldet.`)) return;
    setBusy(name);
    const { error } = await supabase.rpc("fahrer_zugang_entziehen", { p_fahrer: name });
    setBusy(null);
    setMeldung(error ? { ok: false, text: "Entziehen fehlgeschlagen." } : { ok: true, text: `Zugang für ${name} entzogen.` });
    laden();
  }

  const anleitung =
    `Frachtbriefe bitte ab jetzt mit der Fahrer-App schicken statt per WhatsApp:\n` +
    `1. Diesen Link öffnen: ${FAHRER_APP_URL}\n` +
    `2. Deinen Namen antippen und deinen PIN eingeben (bekommst du vom Büro)\n` +
    `3. Auf den Startbildschirm legen: iPhone in Safari "Teilen" > "Zum Home-Bildschirm", Android "Installieren"\n` +
    `4. Frachtbrief scannen > Senden. Fertig.`;

  async function kopieren() {
    try { await navigator.clipboard.writeText(anleitung); setKopiert(true); setTimeout(() => setKopiert(false), 2500); } catch { /* egal */ }
  }

  const byName = new Map(zugaenge.map((z) => [z.fahrer, z]));
  const liste = drivers.filter((d) => d.name !== "Ersatzfahrer" || byName.has(d.name));

  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}><KeyRound size={16} /> Fahrer-Zugänge</div>
          <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginTop: 4, maxWidth: 560 }}>
            Jeder Fahrer meldet sich in der Fahrer-App mit seinem Namen und einem PIN (4–6 Ziffern) an. Fahrer sehen nur ihre eigenen gesendeten Frachtbriefe, keine Touren oder Beträge.
            Nach 5 falschen Versuchen ist der Zugang 15 Minuten gesperrt.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start", background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 11.5, color: TEXT_MUTED, display: "flex", alignItems: "center", gap: 6 }}><Smartphone size={13} /> Link für die Fahrer</div>
          <a href={FAHRER_APP_URL} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, color: MARINE }}>{FAHRER_APP_URL}</a>
          <button type="button" className="ghost" onClick={kopieren} style={{ padding: "5px 10px", fontSize: 12 }}>
            <Copy size={12} /> {kopiert ? "Kopiert!" : "Anleitung für WhatsApp kopieren"}
          </button>
        </div>
      </div>

      {meldung && (
        <div style={{ fontSize: 12.5, borderRadius: 8, padding: "8px 12px", background: meldung.ok ? "#E3F1E9" : DANGER_BG, color: meldung.ok ? SUCCESS : DANGER }}>{meldung.text}</div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
          <thead>
            <tr>
              {["Fahrer", "Zugang", "Neuer PIN", ""].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "8px 10px", fontSize: 11.5, fontWeight: 600, color: TEXT_MUTED, borderBottom: `1px solid ${BORDER}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {liste.map((d) => {
              const z = byName.get(d.name);
              const gesperrt = z?.gesperrt_bis && new Date(z.gesperrt_bis) > new Date();
              return (
                <tr key={d.id}>
                  <td style={{ padding: "8px 10px", fontSize: 13, fontWeight: 600, borderBottom: `1px solid ${BORDER}` }}>{d.name}</td>
                  <td style={{ padding: "8px 10px", fontSize: 12.5, borderBottom: `1px solid ${BORDER}` }}>
                    {!z && <span style={{ color: TEXT_MUTED }}>kein Zugang</span>}
                    {z && !gesperrt && <span style={{ color: SUCCESS, fontWeight: 600 }}>aktiv</span>}
                    {z && gesperrt && <span style={{ color: DANGER, fontWeight: 600 }}>gesperrt bis {new Date(z.gesperrt_bis).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</span>}
                  </td>
                  <td style={{ padding: "6px 10px", borderBottom: `1px solid ${BORDER}` }}>
                    <input
                      aria-label={`Neuer PIN für ${d.name}`} inputMode="numeric" maxLength={6} placeholder="PIN"
                      value={pins[d.name] || ""} onChange={(e) => setPins((p) => ({ ...p, [d.name]: e.target.value.replace(/\D/g, "") }))}
                      onKeyDown={(e) => { if (e.key === "Enter") pinSetzen(d.name); }}
                      style={{ width: 120, fontFamily: "ui-monospace, Menlo, monospace", letterSpacing: "0.15em" }}
                    />
                  </td>
                  <td style={{ padding: "6px 10px", borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap", textAlign: "right" }}>
                    <button type="button" className="primary" disabled={busy === d.name} onClick={() => pinSetzen(d.name)} style={{ padding: "5px 12px", fontSize: 12.5 }}>
                      {z ? "PIN ändern" : "PIN setzen"}
                    </button>
                    {z && (
                      <button type="button" className="ghost" disabled={busy === d.name} onClick={() => entziehen(d.name)} style={{ padding: "5px 10px", fontSize: 12.5, marginLeft: 6, color: DANGER }}>
                        Entziehen
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11.5, color: TEXT_MUTED }}>
        Tipp: PIN dem Fahrer persönlich oder per Telefon sagen, nicht in die Gruppe schreiben.
      </div>
    </div>
  );
}
