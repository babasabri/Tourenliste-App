// Tab "Ersatzteile": Rechnungen/Gutschriften der Teilelieferanten (zuerst
// Winkler) als PDF hochladen, jede Position einem LKW (oder "Lager")
// zuordnen und die Kosten je LKW und Kategorie auswerten.
//
// - Das Fahrzeug hängt an der POSITION, nicht am Beleg (ein Winkler-Beleg
//   kann Lieferscheine für mehrere LKW enthalten).
// - Steht auf dem Beleg kein/kein eindeutiges Kennzeichen, bleibt die Position
//   offen und wird hier per Auswahlliste zugeordnet.
// - Eine Position kann auf mehrere LKW aufgeteilt werden (z. B. 6 Muffen für
//   3 LKW); Beträge anteilig nach Menge, Summe bleibt exakt gleich.
// - Gutschriften sind negativ gespeichert, Summen verrechnen sie automatisch.

import { useEffect, useMemo, useState } from "react";
import { Upload, Loader2, Trash2, RefreshCw, CheckCircle2, AlertTriangle, Scissors, X, Plus } from "lucide-react";
import { parseWinklerPdf, KATEGORIEN } from "./winklerParser";
import * as edb from "./ersatzteilDb";

const MARINE = "#0F2A43";
const AMBER_DARK = "#8A5A10";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT = "#16232E";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS = "#2F8F6B";
const SUCCESS_BG = "#E7F6EF";
const WARN_BG = "#FDF1DD";
const GS_BG = "#FCEFEA";

const LAGER = "Lager";
const OFFEN = "__offen__";
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const GRUND_LABEL = { "Altteilpfand zurück": "Pfand zurück", Kulanz: "Kulanz", "Rückgabe/Reklamation": "Rückgabe/Reklamation" };

const pad2 = (n) => String(n).padStart(2, "0");
const dmy = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const euro = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "–" : n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }));
const mengeTxt = (n) => (n === null || n === undefined ? "" : n.toLocaleString("de-DE", { maximumFractionDigits: 3 }));
const r2 = (n) => Math.round(n * 100) / 100;

function zeitraum(f) {
  if (f.jahr === "ALLE") return { start: f.von || null, ende: f.bis || null };
  const j = Number(f.jahr);
  let start = `${j}-01-01`, ende = `${j}-12-31`;
  if (f.monat !== "ALLE") {
    const m = Number(f.monat);
    start = `${j}-${pad2(m)}-01`;
    ende = `${j}-${pad2(m)}-${pad2(new Date(j, m, 0).getDate())}`;
  }
  if (f.von && f.von > start) start = f.von;
  if (f.bis && f.bis < ende) ende = f.bis;
  return { start, ende };
}

