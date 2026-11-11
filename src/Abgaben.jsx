// Fuhrpark-Reiter "Versicherung & Steuer": Kfz-Versicherung (vierteljährlich)
// und Kfz-Steuer (jährlich, mit Häkchen Anhängerzuschlag) je Fahrzeug.
// Jede Zahlung hat einen Zeitraum von-bis; "Folgezahlung" legt den nächsten
// Zeitraum direkt im Anschluss mit gleichem Betrag an (Betrag danach anpassbar).
// Die Fuhrpark-Übersicht verteilt die Beträge tagesgenau über den Zeitraum.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, RefreshCw, CalendarPlus, AlertTriangle } from "lucide-react";
import * as adb from "./abgabenDb";
import * as ldb from "./leasingDb";

const MARINE = "#0F2A43";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT = "#16232E";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const AMBER_DARK = "#8A5A10";
const WARN_BG = "#FDF1DD";
const SUCCESS = "#2F8F6B";

const card = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 20 };
const h2 = { fontSize: 15, fontWeight: 600, marginBottom: 4, color: TEXT };
const right = { textAlign: "right" };
const pad2 = (n) => String(n).padStart(2, "0");
const heuteIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const dmy = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const euro = (n) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }) : "–");
const fmt = (n) => (n === null || n === undefined ? "" : n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function parseBetrag(s) {
  const t = String(s || "").trim().replace(/€/g, "").replace(/\s/g, "");
  if (!t) return null;
  let n;
  if (t.includes(",")) n = Number(t.replace(/\./g, "").replace(",", "."));
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) n = Number(t.replace(/\./g, ""));
  else n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function Sektion({ art, kennzeichen, alle, jahr, onChange, setFehler }) {
  const cfg = adb.ARTEN[art];
  const steuer = art === "steuer";
  const liste = useMemo(() => alle.filter((x) => x.art === art), [alle, art]);
  const leer = { kennzeichen: "", von: "", bis: "", betrag: "", anhaengerzuschlag: false, gesellschaft: "", vertragNr: "" };
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const jStart = `${jahr}-01-01`, jEnde = `${jahr}-12-31`;
  const heute = heuteIso();

  const proLkw = useMemo(() => {
    const kosten = adb.abgabenJeLkw(liste, jStart, jEnde);
    return kennzeichen.map((kz) => {
      const z = liste.filter((x) => x.kennzeichen === kz).sort((a, b) => a.bis.localeCompare(b.bis));
      const letzte = z[z.length - 1];
      return { kz, letzte, anzahl: z.length, imJahr: kosten[kz]?.[art] || 0 };
    });
  }, [liste, kennzeichen, jahr]);

  const imJahr = liste.filter((x) => x.von <= jEnde && x.bis >= jStart).sort((a, b) => a.kennzeichen.localeCompare(b.kennzeichen) || a.von.localeCompare(b.von));

  async function folgezahlung(p) {
    if (!p.letzte) {
      setForm({ ...leer, kennzeichen: p.kz, von: `${jahr}-01-01`, bis: adb.periodenEnde(`${jahr}-01-01`, cfg.monate) });
      return;
    }
    const von = adb.plusTage(p.letzte.bis, 1);
    setBusy(true);
    try {
      await adb.addAbgabe({
        kennzeichen: p.kz, art, von, bis: adb.periodenEnde(von, cfg.monate), betrag: p.letzte.betrag,
        anhaengerzuschlag: p.letzte.anhaengerzuschlag, gesellschaft: p.letzte.gesellschaft, vertragNr: p.letzte.vertragNr,
      });
      onChange();
    } catch (e) { setFehler(e.message); }
    setBusy(false);
  }

  async function anlegen() {
    const betrag = parseBetrag(form.betrag);
    if (!form.kennzeichen || !form.von || !form.bis || betrag === null || Number.isNaN(betrag)) {
      setFehler("Bitte Fahrzeug, Zeitraum und Betrag angeben.");
      return;
    }
    if (form.bis < form.von) { setFehler("„bis“ liegt vor „von“."); return; }
    setBusy(true);
    try {
      await adb.addAbgabe({ ...form, art, betrag, gesellschaft: form.gesellschaft.trim(), vertragNr: form.vertragNr.trim() });
      setForm(null);
      onChange();
    } catch (e) { setFehler(e.message); }
    setBusy(false);
  }

  async function aendern(x, patch) {
    try { await adb.updateAbgabe(x.id, patch); onChange(); } catch (e) { setFehler(e.message); }
  }
  async function loeschen(x) {
    if (!window.confirm(`${cfg.label} ${x.kennzeichen} ${dmy(x.von)}–${dmy(x.bis)} (${euro(x.betrag)}) löschen?`)) return;
    try { await adb.deleteAbgabe(x.id); onChange(); } catch (e) { setFehler(e.message); }
  }

  const summeJahr = proLkw.reduce((s, p) => s + p.imJahr, 0);

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <div>
          <div style={h2}>{cfg.label}</div>
          <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 12 }}>
            Zahlungsweise {cfg.zahlweise} · „Folgezahlung“ legt den nächsten Zeitraum ({cfg.monate} Monate) direkt im Anschluss mit gleichem Betrag an – Betrag danach bei Bedarf ändern.
          </div>
        </div>
        <button className="ghost" onClick={() => setForm(form ? null : { ...leer, von: `${jahr}-01-01`, bis: adb.periodenEnde(`${jahr}-01-01`, cfg.monate) })}><Plus size={14} /> Zahlung erfassen</button>
      </div>

      {form && (
        <div style={{ background: "#F7F9FB", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, marginBottom: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label>Fahrzeug</label>
            <select value={form.kennzeichen} onChange={(e) => setForm({ ...form, kennzeichen: e.target.value })} style={{ width: 130 }}>
              <option value="">– wählen –</option>
              {kennzeichen.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label>von</label>
            <input type="date" value={form.von} onChange={(e) => setForm({ ...form, von: e.target.value, bis: e.target.value ? adb.periodenEnde(e.target.value, cfg.monate) : form.bis })} style={{ width: 145 }} />
          </div>
          <div>
            <label>bis</label>
            <input type="date" value={form.bis} onChange={(e) => setForm({ ...form, bis: e.target.value })} style={{ width: 145 }} />
          </div>
          <div>
            <label>Betrag</label>
            <input className="mono" inputMode="decimal" placeholder="0,00" value={form.betrag} onChange={(e) => setForm({ ...form, betrag: e.target.value })} style={{ width: 110, textAlign: "right" }} />
          </div>
          {steuer && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 8px", fontSize: 13, color: TEXT }}>
              <input type="checkbox" checked={form.anhaengerzuschlag} onChange={(e) => setForm({ ...form, anhaengerzuschlag: e.target.checked })} style={{ width: "auto" }} /> Anhängerzuschlag
            </label>
          )}
          <div>
            <label>{cfg.gesellschaft}</label>
            <input value={form.gesellschaft} onChange={(e) => setForm({ ...form, gesellschaft: e.target.value })} style={{ width: 160 }} />
          </div>
          <div>
            <label>{cfg.nr}</label>
            <input value={form.vertragNr} onChange={(e) => setForm({ ...form, vertragNr: e.target.value })} style={{ width: 160 }} />
          </div>
          <button className="primary" onClick={anlegen} disabled={busy}>{busy ? <Loader2 size={14} /> : <Plus size={14} />} Speichern</button>
          <button className="ghost" onClick={() => setForm(null)}>Abbrechen</button>
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Fahrzeug</th>{steuer && <th>Anhänger&shy;zuschlag</th>}<th>{cfg.gesellschaft}</th>
              <th>Letzter Zeitraum</th><th style={right}>Letzter Betrag</th><th>bezahlt bis</th><th style={right}>Kosten {jahr}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {proLkw.map((p) => {
              const l = p.letzte;
              const ueberfaellig = l && l.bis < heute;
              const bald = l && !ueberfaellig && l.bis < adb.plusTage(heute, 30);
              return (
                <tr key={p.kz}>
                  <td className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{p.kz}</td>
                  {steuer && (
                    <td style={{ textAlign: "center" }}>
                      {l ? (
                        <input type="checkbox" checked={l.anhaengerzuschlag} title="Anhängerzuschlag (gilt für die letzte Zahlung, wird in Folgezahlungen übernommen)"
                          onChange={(e) => aendern(l, { anhaengerzuschlag: e.target.checked })} style={{ width: "auto" }} />
                      ) : "–"}
                    </td>
                  )}
                  <td style={{ fontSize: 12.5 }}>{l?.gesellschaft || <span style={{ color: TEXT_MUTED }}>–</span>}</td>
                  <td className="mono" style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>{l ? `${dmy(l.von)} – ${dmy(l.bis)}` : <span style={{ color: TEXT_MUTED }}>noch nichts erfasst</span>}</td>
                  <td className="mono" style={right}>{l ? euro(l.betrag) : "–"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {l && (
                      <span className="mono" style={{ fontSize: 12, padding: "2px 7px", borderRadius: 8, background: ueberfaellig ? DANGER_BG : bald ? WARN_BG : "transparent", color: ueberfaellig ? DANGER : bald ? AMBER_DARK : SUCCESS }}>
                        {ueberfaellig && <AlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 3 }} />}{dmy(l.bis)}
                      </span>
                    )}
                  </td>
                  <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE }}>{p.imJahr ? euro(p.imJahr) : "–"}</td>
                  <td>
                    <button className="ghost" disabled={busy} onClick={() => folgezahlung(p)} style={{ padding: "4px 9px", whiteSpace: "nowrap" }}
                      title={l ? `Neuer Zeitraum ab ${dmy(adb.plusTage(l.bis, 1))} mit ${euro(l.betrag)}` : "Erste Zahlung erfassen"}>
                      <CalendarPlus size={13} /> {l ? "Folgezahlung" : "Erfassen"}
                    </button>
                  </td>
                </tr>
              );
            })}
            <tr style={{ borderTop: `2px solid ${BORDER}` }}>
              <td style={{ fontWeight: 600 }} colSpan={steuer ? 6 : 5}>Summe {jahr} (anteilig nach Tagen)</td>
              <td className="mono" style={{ ...right, fontWeight: 700, color: MARINE }}>{euro(summeJahr)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>

      <details style={{ marginTop: 14 }}>
        <summary style={{ cursor: "pointer", fontSize: 13, color: MARINE, fontWeight: 500 }}>Zahlungen {jahr} ({imJahr.length}) bearbeiten</summary>
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>Fahrzeug</th><th>von</th><th>bis</th><th style={right}>Betrag</th>{steuer && <th>Anh.-Zuschlag</th>}
                <th>{cfg.gesellschaft}</th><th>{cfg.nr}</th><th>Bemerkung</th><th></th>
              </tr>
            </thead>
            <tbody>
              {imJahr.map((x) => (
                <tr key={x.id}>
                  <td className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{x.kennzeichen}</td>
                  <td><input type="date" value={x.von} onChange={(e) => e.target.value && aendern(x, { von: e.target.value })} style={{ width: 140 }} /></td>
                  <td><input type="date" value={x.bis} onChange={(e) => e.target.value && aendern(x, { bis: e.target.value })} style={{ width: 140 }} /></td>
                  <td>
                    <input className="mono" inputMode="decimal" key={`b-${x.id}-${x.betrag}`} defaultValue={fmt(x.betrag)} style={{ width: 105, textAlign: "right" }}
                      onBlur={(e) => {
                        const v = parseBetrag(e.target.value);
                        if (v === null || Number.isNaN(v)) { setFehler(`„${e.target.value}“ ist kein Betrag`); return; }
                        if (v !== x.betrag) aendern(x, { betrag: v });
                      }} />
                  </td>
                  {steuer && <td style={{ textAlign: "center" }}><input type="checkbox" checked={x.anhaengerzuschlag} onChange={(e) => aendern(x, { anhaengerzuschlag: e.target.checked })} style={{ width: "auto" }} /></td>}
                  {["gesellschaft", "vertragNr", "bemerkung"].map((feld) => (
                    <td key={feld}>
                      <input key={`${feld}-${x.id}-${x[feld]}`} defaultValue={x[feld]} style={{ minWidth: 130 }}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v !== x[feld]) aendern(x, { [feld]: v }); }} />
                    </td>
                  ))}
                  <td><button className="ghost" onClick={() => loeschen(x)} style={{ padding: "4px 8px" }}><Trash2 size={13} /></button></td>
                </tr>
              ))}
              {imJahr.length === 0 && <tr><td colSpan={steuer ? 9 : 8} style={{ color: TEXT_MUTED }}>Für {jahr} noch keine Zahlungen erfasst.</td></tr>}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export default function Abgaben({ fleet }) {
  const [jahr, setJahr] = useState(new Date().getFullYear());
  const [alle, setAlle] = useState([]);
  const [extra, setExtra] = useState([]);
  const [miete, setMiete] = useState([]); // Kennzeichen mit Art "Miete" - Versicherung/Steuer laufen über die Miete
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");

  async function neuLaden() {
    setFehler("");
    try {
      const [a, lf] = await Promise.all([adb.fetchAbgaben(), ldb.fetchFahrzeuge().catch(() => [])]);
      setAlle(a);
      setExtra(lf.filter((f) => f.art !== "Miete").map((f) => f.kennzeichen));
      setMiete(lf.filter((f) => f.art === "Miete").map((f) => f.kennzeichen));
    } catch (e) {
      setFehler("Versicherung & Steuer konnte nicht geladen werden: " + (e.message || e));
    }
    setLaden(false);
  }
  useEffect(() => { neuLaden(); }, []);

  // Fuhrpark + Leasing-/Eigentumsfahrzeuge + alles, wofür schon Zahlungen da sind.
  // Miet-LKW (Art "Miete" unter Leasing/Miete) nicht - Versicherung und Steuer
  // sind dort in der Miete enthalten; nur falls doch Zahlungen erfasst sind, bleiben sie sichtbar.
  const kennzeichen = useMemo(() => {
    const mitZahlung = new Set(alle.map((x) => x.kennzeichen));
    const fp = (fleet || []).map((f) => f.plate).filter((k) => !miete.includes(k) || mitZahlung.has(k));
    const rest = Array.from(new Set([...extra, ...mitZahlung])).filter((k) => !fp.includes(k) && (!miete.includes(k) || mitZahlung.has(k))).sort();
    return [...fp, ...rest];
  }, [fleet, extra, miete, alle]);
  const jahre = useMemo(() => {
    const s = new Set(alle.flatMap((x) => [Number(x.von.slice(0, 4)), Number(x.bis.slice(0, 4))]));
    for (let j = 2026; j <= new Date().getFullYear() + 1; j++) s.add(j);
    return Array.from(s).sort((a, b) => b - a);
  }, [alle]);

  if (laden) return <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Versicherung & Steuer …</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <label style={{ margin: 0 }}>Jahr</label>
        <select value={jahr} onChange={(e) => setJahr(Number(e.target.value))} style={{ width: 100 }}>
          {jahre.map((j) => <option key={j} value={j}>{j}</option>)}
        </select>
        <button className="ghost" onClick={neuLaden}><RefreshCw size={14} /></button>
      </div>
      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}
      <Sektion art="versicherung" kennzeichen={kennzeichen} alle={alle} jahr={jahr} onChange={neuLaden} setFehler={setFehler} />
      <Sektion art="steuer" kennzeichen={kennzeichen} alle={alle} jahr={jahr} onChange={neuLaden} setFehler={setFehler} />
    </div>
  );
}
