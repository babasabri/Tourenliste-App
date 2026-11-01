// Tab "Tankvorgänge": Tankpool-Rechnungen (PDF) hochladen, alle Tankvorgänge
// filtern und je LKW auswerten (Liter, Kosten, l/100 km, Kosten pro km).
//
// Gefahrene km kommen aus dem Einsatzplan (Wochen-KM aus routecontrol). Weil
// der Einsatzplan wochenweise rechnet, wird eine Woche, die nur teilweise im
// gewählten Zeitraum liegt, anteilig nach Tagen gezählt (z. B. 3 von 7 Tagen).
// l/100 km ist dadurch ein Näherungswert: getankt wird nicht genau dann, wenn
// die km gefahren werden - über einen Monat oder ein Jahr gleicht sich das aus.

import { useEffect, useMemo, useState } from "react";
import { Upload, Loader2, Trash2, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { parseTankpoolPdf } from "./tankpoolParser";
import * as tdb from "./tankDb";

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

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const KATEGORIE_LABEL = { diesel: "Diesel", adblue: "AdBlue", neben: "Nebenkosten" };

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dmy = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const euro = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "–" : n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }));
const liter = (n) => `${Math.round(n || 0).toLocaleString("de-DE")} L`;
const dez = (n, s = 2) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { minimumFractionDigits: s, maximumFractionDigits: s }) : "–");

function isoWeekMonday(jahr, kw) {
  const d = new Date(jahr, 0, 4);
  const dayNr = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayNr + (kw - 1) * 7);
  return d;
}

// Zeitraum aus den Filtern: Schnittmenge aus Jahr, Monat und von/bis.
function zeitraum(f) {
  let start = null, ende = null;
  const enger = (s, e) => {
    if (s && (!start || s > start)) start = s;
    if (e && (!ende || e < ende)) ende = e;
  };
  if (f.jahr !== "ALLE") {
    const j = Number(f.jahr);
    if (f.monat !== "ALLE") {
      const m = Number(f.monat);
      enger(`${j}-${pad2(m)}-01`, isoOf(new Date(j, m, 0)));
    } else enger(`${j}-01-01`, `${j}-12-31`);
  }
  if (f.von) enger(f.von, null);
  if (f.bis) enger(null, f.bis);
  return { start, ende };
}

// Mehr als 4.500 km in einer Woche schafft ein LKW nicht (Lenkzeiten) -
// solche Wochen und negative Werte sind Eingabefehler im Einsatzplan und
// werden nicht mitgezählt (sonst stimmt l/100 km nicht).
const MAX_WOCHEN_KM = 4500;
const unplausibel = (w) => w.wochenKm < 0 || w.wochenKm > MAX_WOCHEN_KM;

// km je LKW im Zeitraum, Wochen anteilig nach Tagen.
function kmJeLkw(wochen, { start, ende }) {
  const map = {};
  for (const w of wochen) {
    if (w.wochenKm === null || w.wochenKm === undefined || unplausibel(w)) continue;
    const mo = isoWeekMonday(w.jahr, w.kw);
    let tage = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(mo);
      d.setDate(mo.getDate() + i);
      const iso = isoOf(d);
      if ((!start || iso >= start) && (!ende || iso <= ende)) tage++;
    }
    if (tage > 0) map[w.lkw] = (map[w.lkw] || 0) + (w.wochenKm * tage) / 7;
  }
  return map;
}

function summiere(liste) {
  const s = { tankungen: 0, dieselL: 0, dieselE: 0, adblueL: 0, adblueE: 0, nebenE: 0, gesamt: 0 };
  for (const t of liste) {
    s.gesamt += t.wert;
    if (t.kategorie === "diesel") { s.dieselL += t.menge || 0; s.dieselE += t.wert; s.tankungen++; }
    else if (t.kategorie === "adblue") { s.adblueL += t.menge || 0; s.adblueE += t.wert; }
    else s.nebenE += t.wert;
  }
  return s;
}