function Kpi({ label, value, sub, warn }) {
  return (
    <div style={{ background: warn ? WARN_BG : CARD, border: `1px solid ${warn ? "#EBCB8B" : BORDER}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: warn ? AMBER_DARK : TEXT_MUTED, fontWeight: 500 }}>{label}</div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 600, color: warn ? AMBER_DARK : MARINE, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: warn ? AMBER_DARK : TEXT_MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function BelegBadge({ art }) {
  const gs = art === "gutschrift";
  return (
    <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 10, whiteSpace: "nowrap", background: gs ? "#F7D9CF" : "#E4ECF5", color: gs ? DANGER : MARINE }}>
      {gs ? "Gutschrift" : "Rechnung"}
    </span>
  );
}

const card = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 20 };
const h2 = { fontSize: 15, fontWeight: 600, marginBottom: 12, color: TEXT };
const right = { textAlign: "right" };

// ---------------------------------------------------------------- Aufteilen
function AufteilenDialog({ pos, lkwOptionen, onClose, onSaved }) {
  const gesamt = pos.menge || 0;
  const start = gesamt >= 2 && Number.isInteger(gesamt / 2) ? gesamt / 2 : 1;
  const [teile, setTeile] = useState([
    { lkw: pos.lkw || "", menge: start },
    { lkw: "", menge: Math.max(gesamt - start, 0) },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const summeMenge = teile.reduce((s, t) => s + (Number(t.menge) || 0), 0);
  const mengeOk = Math.abs(summeMenge - gesamt) < 1e-9;
  const alleLkw = teile.every((t) => t.lkw);
  const anteile = useMemo(() => {
    let rest = pos.netto;
    return teile.map((t, i) => {
      if (i === teile.length - 1) return r2(rest);
      const a = summeMenge > 0 ? r2((pos.netto * (Number(t.menge) || 0)) / summeMenge) : 0;
      rest -= a;
      return a;
    });
  }, [teile, pos.netto, summeMenge]);

  async function speichern() {
    setBusy(true);
    setErr("");
    try {
      await edb.aufteilen(pos.id, teile.map((t) => ({ lkw: t.lkw === LAGER ? LAGER : t.lkw, menge: Number(t.menge) })));
      onSaved();
    } catch (e) {
      setErr(e.message || String(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,42,67,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }} onClick={onClose}>
      <div style={{ ...card, marginBottom: 0, width: "100%", maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ ...h2, marginBottom: 0 }}>Position auf mehrere LKW aufteilen</div>
          <button className="ghost" onClick={onClose} style={{ padding: "4px 8px" }}><X size={15} /></button>
        </div>
        <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 14 }}>
          Beleg {pos.belegNr} Pos. {pos.pos}: <b style={{ color: TEXT }}>{pos.bezeichnung}</b> – {mengeTxt(gesamt)} {pos.einheit}, {euro(pos.netto)} netto.
          Der Betrag wird nach Menge aufgeteilt, der Rundungsrest landet beim letzten Teil.
        </div>
        <table>
          <thead><tr><th>LKW</th><th style={right}>Menge</th><th style={right}>Netto</th><th></th></tr></thead>
          <tbody>
            {teile.map((t, i) => (
              <tr key={i}>
                <td>
                  <select value={t.lkw} onChange={(e) => setTeile(teile.map((x, j) => (j === i ? { ...x, lkw: e.target.value } : x)))}>
                    <option value="">– wählen –</option>
                    {lkwOptionen.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
                <td style={right}>
                  <input type="number" min="0" step="any" value={t.menge} style={{ width: 90, textAlign: "right" }}
                    onChange={(e) => setTeile(teile.map((x, j) => (j === i ? { ...x, menge: e.target.value } : x)))} />
                </td>
                <td className="mono" style={right}>{euro(anteile[i])}</td>
                <td>
                  {teile.length > 2 && (
                    <button className="ghost" style={{ padding: "4px 8px" }} onClick={() => setTeile(teile.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="ghost" style={{ marginTop: 8 }} onClick={() => setTeile([...teile, { lkw: "", menge: 0 }])}><Plus size={14} /> weiteren LKW</button>
        {!mengeOk && <div style={{ fontSize: 12, color: DANGER, marginTop: 10 }}>Die Teilmengen ergeben {mengeTxt(summeMenge)} – sie müssen zusammen {mengeTxt(gesamt)} ergeben.</div>}
        {err && <div style={{ fontSize: 12, color: DANGER, marginTop: 10 }}>{err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button className="primary" disabled={!mengeOk || !alleLkw || busy} onClick={speichern}>
            {busy ? <Loader2 size={15} /> : <Scissors size={15} />} Aufteilen
          </button>
          <button className="ghost" onClick={onClose} disabled={busy}>Abbrechen</button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- Seite
export default function Ersatzteile({ fleet, startFilter, onFilterChange }) {
  const fleetPlates = useMemo(() => (fleet || []).map((f) => f.plate), [fleet]);
  const lkwOptionen = useMemo(() => [...fleetPlates, LAGER], [fleetPlates]);
  const [daten, setDaten] = useState([]);
  const [belege, setBelege] = useState([]);
  const [finMap, setFinMap] = useState({});
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");
  const heute = new Date();
  const leerFilter = { jahr: String(heute.getFullYear()), monat: "ALLE", lkw: "ALLE", kategorie: "ALLE", lieferant: "ALLE", art: "ALLE", suche: "", von: "", bis: "" };
  const [f, setF] = useState({ ...leerFilter, ...(startFilter || {}) });
  // Zeitraum/LKW an den Fuhrpark-Rahmen melden (gemeinsamer Filter der Reiter)
  useEffect(() => { onFilterChange && onFilterChange(f); }, [f.jahr, f.monat, f.lkw, f.von, f.bis]);

  const [vorschau, setVorschau] = useState([]);
  const [parsing, setParsing] = useState(false);
  const [importiere, setImportiere] = useState(false);
  const [meldung, setMeldung] = useState(null);
  const [zeigeBelege, setZeigeBelege] = useState(false);
  const [aufteilenPos, setAufteilenPos] = useState(null);
  const [speichert, setSpeichert] = useState(null); // id der gerade gespeicherten Zeile

  async function neuLaden() {
    setLaden(true);
    setFehler("");
    try {
      const [d, b, fm] = await Promise.all([edb.fetchPositionen(), edb.fetchBelege(), edb.fetchFinMap()]);
      setDaten(d);
      setBelege(b);
      setFinMap(fm);
    } catch (e) {
      setFehler("Ersatzteile konnten nicht geladen werden: " + (e.message || e));
    }
    setLaden(false);
  }
  useEffect(() => { neuLaden(); }, []);

  // ------------------------------------------------------------ Upload --
  async function dateienGewaehlt(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    setParsing(true);
    setMeldung(null);
    const bekannte = new Set(belege.map((b) => `${b.lieferant}|${b.belegNr}`));
    const out = [];
    for (const file of files) {
      try {
        const parsed = await parseWinklerPdf(file, fleetPlates, finMap);
        const key = `${parsed.lieferant}|${parsed.belegNr}`;
        const doppelt = out.some((o) => o.parsed && `${o.parsed.lieferant}|${o.parsed.belegNr}` === key);
        out.push({ dateiname: file.name, parsed, schonDa: bekannte.has(key) || doppelt });
      } catch (err) {
        out.push({ dateiname: file.name, fehler: err.message || String(err) });
      }
    }
    out.sort((a, b) => String(a.parsed?.belegDatum || "").localeCompare(String(b.parsed?.belegDatum || "")));
    setVorschau(out);
    setParsing(false);
  }

  const importierbar = vorschau.filter((v) => v.parsed && !v.schonDa && !v.parsed.summenAbweichung);

  async function uebernehmen() {
    setImportiere(true);
    let n = 0, pos = 0, offen = 0;
    const fehlerListe = [];
    for (const v of importierbar) {
      try {
        pos += await edb.importBeleg(v.parsed);
        offen += v.parsed.positionen.filter((p) => !p.lkw).length;
        n++;
      } catch (err) {
        fehlerListe.push(`${v.parsed.belegNr}: ${err.message}`);
      }
    }
    setImportiere(false);
    setVorschau([]);
    setMeldung({
      ok: fehlerListe.length === 0,
      text: `${n} Beleg(e) mit ${pos} Positionen übernommen.` + (offen ? ` ${offen} Position(en) ohne Fahrzeug – bitte unten zuordnen (Filter LKW „Offen“).` : "") + (fehlerListe.length ? ` Fehler: ${fehlerListe.join("; ")}` : ""),
    });
    if (offen) setF((x) => ({ ...x, lkw: OFFEN }));
    neuLaden();
  }

  async function belegLoeschen(b) {
    if (!window.confirm(`${b.belegart === "gutschrift" ? "Gutschrift" : "Rechnung"} ${b.belegNr} mit allen Positionen löschen? Eigene Zuordnungen dieses Belegs gehen dabei verloren. (Kann danach erneut hochgeladen werden.)`)) return;
    try {
      await edb.deleteBeleg(b.id);
      neuLaden();
    } catch (err) {
      setFehler("Löschen fehlgeschlagen: " + (err.message || err));
    }
  }

  async function aendern(p, patch) {
    setSpeichert(p.id);
    try {
      await edb.updatePosition(p.id, patch);
      setDaten((d) => d.map((x) => (x.id === p.id ? { ...x, ...(patch.lkw !== undefined ? { lkw: patch.lkw, lkwQuelle: patch.lkw ? "manuell" : null } : {}), ...(patch.kategorie !== undefined ? { kategorie: patch.kategorie } : {}) } : x)));
    } catch (err) {
      setFehler("Speichern fehlgeschlagen: " + (err.message || err));
    }
    setSpeichert(null);
  }

  // -------------------------------------------------------- Auswertung --
  const jahre = useMemo(() => {
    const s = new Set(daten.map((t) => (t.datum || "").slice(0, 4)).filter(Boolean));
    s.add(String(heute.getFullYear()));
    return Array.from(s).sort().reverse();
  }, [daten]);
  const lieferanten = useMemo(() => Array.from(new Set(daten.map((t) => t.lieferant))).filter(Boolean).sort(), [daten]);

  const zr = useMemo(() => zeitraum(f), [f]);
  const imZeitraum = useMemo(
    () => daten.filter((t) => (!zr.start || t.datum >= zr.start) && (!zr.ende || t.datum <= zr.ende) && (f.lieferant === "ALLE" || t.lieferant === f.lieferant)),
    [daten, zr, f.lieferant]
  );
  const betrag = (t) => t.netto + t.pfand;

  const lkwZeilen = useMemo(() => {
    const andere = Array.from(new Set(imZeitraum.map((t) => t.lkw))).filter((p) => p && p !== LAGER && !fleetPlates.includes(p)).sort();
    const keys = [...fleetPlates, ...andere, LAGER, ""];
    return keys.map((k) => {
      const rows = imZeitraum.filter((t) => (t.lkw || "") === k);
      const proKat = Object.fromEntries(KATEGORIEN.map((kat) => [kat, rows.filter((t) => t.kategorie === kat).reduce((s, t) => s + betrag(t), 0)]));
      return { key: k, label: k === "" ? "Offen (ohne Zuordnung)" : k, anzahl: rows.length, proKat, gesamt: rows.reduce((s, t) => s + betrag(t), 0), gs: rows.filter((t) => t.belegart === "gutschrift").reduce((s, t) => s + betrag(t), 0) };
    }).filter((z) => z.anzahl > 0);
  }, [imZeitraum, fleetPlates]);

  const gesamt = useMemo(() => {
    const s = { summe: 0, gs: 0, offenN: 0, offenE: 0, kat: Object.fromEntries(KATEGORIEN.map((k) => [k, 0])), belege: new Set() };
    for (const t of imZeitraum) {
      if (f.lkw !== "ALLE" && (f.lkw === OFFEN ? !!t.lkw : t.lkw !== f.lkw)) continue;
      s.summe += betrag(t);
      s.kat[t.kategorie] = (s.kat[t.kategorie] || 0) + betrag(t);
      if (t.belegart === "gutschrift") s.gs += betrag(t);
      if (!t.lkw) { s.offenN++; s.offenE += betrag(t); }
      s.belege.add(t.belegId);
    }
    return s;
  }, [imZeitraum, f.lkw]);
  const offenGesamt = daten.filter((t) => !t.lkw).length;
  // Summenzeile/Anteil der LKW-Tabelle: immer über alle LKW (unabhängig vom LKW-Filter)
  const tabSumme = useMemo(() => {
    const s = { anzahl: 0, gesamt: 0, gs: 0, kat: Object.fromEntries(KATEGORIEN.map((k) => [k, 0])) };
    for (const z of lkwZeilen) {
      s.anzahl += z.anzahl; s.gesamt += z.gesamt; s.gs += z.gs;
      for (const k of KATEGORIEN) s.kat[k] += z.proKat[k] || 0;
    }
    return s;
  }, [lkwZeilen]);

  const liste = useMemo(() => {
    const q = f.suche.trim().toLowerCase();
    return imZeitraum
      .filter((t) => f.lkw === "ALLE" || (f.lkw === OFFEN ? !t.lkw : t.lkw === f.lkw))
      .filter((t) => f.kategorie === "ALLE" || t.kategorie === f.kategorie)
      .filter((t) => f.art === "ALLE" || t.belegart === f.art)
      .filter((t) => !q || `${t.bezeichnung} ${t.zusatz} ${t.artikelNr} ${t.belegNr} ${t.bestelldaten} ${t.lieferschein}`.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (b.datum || "").localeCompare(a.datum || "") || String(b.belegNr).localeCompare(String(a.belegNr)) || a.pos - b.pos || a.teil - b.teil);
  }, [imZeitraum, f]);
  const listeSumme = liste.reduce((s, t) => s + betrag(t), 0);
  const letzterBeleg = belege.reduce((m, b) => (b.datum > m ? b.datum : m), "");

  return (
    <div>
      {/* ---------------- Upload ---------------- */}
      <div style={{ ...card, maxWidth: 860 }}>
        <div style={h2}>Rechnungen & Gutschriften hochladen (Winkler)</div>
        <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 14 }}>
          Eine oder mehrere PDFs auf einmal auswählen. Die Positionen werden direkt aus dem Text gelesen (keine KI) und gegen „Summe Positionen“
          geprüft. Das Fahrzeug kommt aus den Bestell-Daten bzw. der Fahrgestellnummer auf dem Beleg – fehlt es, ordnest du die Position danach
          unten selbst zu. Schon importierte Belege werden erkannt und übersprungen.
          {letzterBeleg && <> Letzter erfasster Beleg: <b>{dmy(letzterBeleg)}</b>.</>}
        </div>
        <label className="ghost" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: parsing ? "wait" : "pointer", border: `1px solid ${BORDER}`, borderRadius: 6, padding: "7px 12px", fontSize: 13, color: TEXT, margin: 0, width: "auto" }}>
          <Upload size={15} /> PDFs auswählen
          <input type="file" accept="application/pdf,.pdf" multiple onChange={dateienGewaehlt} disabled={parsing || importiere} style={{ display: "none" }} />
        </label>
        {parsing && <div style={{ marginTop: 12, fontSize: 13, color: MARINE, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={15} /> Lese Belege aus …</div>}
        {meldung && (
          <div style={{ marginTop: 12, fontSize: 12.5, borderRadius: 8, padding: "10px 14px", background: meldung.ok ? SUCCESS_BG : DANGER_BG, color: meldung.ok ? SUCCESS : DANGER }}>{meldung.text}</div>
        )}

        {vorschau.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr><th>Datei</th><th>Art</th><th>Beleg</th><th>Datum</th><th style={right}>Pos.</th><th style={right}>Netto</th><th>Fahrzeuge</th><th>Prüfung</th></tr>
                </thead>
                <tbody>
                  {vorschau.map((v, i) => {
                    const p = v.parsed;
                    const lkws = p ? Array.from(new Set(p.positionen.map((x) => x.lkw).filter(Boolean))) : [];
                    const offen = p ? p.positionen.filter((x) => !x.lkw).length : 0;
                    let status;
                    if (v.fehler) status = <span style={{ color: DANGER }}>{v.fehler}</span>;
                    else if (v.schonDa) status = <span style={{ color: TEXT_MUTED }}>schon importiert – wird übersprungen</span>;
                    else if (p.summenAbweichung) status = <span style={{ color: DANGER }}><AlertTriangle size={13} /> Summe passt nicht ({euro(p.parsedSumme)} statt {euro(p.dokumentSumme)}) – wird nicht übernommen</span>;
                    else status = <span style={{ color: SUCCESS }}><CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> Summe stimmt</span>;
                    return (
                      <tr key={i} style={p?.belegart === "gutschrift" ? { background: GS_BG } : undefined}>
                        <td style={{ fontSize: 12 }}>{v.dateiname}</td>
                        <td>{p ? <BelegBadge art={p.belegart} /> : "–"}</td>
                        <td className="mono">{p?.belegNr || "–"}</td>
                        <td className="mono">{p ? dmy(p.belegDatum) : "–"}</td>
                        <td className="mono" style={right}>{p ? p.positionen.length : "–"}</td>
                        <td className="mono" style={right}>{p ? euro(p.netto) : "–"}</td>
                        <td style={{ fontSize: 12 }}>
                          {lkws.join(", ")}
                          {offen > 0 && <span style={{ color: AMBER_DARK }}>{lkws.length ? " · " : ""}{offen} offen</span>}
                        </td>
                        <td style={{ fontSize: 12.5 }}>{status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button className="primary" disabled={importierbar.length === 0 || importiere} onClick={uebernehmen}>
                {importiere ? <Loader2 size={15} /> : <CheckCircle2 size={15} />} {importierbar.length} Beleg(e) übernehmen
              </button>
              <button className="ghost" onClick={() => setVorschau([])} disabled={importiere}>Abbrechen</button>
            </div>
          </div>
        )}
      </div>

      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}

      {/* ---------------- Filter ---------------- */}
      <div style={{ ...card, padding: "14px 18px" }}>
        <div className="et-filter-grid" style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 10 }}>
          <div>
            <label>Jahr</label>
            <select value={f.jahr} onChange={(e) => setF({ ...f, jahr: e.target.value })}>
              <option value="ALLE">Alle</option>
              {jahre.map((j) => <option key={j} value={j}>{j}</option>)}
            </select>
          </div>
          <div>
            <label>Monat</label>
            <select value={f.monat} onChange={(e) => setF({ ...f, monat: e.target.value })} disabled={f.jahr === "ALLE"}>
              <option value="ALLE">Alle</option>
              {MONATE.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div>
            <label>LKW</label>
            <select value={f.lkw} onChange={(e) => setF({ ...f, lkw: e.target.value })}>
              <option value="ALLE">Alle</option>
              {lkwOptionen.map((p) => <option key={p} value={p}>{p}</option>)}
              <option value={OFFEN}>Offen (ohne Zuordnung)</option>
            </select>
          </div>
          <div>
            <label>Kategorie</label>
            <select value={f.kategorie} onChange={(e) => setF({ ...f, kategorie: e.target.value })}>
              <option value="ALLE">Alle</option>
              {KATEGORIEN.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label>Belegart</label>
            <select value={f.art} onChange={(e) => setF({ ...f, art: e.target.value })}>
              <option value="ALLE">Alle</option>
              <option value="rechnung">Rechnungen</option>
              <option value="gutschrift">Gutschriften</option>
            </select>
          </div>
          <div>
            <label>Lieferant</label>
            <select value={f.lieferant} onChange={(e) => setF({ ...f, lieferant: e.target.value })}>
              <option value="ALLE">Alle</option>
              {lieferanten.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div>
            <label>Datum von</label>
            <input type="date" value={f.von} onChange={(e) => setF({ ...f, von: e.target.value })} />
          </div>
          <div>
            <label>Datum bis</label>
            <input type="date" value={f.bis} onChange={(e) => setF({ ...f, bis: e.target.value })} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input placeholder="Suche: Bezeichnung, Artikel-Nr., Beleg …" value={f.suche} onChange={(e) => setF({ ...f, suche: e.target.value })} style={{ maxWidth: 320 }} />
          <button className="ghost" onClick={() => setF(leerFilter)}>Filter zurücksetzen</button>
          <button className="ghost" onClick={neuLaden} disabled={laden}><RefreshCw size={14} /> Neu laden</button>
          {offenGesamt > 0 && (
            <button className="ghost" style={{ color: AMBER_DARK, borderColor: "#EBCB8B", background: WARN_BG }} onClick={() => setF({ ...leerFilter, jahr: "ALLE", lkw: OFFEN })}>
              <AlertTriangle size={14} /> {offenGesamt} Position(en) ohne Fahrzeug
            </button>
          )}
        </div>
      </div>

      {laden ? (
        <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Ersatzteile …</div>
      ) : (
        <>
          {/* ---------------- Kennzahlen ---------------- */}
          <div className="et-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 20 }}>
            <Kpi label={f.lkw === "ALLE" ? "Kosten gesamt netto" : `Kosten netto · ${f.lkw === OFFEN ? "ohne Fahrzeug" : f.lkw}`} value={euro(gesamt.summe)} sub={`${gesamt.belege.size} Belege · Gutschriften verrechnet`} />
            <Kpi label="Ersatzteile" value={euro(gesamt.kat.Ersatzteil)} />
            <Kpi label="Ausrüstung" value={euro(gesamt.kat["Ausrüstung"])} sub="Feuerlöscher, ADR-Koffer, Handschuhe …" />
            <Kpi label="Werkstatt & Betriebsstoffe" value={euro((gesamt.kat.Werkstattbedarf || 0) + (gesamt.kat.Betriebsstoff || 0))} />
            <Kpi label="Gutschriften" value={euro(gesamt.gs)} sub="Rückgaben, Kulanz, Pfand" />
            <Kpi label="Ohne Fahrzeug" value={gesamt.offenN} sub={gesamt.offenN ? euro(gesamt.offenE) : "alles zugeordnet"} warn={gesamt.offenN > 0} />
          </div>

          {/* ---------------- Je LKW ---------------- */}
          <div style={card}>
            <div style={h2}>Kosten je LKW (netto)</div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>LKW</th><th style={right}>Positionen</th>
                    {KATEGORIEN.map((k) => <th key={k} style={right}>{k}</th>)}
                    <th style={right}>davon Gutschriften</th><th style={right}>Gesamt</th><th style={right}>Anteil</th>
                  </tr>
                </thead>
                <tbody>
                  {lkwZeilen.map((z) => (
                    <tr key={z.key || "offen"} onClick={() => setF({ ...f, lkw: z.key === "" ? OFFEN : z.key })} style={{ cursor: "pointer", ...(z.key === "" ? { background: WARN_BG } : {}) }} title="Klicken: Liste auf diesen LKW filtern">
                      <td className="mono" style={{ fontWeight: 600, color: z.key === "" ? AMBER_DARK : undefined }}>{z.label}</td>
                      <td className="mono" style={right}>{z.anzahl}</td>
                      {KATEGORIEN.map((k) => <td key={k} className="mono" style={right}>{z.proKat[k] ? euro(z.proKat[k]) : "–"}</td>)}
                      <td className="mono" style={{ ...right, color: z.gs ? DANGER : TEXT_MUTED }}>{z.gs ? euro(z.gs) : "–"}</td>
                      <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE }}>{euro(z.gesamt)}</td>
                      <td className="mono" style={{ ...right, color: TEXT_MUTED }}>{tabSumme.gesamt ? `${Math.round((z.gesamt / tabSumme.gesamt) * 100)} %` : "–"}</td>
                    </tr>
                  ))}
                  {lkwZeilen.length === 0 && <tr><td colSpan={KATEGORIEN.length + 5} style={{ color: TEXT_MUTED }}>Keine Ersatzteile im gewählten Zeitraum.</td></tr>}
                  {lkwZeilen.length > 0 && (
                    <tr style={{ borderTop: `2px solid ${BORDER}` }}>
                      <td style={{ fontWeight: 600 }}>Summe</td>
                      <td className="mono" style={right}>{tabSumme.anzahl}</td>
                      {KATEGORIEN.map((k) => <td key={k} className="mono" style={{ ...right, fontWeight: 600 }}>{euro(tabSumme.kat[k])}</td>)}
                      <td className="mono" style={{ ...right, color: DANGER }}>{euro(tabSumme.gs)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 700, color: MARINE }}>{euro(tabSumme.gesamt)}</td>
                      <td></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 10 }}>
              Beträge netto inkl. Altteilpfand; Gutschriften (Rückgaben, Kulanz, Pfand zurück) sind abgezogen. Zeile anklicken filtert die Liste unten.
            </div>
          </div>

          {/* ---------------- Liste ---------------- */}
          <div style={card}>
            <div style={{ ...h2, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span>Positionen ({liste.length}){f.lkw !== "ALLE" && ` · ${f.lkw === OFFEN ? "ohne Fahrzeug" : f.lkw}`}</span>
              <span className="mono" style={{ fontSize: 13, color: MARINE }}>{euro(listeSumme)} netto</span>
            </div>
            <div style={{ overflowX: "auto", maxHeight: 680, overflowY: "auto" }}>
              <table>
                <thead style={{ position: "sticky", top: 0, background: CARD, zIndex: 1 }}>
                  <tr>
                    <th>Datum</th><th>Beleg</th><th>LKW</th><th>Kategorie</th><th>Artikel-Nr.</th><th>Bezeichnung</th>
                    <th style={right}>Menge</th><th style={right}>Netto</th><th style={right}>Pfand</th><th>Hinweis</th>
                  </tr>
                </thead>
                <tbody>
                  {liste.map((t) => {
                    const gs = t.belegart === "gutschrift";
                    return (
                      <tr key={t.id} style={gs ? { background: GS_BG } : undefined}>
                        <td className="mono" style={{ whiteSpace: "nowrap" }}>{dmy(t.datum)}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <div className="mono" style={{ fontSize: 12.5 }}>{t.belegNr} <span style={{ color: TEXT_MUTED }}>/{t.pos}</span></div>
                          <div style={{ marginTop: 2 }}><BelegBadge art={t.belegart} /></div>
                        </td>
                        <td style={{ whiteSpace: "nowrap", minWidth: 160 }}>
                          <select value={t.lkw} disabled={speichert === t.id} onChange={(e) => aendern(t, { lkw: e.target.value })}
                            title={t.bestelldaten ? `Bestell-Daten auf dem Beleg: ${t.bestelldaten}` : "Auf dem Beleg stand kein Fahrzeug"}
                            style={{ width: 118, padding: "4px 6px", fontSize: 12.5, ...(t.lkw ? {} : { background: "#FFF6D6", borderColor: "#EBCB8B" }) }}>
                            <option value="">– offen –</option>
                            {lkwOptionen.map((p) => <option key={p} value={p}>{p}</option>)}
                            {t.lkw && !lkwOptionen.includes(t.lkw) && <option value={t.lkw}>{t.lkw}</option>}
                          </select>
                          {(t.menge || 0) > 1 && (
                            <button className="ghost" title="Auf mehrere LKW aufteilen" onClick={() => setAufteilenPos(t)} style={{ padding: "4px 7px", marginLeft: 4, verticalAlign: "middle" }}><Scissors size={13} /></button>
                          )}
                        </td>
                        <td>
                          <select value={t.kategorie} disabled={speichert === t.id} onChange={(e) => aendern(t, { kategorie: e.target.value })} style={{ width: 132, padding: "4px 6px", fontSize: 12.5 }}>
                            {KATEGORIEN.map((k) => <option key={k} value={k}>{k}</option>)}
                          </select>
                        </td>
                        <td className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{t.artikelNr}</td>
                        <td style={{ minWidth: 200 }}>
                          <div>{t.bezeichnung}</div>
                          {t.zusatz && <div style={{ fontSize: 11, color: TEXT_MUTED }}>{t.zusatz}</div>}
                        </td>
                        <td className="mono" style={{ ...right, whiteSpace: "nowrap" }}>{mengeTxt(t.menge)} {t.einheit}</td>
                        <td className="mono" style={{ ...right, fontWeight: 600, color: gs ? DANGER : TEXT }}>{euro(t.netto)}</td>
                        <td className="mono" style={{ ...right, color: TEXT_MUTED }}>{t.pfand ? euro(t.pfand) : ""}</td>
                        <td style={{ fontSize: 11.5, color: TEXT_MUTED, minWidth: 150 }}>
                          {t.grund && <div style={{ color: DANGER }}>{GRUND_LABEL[t.grund] || t.grund}{t.bezugBelegNr && <> zu {t.bezugBelegNr}/{t.bezugPos}</>}</div>}
                          {t.hinweis && <div>{t.hinweis}</div>}
                        </td>
                      </tr>
                    );
                  })}
                  {liste.length === 0 && <tr><td colSpan={10} style={{ color: TEXT_MUTED }}>Keine Einträge.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---------------- Importierte Belege ---------------- */}
          <div style={card}>
            <button className="ghost" onClick={() => setZeigeBelege(!zeigeBelege)}>
              {zeigeBelege ? "▾" : "▸"} Importierte Belege ({belege.length})
            </button>
            {zeigeBelege && (
              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table>
                  <thead><tr><th>Lieferant</th><th>Art</th><th>Beleg</th><th>Datum</th><th style={right}>Netto</th><th style={right}>Brutto</th><th>Datei</th><th>importiert</th><th></th></tr></thead>
                  <tbody>
                    {belege.map((b) => (
                      <tr key={b.id} style={b.belegart === "gutschrift" ? { background: GS_BG } : undefined}>
                        <td>{b.lieferant}</td>
                        <td><BelegBadge art={b.belegart} /></td>
                        <td className="mono">{b.belegNr}</td>
                        <td className="mono">{dmy(b.datum)}</td>
                        <td className="mono" style={right}>{euro(b.netto)}</td>
                        <td className="mono" style={right}>{euro(b.brutto)}</td>
                        <td style={{ fontSize: 12, color: TEXT_MUTED }}>{b.dateiname}</td>
                        <td className="mono" style={{ fontSize: 12, color: TEXT_MUTED }}>{b.importiertAm ? dmy(b.importiertAm.slice(0, 10)) : ""}</td>
                        <td><button className="ghost" title="Beleg löschen" onClick={() => belegLoeschen(b)} style={{ padding: "4px 8px" }}><Trash2 size={13} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {aufteilenPos && (
        <AufteilenDialog pos={aufteilenPos} lkwOptionen={lkwOptionen} onClose={() => setAufteilenPos(null)} onSaved={() => { setAufteilenPos(null); neuLaden(); }} />
      )}

      <style>{`
        @media (max-width: 820px) {
          .et-filter-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .et-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
        @media (min-width: 821px) and (max-width: 1250px) {
          .et-filter-grid { grid-template-columns: repeat(4, 1fr) !important; }
          .et-kpi-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}