function Kpi({ label, value, sub }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: TEXT_MUTED, fontWeight: 500 }}>{label}</div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 600, color: MARINE, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const card = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 20 };
const h2 = { fontSize: 15, fontWeight: 600, marginBottom: 12, color: TEXT };

export default function Tankvorgaenge({ fleet, wochenKm }) {
  const fleetPlates = useMemo(() => (fleet || []).map((f) => f.plate), [fleet]);
  const [daten, setDaten] = useState([]);
  const [rechnungen, setRechnungen] = useState([]);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");
  const heute = new Date();
  const [f, setF] = useState({ jahr: String(heute.getFullYear()), monat: "ALLE", lkw: "ALLE", kategorie: "ALLE", von: "", bis: "" });

  // Upload
  const [vorschau, setVorschau] = useState([]); // [{dateiname, ok, fehler, parsed, schonDa}]
  const [parsing, setParsing] = useState(false);
  const [importiere, setImportiere] = useState(false);
  const [meldung, setMeldung] = useState(null);
  const [zeigeRechnungen, setZeigeRechnungen] = useState(false);

  async function neuLaden() {
    setLaden(true);
    setFehler("");
    try {
      const [d, r] = await Promise.all([tdb.fetchTankvorgaenge(), tdb.fetchTankpoolRechnungen()]);
      setDaten(d);
      setRechnungen(r);
    } catch (e) {
      setFehler("Tankvorgänge konnten nicht geladen werden: " + (e.message || e));
    }
    setLaden(false);
  }
  useEffect(() => { neuLaden(); }, []);

  async function dateienGewaehlt(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    setParsing(true);
    setMeldung(null);
    const bekannte = new Set(rechnungen.map((r) => r.rechnungNr));
    const out = [];
    for (const file of files) {
      try {
        const parsed = await parseTankpoolPdf(file, fleetPlates);
        const doppelt = out.some((o) => o.parsed && o.parsed.rechnungNr === parsed.rechnungNr);
        out.push({ dateiname: file.name, parsed, schonDa: bekannte.has(parsed.rechnungNr) || doppelt });
      } catch (err) {
        out.push({ dateiname: file.name, fehler: err.message || String(err) });
      }
    }
    out.sort((a, b) => String(a.parsed?.rechnungDatum || "").localeCompare(String(b.parsed?.rechnungDatum || "")));
    setVorschau(out);
    setParsing(false);
  }

  const importierbar = vorschau.filter((v) => v.parsed && !v.schonDa && !v.parsed.summenAbweichung);

  async function uebernehmen() {
    setImportiere(true);
    let n = 0, pos = 0;
    const fehlerListe = [];
    for (const v of importierbar) {
      try {
        pos += await tdb.importTankpoolRechnung(v.parsed);
        n++;
      } catch (err) {
        fehlerListe.push(`${v.parsed.rechnungNr}: ${err.message}`);
      }
    }
    setImportiere(false);
    setVorschau([]);
    setMeldung({ ok: fehlerListe.length === 0, text: `${n} Rechnung(en) mit ${pos} Positionen übernommen.` + (fehlerListe.length ? ` Fehler: ${fehlerListe.join("; ")}` : "") });
    neuLaden();
  }

  async function rechnungLoeschen(nr) {
    if (!window.confirm(`Rechnung ${nr} mit allen Positionen löschen? (Kann danach erneut hochgeladen werden.)`)) return;
    try {
      await tdb.deleteTankpoolRechnung(nr);
      neuLaden();
    } catch (err) {
      setFehler("Löschen fehlgeschlagen: " + (err.message || err));
    }
  }

  // ---------------------------------------------------------- Auswertung --
  const jahre = useMemo(() => {
    const s = new Set(daten.map((t) => t.datum.slice(0, 4)));
    s.add(String(heute.getFullYear()));
    return Array.from(s).sort().reverse();
  }, [daten]);

  const lkwListe = useMemo(() => {
    const andere = Array.from(new Set(daten.map((t) => t.lkw))).filter((p) => !fleetPlates.includes(p)).sort();
    return [...fleetPlates, ...andere];
  }, [daten, fleetPlates]);

  const zr = useMemo(() => zeitraum(f), [f]);
  const imZeitraum = useMemo(
    () => daten.filter((t) => (!zr.start || t.datum >= zr.start) && (!zr.ende || t.datum <= zr.ende) && (f.lkw === "ALLE" || t.lkw === f.lkw)),
    [daten, zr, f.lkw]
  );
  // Tankdaten reichen nur bis zum Ende der letzten Sammelrechnung - km danach
  // dürfen nicht mitzählen, sonst wäre der Verbrauch zu niedrig.
  const abgedecktBis = useMemo(
    () => rechnungen.filter((r) => r.typ === "sammel").reduce((m, r) => (r.datum > m ? r.datum : m), ""),
    [rechnungen]
  );
  const kappe = (z) => ({ start: z.start, ende: abgedecktBis && (!z.ende || z.ende > abgedecktBis) ? abgedecktBis : z.ende });
  const km = useMemo(() => kmJeLkw(wochenKm || [], kappe(zr)), [wochenKm, zr, abgedecktBis]);
  // Unplausible Einsatzplan-Wochen im Zeitraum (zur Anzeige als Hinweis).
  const ausgelassen = useMemo(() => (wochenKm || []).filter((w) => {
    if (w.wochenKm === null || w.wochenKm === undefined || !unplausibel(w)) return false;
    if (f.lkw !== "ALLE" && w.lkw !== f.lkw) return false;
    const mo = isoOf(isoWeekMonday(w.jahr, w.kw));
    const so = isoOf(new Date(isoWeekMonday(w.jahr, w.kw).getTime() + 6 * 86400000));
    const z = kappe(zr);
    return (!z.ende || mo <= z.ende) && (!z.start || so >= z.start);
  }), [wochenKm, zr, f.lkw, abgedecktBis]);

  const gesamt = useMemo(() => summiere(imZeitraum), [imZeitraum]);
  // km nur für LKW zählen, für die es im Zeitraum auch Tankdaten gibt bzw. die
  // gefiltert sind - sonst würde ein LKW ohne Tankkarte den Schnitt verzerren.
  const lkwMitTank = new Set(imZeitraum.filter((t) => t.kategorie === "diesel").map((t) => t.lkw));
  const kmGesamt = Object.entries(km)
    .filter(([p]) => (f.lkw === "ALLE" ? lkwMitTank.has(p) : p === f.lkw))
    .reduce((s, [, v]) => s + v, 0);

  const proLkw = useMemo(() => {
    return lkwListe
      .map((p) => {
        const s = summiere(imZeitraum.filter((t) => t.lkw === p));
        return { lkw: p, ...s, km: km[p] || 0 };
      })
      .filter((r) => r.gesamt !== 0);
  }, [lkwListe, imZeitraum, km]);

  const proMonat = useMemo(() => {
    const map = {};
    for (const t of imZeitraum) {
      const k = t.datum.slice(0, 7);
      (map[k] = map[k] || []).push(t);
    }
    return Object.keys(map).sort().reverse().map((k) => {
      const [j, m] = k.split("-").map(Number);
      const mz = { start: `${k}-01`, ende: isoOf(new Date(j, m, 0)) };
      const kmM = kmJeLkw(wochenKm || [], kappe(mz));
      const s = summiere(map[k]);
      const tankLkw = new Set(map[k].filter((t) => t.kategorie === "diesel").map((t) => t.lkw));
      const kmSum = Object.entries(kmM).filter(([p]) => (f.lkw === "ALLE" ? tankLkw.has(p) : p === f.lkw)).reduce((a, [, v]) => a + v, 0);
      return { monat: `${MONATE[m - 1]} ${j}`, ...s, km: kmSum };
    });
  }, [imZeitraum, wochenKm, f.lkw, abgedecktBis]);

  const liste = useMemo(
    () => imZeitraum
      .filter((t) => f.kategorie === "ALLE" || t.kategorie === f.kategorie)
      .slice()
      .sort((a, b) => (b.datum + b.zeit).localeCompare(a.datum + a.zeit)),
    [imZeitraum, f.kategorie]
  );
  const listeSumme = liste.reduce((s, t) => s + t.wert, 0);
  const listeLiter = liste.filter((t) => t.einheit === "L").reduce((s, t) => s + (t.menge || 0), 0);

  const l100 = (l, k) => (k > 0 ? (l / k) * 100 : null);
  const proKm = (e, k) => (k > 0 ? e / k : null);
  const letzteTankung = daten.reduce((m, t) => (t.datum > m ? t.datum : m), "");

  return (
    <div>
      {/* ---------------- Upload ---------------- */}
      <div style={{ ...card, maxWidth: 820 }}>
        <div style={h2}>Tankpool-Rechnungen hochladen</div>
        <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 14 }}>
          Eine oder mehrere PDFs auf einmal auswählen. Die Positionen werden direkt aus dem Text gelesen (keine KI) und
          gegen die Rechnungssumme geprüft. Schon importierte Rechnungen werden erkannt und übersprungen.
          {letzteTankung && <> Letzte erfasste Tankung: <b>{dmy(letzteTankung)}</b>.</>}
        </div>
        <label className="ghost" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: parsing ? "wait" : "pointer", border: `1px solid ${BORDER}`, borderRadius: 6, padding: "7px 12px", fontSize: 13, color: TEXT, margin: 0, width: "auto" }}>
          <Upload size={15} /> PDFs auswählen
          <input type="file" accept="application/pdf,.pdf" multiple onChange={dateienGewaehlt} disabled={parsing || importiere} style={{ display: "none" }} />
        </label>
        {parsing && <div style={{ marginTop: 12, fontSize: 13, color: MARINE, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={15} /> Lese Rechnungen aus …</div>}
        {meldung && (
          <div style={{ marginTop: 12, fontSize: 12.5, borderRadius: 8, padding: "10px 14px", background: meldung.ok ? SUCCESS_BG : DANGER_BG, color: meldung.ok ? SUCCESS : DANGER }}>
            {meldung.text}
          </div>
        )}

        {vorschau.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr><th>Datei</th><th>Rechnung</th><th>Datum</th><th style={{ textAlign: "right" }}>Positionen</th><th style={{ textAlign: "right" }}>Summe netto</th><th>Prüfung</th></tr>
                </thead>
                <tbody>
                  {vorschau.map((v, i) => {
                    const p = v.parsed;
                    const fremd = p ? Array.from(new Set(p.positionen.map((x) => x.lkw))).filter((x) => !fleetPlates.includes(x)) : [];
                    let status;
                    if (v.fehler) status = <span style={{ color: DANGER }}>{v.fehler}</span>;
                    else if (v.schonDa) status = <span style={{ color: TEXT_MUTED }}>schon importiert – wird übersprungen</span>;
                    else if (p.summenAbweichung) status = <span style={{ color: DANGER }}><AlertTriangle size={13} /> Summe passt nicht ({euro(p.parsedSumme)} statt {euro(p.dokumentSumme)}) – wird nicht übernommen</span>;
                    else status = <span style={{ color: SUCCESS }}><CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> Summe stimmt{fremd.length > 0 && <span style={{ color: AMBER_DARK }}> · nicht im Fuhrpark: {fremd.join(", ")}</span>}</span>;
                    return (
                      <tr key={i}>
                        <td style={{ fontSize: 12 }}>{v.dateiname}</td>
                        <td className="mono">{p?.rechnungNr || "–"}</td>
                        <td className="mono">{p ? dmy(p.rechnungDatum) : "–"}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{p ? p.positionen.length : "–"}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{p ? euro(p.parsedSumme) : "–"}</td>
                        <td style={{ fontSize: 12.5 }}>{status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button className="primary" disabled={importierbar.length === 0 || importiere} onClick={uebernehmen}>
                {importiere ? <Loader2 size={15} /> : <CheckCircle2 size={15} />}
                {importierbar.length} Rechnung(en) übernehmen
              </button>
              <button className="ghost" onClick={() => setVorschau([])} disabled={importiere}>Abbrechen</button>
            </div>
          </div>
        )}
      </div>

      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}

      {/* ---------------- Filter ---------------- */}
      <div style={{ ...card, padding: "14px 18px" }}>
        <div className="tank-filter-grid" style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10 }}>
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
              {lkwListe.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label>Sorte (Liste)</label>
            <select value={f.kategorie} onChange={(e) => setF({ ...f, kategorie: e.target.value })}>
              <option value="ALLE">Alle</option>
              <option value="diesel">Diesel</option>
              <option value="adblue">AdBlue</option>
              <option value="neben">Nebenkosten</option>
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
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <button className="ghost" onClick={() => setF({ jahr: String(heute.getFullYear()), monat: "ALLE", lkw: "ALLE", kategorie: "ALLE", von: "", bis: "" })}>Filter zurücksetzen</button>
          <button className="ghost" onClick={neuLaden} disabled={laden}><RefreshCw size={14} /> Neu laden</button>
        </div>
      </div>

      {laden ? (
        <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Tankvorgänge …</div>
      ) : (
        <>
          {/* ---------------- Kennzahlen ---------------- */}
          <div className="tank-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 20 }}>
            <Kpi label="Diesel" value={liter(gesamt.dieselL)} sub={`${euro(gesamt.dieselE)} · ${gesamt.tankungen} Tankungen`} />
            <Kpi label="Ø Dieselpreis netto" value={gesamt.dieselL > 0 ? `${dez(gesamt.dieselE / gesamt.dieselL, 3)} €/L` : "–"} />
            <Kpi label="AdBlue" value={liter(gesamt.adblueL)} sub={euro(gesamt.adblueE)} />
            <Kpi label="Kosten gesamt netto" value={euro(gesamt.gesamt)} sub={gesamt.nebenE ? `davon Nebenkosten ${euro(gesamt.nebenE)}` : null} />
            <Kpi label="Ø Verbrauch" value={l100(gesamt.dieselL, kmGesamt) ? `${dez(l100(gesamt.dieselL, kmGesamt), 1)} l/100 km` : "–"} sub={kmGesamt > 0 ? `${Math.round(kmGesamt).toLocaleString("de-DE")} km laut Einsatzplan` : "keine km im Zeitraum"} />
            <Kpi label="Tankkosten pro km" value={proKm(gesamt.gesamt, kmGesamt) ? `${dez(proKm(gesamt.gesamt, kmGesamt), 3)} €/km` : "–"} sub="Diesel + AdBlue + Nebenkosten" />
          </div>

          {/* ---------------- Je LKW ---------------- */}
          <div style={card}>
            <div style={h2}>Auswertung je LKW</div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>LKW</th><th style={{ textAlign: "right" }}>Tankungen</th><th style={{ textAlign: "right" }}>Diesel</th><th style={{ textAlign: "right" }}>Diesel €</th>
                    <th style={{ textAlign: "right" }}>Ø €/L</th><th style={{ textAlign: "right" }}>AdBlue</th><th style={{ textAlign: "right" }}>AdBlue €</th>
                    <th style={{ textAlign: "right" }}>Nebenk. €</th><th style={{ textAlign: "right" }}>Gesamt €</th><th style={{ textAlign: "right" }}>km</th>
                    <th style={{ textAlign: "right" }}>l/100 km</th><th style={{ textAlign: "right" }}>€/km</th>
                  </tr>
                </thead>
                <tbody>
                  {proLkw.map((r) => (
                    <tr key={r.lkw}>
                      <td className="mono" style={{ fontWeight: 600 }}>
                        {r.lkw}
                        {!fleetPlates.includes(r.lkw) && <span style={{ fontSize: 10.5, color: TEXT_MUTED, fontWeight: 400, marginLeft: 6 }}>(nicht im Fuhrpark)</span>}
                      </td>
                      <td className="mono" style={{ textAlign: "right" }}>{r.tankungen}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{liter(r.dieselL)}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{euro(r.dieselE)}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{r.dieselL > 0 ? dez(r.dieselE / r.dieselL, 3) : "–"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{liter(r.adblueL)}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{euro(r.adblueE)}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{r.nebenE ? euro(r.nebenE) : "–"}</td>
                      <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{euro(r.gesamt)}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{r.km > 0 ? Math.round(r.km).toLocaleString("de-DE") : "–"}</td>
                      <td className="mono" style={{ textAlign: "right", fontWeight: 600, color: MARINE }}>{l100(r.dieselL, r.km) ? dez(l100(r.dieselL, r.km), 1) : "–"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{proKm(r.gesamt, r.km) ? dez(proKm(r.gesamt, r.km), 3) : "–"}</td>
                    </tr>
                  ))}
                  {proLkw.length === 0 && <tr><td colSpan={12} style={{ color: TEXT_MUTED }}>Keine Tankvorgänge im gewählten Zeitraum.</td></tr>}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 10 }}>
              km = Wochen-KM aus dem Einsatzplan (routecontrol); Wochen am Rand des Zeitraums zählen anteilig nach Tagen.
              {abgedecktBis && <> Tankrechnungen liegen bis <b>{dmy(abgedecktBis)}</b> vor – km danach werden nicht mitgezählt. </>}
              l/100 km ist deshalb ein Näherungswert – über Monate gerechnet aussagekräftiger als für einzelne Wochen.
            </div>
            {ausgelassen.length > 0 && (
              <div style={{ fontSize: 12, color: AMBER_DARK, background: WARN_BG, borderRadius: 8, padding: "8px 12px", marginTop: 10 }}>
                <AlertTriangle size={13} style={{ verticalAlign: -2 }} /> Nicht mitgezählt, weil die Wochen-KM im Einsatzplan unplausibel sind
                (negativ oder über {MAX_WOCHEN_KM.toLocaleString("de-DE")} km) – bitte End-KM im Einsatzplan prüfen:{" "}
                {ausgelassen.map((w) => `${w.lkw} KW${w.kw}/${w.jahr} (${w.wochenKm.toLocaleString("de-DE")} km)`).join(", ")}
              </div>
            )}
          </div>

          {/* ---------------- Je Monat ---------------- */}
          {proMonat.length > 1 && (
            <div style={card}>
              <div style={h2}>Verlauf je Monat{f.lkw !== "ALLE" && ` · ${f.lkw}`}</div>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Monat</th><th style={{ textAlign: "right" }}>Tankungen</th><th style={{ textAlign: "right" }}>Diesel</th><th style={{ textAlign: "right" }}>Ø €/L</th>
                      <th style={{ textAlign: "right" }}>AdBlue</th><th style={{ textAlign: "right" }}>Gesamt €</th><th style={{ textAlign: "right" }}>km</th>
                      <th style={{ textAlign: "right" }}>l/100 km</th><th style={{ textAlign: "right" }}>€/km</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proMonat.map((r) => (
                      <tr key={r.monat}>
                        <td>{r.monat}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{r.tankungen}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{liter(r.dieselL)}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{r.dieselL > 0 ? dez(r.dieselE / r.dieselL, 3) : "–"}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{liter(r.adblueL)}</td>
                        <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{euro(r.gesamt)}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{r.km > 0 ? Math.round(r.km).toLocaleString("de-DE") : "–"}</td>
                        <td className="mono" style={{ textAlign: "right", fontWeight: 600, color: MARINE }}>{l100(r.dieselL, r.km) ? dez(l100(r.dieselL, r.km), 1) : "–"}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{proKm(r.gesamt, r.km) ? dez(proKm(r.gesamt, r.km), 3) : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ---------------- Liste ---------------- */}
          <div style={card}>
            <div style={{ ...h2, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span>Tankvorgänge ({liste.length})</span>
              <span className="mono" style={{ fontSize: 13, color: MARINE }}>{liter(listeLiter)} · {euro(listeSumme)} netto</span>
            </div>
            <div style={{ overflowX: "auto", maxHeight: 640, overflowY: "auto" }}>
              <table>
                <thead style={{ position: "sticky", top: 0, background: CARD }}>
                  <tr>
                    <th>Datum</th><th>Zeit</th><th>LKW</th><th>Station</th><th>Sorte</th>
                    <th style={{ textAlign: "right" }}>Menge</th><th style={{ textAlign: "right" }}>Preis netto</th><th style={{ textAlign: "right" }}>Wert netto</th>
                    <th style={{ textAlign: "right" }}>KM (Säule)</th><th>Rechnung</th>
                  </tr>
                </thead>
                <tbody>
                  {liste.map((t) => (
                    <tr key={t.id} style={t.kategorie === "neben" ? { background: WARN_BG } : undefined}>
                      <td className="mono">{dmy(t.datum)}</td>
                      <td className="mono">{t.zeit}</td>
                      <td className="mono">{t.lkw}</td>
                      <td>{t.station}</td>
                      <td>{t.kategorie === "neben" ? t.sorte : KATEGORIE_LABEL[t.kategorie]}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{dez(t.menge)} {t.einheit}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{t.einheit === "L" ? dez(t.preis, 4) : euro(t.preis)}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{euro(t.wert)}</td>
                      <td className="mono" style={{ textAlign: "right", color: TEXT_MUTED }}>{t.kmBeleg ? t.kmBeleg.toLocaleString("de-DE") : ""}</td>
                      <td className="mono" style={{ fontSize: 12, color: TEXT_MUTED }}>{t.rechnungNr}</td>
                    </tr>
                  ))}
                  {liste.length === 0 && <tr><td colSpan={10} style={{ color: TEXT_MUTED }}>Keine Einträge.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---------------- Importierte Rechnungen ---------------- */}
          <div style={card}>
            <button className="ghost" onClick={() => setZeigeRechnungen(!zeigeRechnungen)}>
              {zeigeRechnungen ? "▾" : "▸"} Importierte Rechnungen ({rechnungen.length})
            </button>
            {zeigeRechnungen && (
              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table>
                  <thead><tr><th>Rechnung</th><th>Datum</th><th>Art</th><th style={{ textAlign: "right" }}>Summe netto</th><th>Datei</th><th>importiert</th><th></th></tr></thead>
                  <tbody>
                    {rechnungen.map((r) => (
                      <tr key={r.rechnungNr}>
                        <td className="mono">{r.rechnungNr}</td>
                        <td className="mono">{dmy(r.datum)}</td>
                        <td>{r.typ === "sammel" ? "Tankungen" : "Einzelrechnung"}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{euro(r.summe)}</td>
                        <td style={{ fontSize: 12, color: TEXT_MUTED }}>{r.dateiname}</td>
                        <td className="mono" style={{ fontSize: 12, color: TEXT_MUTED }}>{r.importiertAm ? dmy(r.importiertAm.slice(0, 10)) : ""}</td>
                        <td><button className="ghost" title="Rechnung löschen" onClick={() => rechnungLoeschen(r.rechnungNr)} style={{ padding: "4px 8px" }}><Trash2 size={13} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
      <style>{`
        @media (max-width: 820px) {
          .tank-filter-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .tank-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
        @media (min-width: 821px) and (max-width: 1250px) {
          .tank-kpi-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}
