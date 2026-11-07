// Tab "Maut": Toll-Collect-Einzelfahrtennachweise (CSV) hochladen, alle
// Mautfahrten filtern, je LKW auswerten und mit der Maut abgleichen, die in den
// Touren an den Kunden berechnet wurde.
//
// Abgleich: "bezahlt" = Summe der Toll-Collect-Fahrten, "berechnet" = Summe
// des Maut-Felds der Touren - jeweils je LKW und Tag (Fahrtdatum bzw.
// Tourdatum). Verglichen wird nur der Zeitraum, für den Toll-Collect-Daten
// vorliegen, und nur für LKW, die bei Toll Collect abgerechnet werden (der
// Miet-LKW läuft z. B. nicht über das eigene Toll-Collect-Konto).
// Gefahrene km (für "Maut-Anteil") kommen wie bei den Tankvorgängen aus dem
// Einsatzplan, Wochen anteilig nach Tagen.

import { Fragment, useEffect, useMemo, useState } from "react";
import { Upload, Loader2, Trash2, RefreshCw, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { parseMautCsv } from "./mautParser";
import * as mdb from "./mautDb";

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
const LISTE_MAX = 1000;

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dmy = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const euro = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "–" : n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }));
const dez = (n, s = 2) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { minimumFractionDigits: s, maximumFractionDigits: s }) : "–");
const ganz = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("de-DE") : "–");
const zahl = (v) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const WOCHENTAG = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const wt = (iso) => WOCHENTAG[new Date(iso + "T12:00:00").getDay()];

function isoWeekMonday(jahr, kw) {
  const d = new Date(jahr, 0, 4);
  const dayNr = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayNr + (kw - 1) * 7);
  return d;
}

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
const imZr = (d, z) => (!z.start || d >= z.start) && (!z.ende || d <= z.ende);

const MAX_WOCHEN_KM = 4500;
function kmJeLkw(wochen, { start, ende }) {
  const map = {};
  for (const w of wochen) {
    if (w.wochenKm === null || w.wochenKm === undefined || w.wochenKm < 0 || w.wochenKm > MAX_WOCHEN_KM) continue;
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

function Kpi({ label, value, sub, color }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: TEXT_MUTED, fontWeight: 500 }}>{label}</div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 600, color: color || MARINE, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const card = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 20 };
const h2 = { fontSize: 15, fontWeight: 600, marginBottom: 12, color: TEXT };
const R = { textAlign: "right" };
const diffFarbe = (d) => (Math.abs(d) < 0.005 ? TEXT : d > 0 ? SUCCESS : DANGER);
const diffText = (d) => (d > 0.005 ? "+" : "") + euro(d);

const TAG_TYP = {
  ohne_maut: { label: "Tour ohne Maut", farbe: DANGER, bg: DANGER_BG, tip: "Toll Collect hat Maut abgebucht, aber in den Touren dieses Tages ist keine Maut eingetragen" },
  ohne_tour: { label: "Maut ohne Tour", farbe: AMBER_DARK, bg: WARN_BG, tip: "Maut bezahlt, aber an diesem Tag keine Tour für diesen LKW erfasst" },
  ohne_fahrt: { label: "keine Mautfahrt", farbe: TEXT_MUTED, bg: "#F1F3F6", tip: "Maut in der Tour berechnet, aber an diesem Tag keine Toll-Collect-Fahrt" },
  diff: { label: "", farbe: TEXT, bg: null, tip: "" },
};

export default function Maut({ fleet, tours, wochenKm }) {
  const fleetPlates = useMemo(() => (fleet || []).map((f) => f.plate), [fleet]);
  const [daten, setDaten] = useState([]);
  const [abrechnungen, setAbrechnungen] = useState([]);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");
  const heute = new Date();
  const leer = { jahr: String(heute.getFullYear()), monat: "ALLE", lkw: "ALLE", von: "", bis: "", text: "" };
  const [f, setF] = useState(leer);

  const [vorschau, setVorschau] = useState([]);
  const [parsing, setParsing] = useState(false);
  const [importiere, setImportiere] = useState(false);
  const [meldung, setMeldung] = useState(null);
  const [zeigeAbrechnungen, setZeigeAbrechnungen] = useState(false);
  const [tagFilter, setTagFilter] = useState("auffaellig");
  const [diffGrenze, setDiffGrenze] = useState(20);
  const [offenerTag, setOffenerTag] = useState(null);

  async function neuLaden() {
    setLaden(true);
    setFehler("");
    try {
      const [d, a] = await Promise.all([mdb.fetchMautPositionen(), mdb.fetchMautAbrechnungen()]);
      setDaten(d);
      setAbrechnungen(a);
    } catch (e) {
      setFehler("Mautdaten konnten nicht geladen werden: " + (e.message || e));
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
    const bekannte = new Set(abrechnungen.map((a) => a.nr));
    const out = [];
    for (const file of files) {
      try {
        const p = await parseMautCsv(file, fleetPlates);
        const doppelt = out.some((o) => o.parsed && o.parsed.nr === p.nr);
        out.push({ dateiname: file.name, parsed: p, schonDa: bekannte.has(p.nr) || doppelt });
      } catch (err) {
        out.push({ dateiname: file.name, fehler: err.message || String(err) });
      }
    }
    out.sort((a, b) => String(a.parsed?.fahrtenVon || "").localeCompare(String(b.parsed?.fahrtenVon || "")));
    setVorschau(out);
    setParsing(false);
  }

  const importierbar = vorschau.filter((v) => v.parsed && !v.schonDa && v.parsed.fehlerZeilen.length === 0);

  async function uebernehmen() {
    setImportiere(true);
    let n = 0, pos = 0;
    const fehlerListe = [];
    for (const v of importierbar) {
      try {
        pos += await mdb.importMautAbrechnung(v.parsed);
        n++;
      } catch (err) {
        fehlerListe.push(`${v.parsed.nr}: ${err.message}`);
      }
    }
    setImportiere(false);
    setVorschau([]);
    setMeldung({ ok: fehlerListe.length === 0, text: `${n} Mautaufstellung(en) mit ${pos.toLocaleString("de-DE")} Fahrten übernommen.` + (fehlerListe.length ? ` Fehler: ${fehlerListe.join("; ")}` : "") });
    neuLaden();
  }

  async function abrechnungLoeschen(nr) {
    if (!window.confirm(`Mautaufstellung ${nr} mit allen Fahrten löschen? (Kann danach erneut hochgeladen werden.)`)) return;
    try {
      await mdb.deleteMautAbrechnung(nr);
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

  // LKW, die bei Toll Collect vorkommen (nur diese werden abgeglichen)
  const mautLkw = useMemo(() => {
    const s = new Set(daten.map((t) => t.lkw));
    return [...fleetPlates.filter((p) => s.has(p)), ...Array.from(s).filter((p) => !fleetPlates.includes(p)).sort()];
  }, [daten, fleetPlates]);

  // Zeitraum mit Toll-Collect-Daten: erste bis letzte Fahrt
  const abgedeckt = useMemo(() => {
    let von = "", bis = "";
    for (const a of abrechnungen) {
      if (a.fahrtenVon && (!von || a.fahrtenVon < von)) von = a.fahrtenVon;
      if (a.fahrtenBis && (!bis || a.fahrtenBis > bis)) bis = a.fahrtenBis;
    }
    return { von, bis };
  }, [abrechnungen]);

  const zr = useMemo(() => zeitraum(f), [f.jahr, f.monat, f.von, f.bis]);
  // Für Abgleich und km: Filterzeitraum geschnitten mit dem abgedeckten Zeitraum
  const zrAbgleich = useMemo(() => ({
    start: abgedeckt.von && (!zr.start || zr.start < abgedeckt.von) ? abgedeckt.von : zr.start,
    ende: abgedeckt.bis && (!zr.ende || zr.ende > abgedeckt.bis) ? abgedeckt.bis : zr.ende,
  }), [zr, abgedeckt]);

  const lkwOk = (p) => f.lkw === "ALLE" || p === f.lkw;
  const fahrten = useMemo(() => daten.filter((t) => imZr(t.datum, zr) && lkwOk(t.lkw)), [daten, zr, f.lkw]);
  const touren = useMemo(
    () => (tours || []).filter((t) => t.datum && mautLkw.includes(t.lkw) && lkwOk(t.lkw) && imZr(t.datum, zrAbgleich)),
    [tours, mautLkw, zrAbgleich, f.lkw]
  );
  const km = useMemo(() => kmJeLkw(wochenKm || [], zrAbgleich), [wochenKm, zrAbgleich]);

  const gesamt = useMemo(() => {
    const s = { fahrten: fahrten.length, betrag: 0, mautKm: 0, berechnet: 0, km: 0 };
    for (const t of fahrten) { s.betrag += t.betrag; s.mautKm += t.km; }
    for (const t of touren) s.berechnet += zahl(t.maut);
    for (const p of mautLkw) if (lkwOk(p)) s.km += km[p] || 0;
    return s;
  }, [fahrten, touren, km, mautLkw, f.lkw]);

  const proLkw = useMemo(() => mautLkw.filter(lkwOk).map((p) => {
    const r = { lkw: p, fahrten: 0, betrag: 0, mautKm: 0, berechnet: 0, touren: 0, km: km[p] || 0 };
    for (const t of fahrten) if (t.lkw === p) { r.fahrten++; r.betrag += t.betrag; r.mautKm += t.km; }
    for (const t of touren) if (t.lkw === p) { r.touren++; r.berechnet += zahl(t.maut); }
    return r;
  }).filter((r) => r.fahrten > 0 || r.berechnet > 0), [mautLkw, fahrten, touren, km, f.lkw]);

  const proMonat = useMemo(() => {
    const map = {};
    const add = (k) => (map[k] = map[k] || { fahrten: 0, betrag: 0, mautKm: 0, berechnet: 0 });
    for (const t of fahrten) { const m = add(t.datum.slice(0, 7)); m.fahrten++; m.betrag += t.betrag; m.mautKm += t.km; }
    for (const t of touren) add(t.datum.slice(0, 7)).berechnet += zahl(t.maut);
    return Object.keys(map).sort().reverse().map((k) => {
      const [j, m] = k.split("-").map(Number);
      // Monat nur teilweise abgedeckt? (Toll-Collect-Abrechnung läuft vom 8. bis 7.)
      const mStart = `${k}-01`, mEnde = isoOf(new Date(j, m, 0));
      const teil = (abgedeckt.von && abgedeckt.von > mStart) || (abgedeckt.bis && abgedeckt.bis < mEnde);
      return { key: k, monat: `${MONATE[m - 1]} ${j}`, teil, ...map[k] };
    });
  }, [fahrten, touren, abgedeckt]);

  // Tagesabgleich je LKW
  const tage = useMemo(() => {
    const map = {};
    const add = (lkw, d) => {
      const k = `${lkw}|${d}`;
      return (map[k] = map[k] || { key: k, lkw, datum: d, fahrten: [], touren: [], betrag: 0, berechnet: 0, ohneMaut: 0 });
    };
    for (const t of fahrten) {
      if (!imZr(t.datum, zrAbgleich)) continue;
      const x = add(t.lkw, t.datum); x.fahrten.push(t); x.betrag += t.betrag;
    }
    for (const t of touren) {
      const x = add(t.lkw, t.datum); x.touren.push(t); x.berechnet += zahl(t.maut);
      if (!t.andererAuftraggeber && zahl(t.maut) === 0) x.ohneMaut++;
    }
    return Object.values(map).map((x) => {
      x.diff = x.berechnet - x.betrag;
      x.typ = x.touren.length === 0 ? "ohne_tour"
        : x.fahrten.length === 0 ? (x.berechnet > 0 ? "ohne_fahrt" : "diff")
        : x.ohneMaut > 0 ? "ohne_maut" : "diff";
      x.fahrten.sort((a, b) => a.zeit.localeCompare(b.zeit));
      return x;
    }).sort((a, b) => b.datum.localeCompare(a.datum) || a.lkw.localeCompare(b.lkw));
  }, [fahrten, touren, zrAbgleich]);

  const tageZaehler = useMemo(() => {
    const z = { ohne_maut: 0, ohne_tour: 0, ohne_fahrt: 0 };
    for (const t of tage) if (z[t.typ] !== undefined) z[t.typ]++;
    return z;
  }, [tage]);

  const tageGefiltert = useMemo(() => tage.filter((t) => {
    if (tagFilter === "alle") return true;
    if (tagFilter === "auffaellig") return t.typ !== "diff" || Math.abs(t.diff) >= diffGrenze;
    if (tagFilter === "diff") return Math.abs(t.diff) >= diffGrenze;
    return t.typ === tagFilter;
  }), [tage, tagFilter, diffGrenze]);

  const liste = useMemo(() => {
    const q = f.text.trim().toLowerCase();
    return fahrten
      .filter((t) => !q || `${t.auffahrt} ${t.ueber} ${t.abfahrt} ${t.buchungsnr}`.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => (b.datum + b.zeit).localeCompare(a.datum + a.zeit) || a.lkw.localeCompare(b.lkw));
  }, [fahrten, f.text]);
  const listeSumme = liste.reduce((s, t) => s + t.betrag, 0);
  const listeKm = liste.reduce((s, t) => s + t.km, 0);

  const letzteFahrt = abgedeckt.bis;
  const diffGesamt = gesamt.berechnet - gesamt.betrag;
  const nichtAbgeglichen = useMemo(
    () => Array.from(new Set((tours || []).filter((t) => t.datum && imZr(t.datum, zrAbgleich) && zahl(t.maut) > 0 && !mautLkw.includes(t.lkw) && lkwOk(t.lkw)).map((t) => t.lkw))),
    [tours, zrAbgleich, mautLkw, f.lkw]
  );

  return (
    <div>
      {/* ---------------- Upload ---------------- */}
      <div style={{ ...card, maxWidth: 860 }}>
        <div style={h2}>Toll-Collect-Einzelfahrtennachweis hochladen (CSV)</div>
        <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 14 }}>
          Im Toll-Collect-Kundenportal den Einzelfahrtennachweis als CSV herunterladen und hier auswählen – auch mehrere Monate auf einmal.
          Schon importierte Mautaufstellungen werden erkannt und übersprungen. Die Summe in der Vorschau sollte dem Gesamtbetrag der Mautaufstellung entsprechen.
          {letzteFahrt && <> Letzte erfasste Mautfahrt: <b>{dmy(letzteFahrt)}</b>.</>}
        </div>
        <label className="ghost" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: parsing ? "wait" : "pointer", border: `1px solid ${BORDER}`, borderRadius: 6, padding: "7px 12px", fontSize: 13, color: TEXT, margin: 0, width: "auto" }}>
          <Upload size={15} /> CSV-Dateien auswählen
          <input type="file" accept=".csv,text/csv" multiple onChange={dateienGewaehlt} disabled={parsing || importiere} style={{ display: "none" }} />
        </label>
        {parsing && <div style={{ marginTop: 12, fontSize: 13, color: MARINE, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={15} /> Lese Dateien aus …</div>}
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
                  <tr><th>Datei</th><th>Mautaufstellung</th><th>Fahrten von – bis</th><th style={R}>Fahrten</th><th style={R}>LKW</th><th style={R}>Maut-km</th><th style={R}>Summe</th><th>Prüfung</th></tr>
                </thead>
                <tbody>
                  {vorschau.map((v, i) => {
                    const p = v.parsed;
                    let status;
                    if (v.fehler) status = <span style={{ color: DANGER }}>{v.fehler}</span>;
                    else if (v.schonDa) status = <span style={{ color: TEXT_MUTED }}>schon importiert – wird übersprungen</span>;
                    else if (p.fehlerZeilen.length) status = <span style={{ color: DANGER }}><AlertTriangle size={13} /> Zeile(n) {p.fehlerZeilen.slice(0, 5).join(", ")} nicht lesbar – wird nicht übernommen</span>;
                    else status = (
                      <span style={{ color: SUCCESS }}>
                        <CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> OK
                        {p.doppelteBnr > 0 && <span style={{ color: AMBER_DARK }}> · {p.doppelteBnr} doppelte Buchungsnr. (nur einmal übernommen)</span>}
                        {p.fremd.length > 0 && <span style={{ color: AMBER_DARK }}> · nicht im Fuhrpark: {p.fremd.join(", ")}</span>}
                      </span>
                    );
                    return (
                      <tr key={i}>
                        <td style={{ fontSize: 12 }}>{v.dateiname}</td>
                        <td className="mono">{p?.nr || "–"}</td>
                        <td className="mono">{p ? `${dmy(p.fahrtenVon)} – ${dmy(p.fahrtenBis)}` : "–"}</td>
                        <td className="mono" style={R}>{p ? p.anzahl : "–"}</td>
                        <td className="mono" style={R}>{p ? p.lkwAnzahl : "–"}</td>
                        <td className="mono" style={R}>{p ? ganz(p.km) : "–"}</td>
                        <td className="mono" style={{ ...R, fontWeight: 600 }}>{p ? euro(p.summe) : "–"}</td>
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
                {importierbar.length} Mautaufstellung(en) übernehmen
              </button>
              <button className="ghost" onClick={() => setVorschau([])} disabled={importiere}>Abbrechen</button>
            </div>
          </div>
        )}
      </div>

      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}

      {/* ---------------- Filter ---------------- */}
      <div style={{ ...card, padding: "14px 18px" }}>
        <div className="maut-filter-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
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
              {mautLkw.map((p) => <option key={p} value={p}>{p}</option>)}
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
          <button className="ghost" onClick={() => setF(leer)}>Filter zurücksetzen</button>
          <button className="ghost" onClick={neuLaden} disabled={laden}><RefreshCw size={14} /> Neu laden</button>
        </div>
      </div>

      {laden ? (
        <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Mautdaten …</div>
      ) : daten.length === 0 ? (
        <div style={{ ...card, color: TEXT_MUTED, fontSize: 13 }}>Noch keine Mautdaten importiert – oben die CSV-Dateien von Toll Collect hochladen.</div>
      ) : (
        <>
          {/* ---------------- Kennzahlen ---------------- */}
          <div className="maut-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 20 }}>
            <Kpi label="Maut bezahlt (Toll Collect)" value={euro(gesamt.betrag)} sub={`${gesamt.fahrten.toLocaleString("de-DE")} Mautfahrten`} />
            <Kpi label="Maut-km" value={ganz(gesamt.mautKm)} sub={gesamt.mautKm > 0 ? `Ø ${dez(gesamt.betrag / gesamt.mautKm, 3)} €/km` : null} />
            <Kpi label="Maut je gefahrenem km" value={gesamt.km > 0 ? `${dez(gesamt.betrag / gesamt.km, 3)} €/km` : "–"} sub={gesamt.km > 0 ? `${ganz(gesamt.km)} km lt. Einsatzplan` : "keine km im Zeitraum"} />
            <Kpi label="Mautpflichtiger Anteil" value={gesamt.km > 0 ? `${dez((gesamt.mautKm / gesamt.km) * 100, 0)} %` : "–"} sub="Maut-km ÷ gefahrene km" />
            <Kpi label="Maut berechnet (Touren)" value={euro(gesamt.berechnet)} sub={`${touren.length.toLocaleString("de-DE")} Touren`} />
            <Kpi label="Differenz berechnet − bezahlt" value={diffText(diffGesamt)} color={diffFarbe(diffGesamt)}
              sub={gesamt.betrag > 0 ? `Deckung ${dez((gesamt.berechnet / gesamt.betrag) * 100, 0)} %` : null} />
          </div>
          {abgedeckt.von && (
            <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: -10, marginBottom: 16 }}>
              Abgleich und km nur für den Zeitraum mit Toll-Collect-Daten ({dmy(abgedeckt.von)} – {dmy(abgedeckt.bis)}).
              {nichtAbgeglichen.length > 0 && <> Nicht abgeglichen (keine Toll-Collect-Fahrten): {nichtAbgeglichen.join(", ")}.</>}
            </div>
          )}

          {/* ---------------- Je LKW ---------------- */}
          <div style={card}>
            <div style={h2}>Auswertung je LKW</div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>LKW</th><th style={R}>Mautfahrten</th><th style={R}>Maut-km</th><th style={R}>Maut bezahlt</th><th style={R}>Ø €/Maut-km</th>
                    <th style={R}>Gefahrene km</th><th style={R}>Mautanteil</th><th style={R}>Maut €/km</th>
                    <th style={R}>Touren</th><th style={R}>Maut berechnet</th><th style={R}>Differenz</th><th style={R}>Deckung</th>
                  </tr>
                </thead>
                <tbody>
                  {proLkw.map((r) => {
                    const d = r.berechnet - r.betrag;
                    return (
                      <tr key={r.lkw}>
                        <td className="mono" style={{ fontWeight: 600 }}>{r.lkw}</td>
                        <td className="mono" style={R}>{r.fahrten}</td>
                        <td className="mono" style={R}>{ganz(r.mautKm)}</td>
                        <td className="mono" style={{ ...R, fontWeight: 600 }}>{euro(r.betrag)}</td>
                        <td className="mono" style={R}>{r.mautKm > 0 ? dez(r.betrag / r.mautKm, 3) : "–"}</td>
                        <td className="mono" style={R}>{r.km > 0 ? `≈ ${ganz(r.km)}` : "–"}</td>
                        <td className="mono" style={R}>{r.km > 0 ? `${dez((r.mautKm / r.km) * 100, 0)} %` : "–"}</td>
                        <td className="mono" style={{ ...R, color: MARINE, fontWeight: 600 }}>{r.km > 0 ? dez(r.betrag / r.km, 3) : "–"}</td>
                        <td className="mono" style={R}>{r.touren}</td>
                        <td className="mono" style={R}>{euro(r.berechnet)}</td>
                        <td className="mono" style={{ ...R, fontWeight: 600, color: diffFarbe(d) }}>{diffText(d)}</td>
                        <td className="mono" style={R}>{r.betrag > 0 ? `${dez((r.berechnet / r.betrag) * 100, 0)} %` : "–"}</td>
                      </tr>
                    );
                  })}
                  {proLkw.length === 0 && <tr><td colSpan={12} style={{ color: TEXT_MUTED }}>Keine Mautfahrten im gewählten Zeitraum.</td></tr>}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 10 }}>
              Gefahrene km aus dem Einsatzplan (Wochen anteilig nach Tagen). Mautanteil = mautpflichtige km ÷ gefahrene km.
              Maut berechnet = Summe des Maut-Felds der Touren. Differenz grün = mehr berechnet als bezahlt, rot = weniger.
            </div>
          </div>

          {/* ---------------- Je Monat ---------------- */}
          {proMonat.length > 1 && (
            <div style={card}>
              <div style={h2}>Verlauf je Monat{f.lkw !== "ALLE" && ` · ${f.lkw}`}</div>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr><th>Monat</th><th style={R}>Mautfahrten</th><th style={R}>Maut-km</th><th style={R}>Maut bezahlt</th><th style={R}>Ø €/Maut-km</th><th style={R}>Maut berechnet</th><th style={R}>Differenz</th></tr>
                  </thead>
                  <tbody>
                    {proMonat.map((r) => {
                      const d = r.berechnet - r.betrag;
                      return (
                        <tr key={r.key}>
                          <td>{r.monat}{r.teil && <span style={{ fontSize: 11, color: TEXT_MUTED }}> (teilweise)</span>}</td>
                          <td className="mono" style={R}>{r.fahrten}</td>
                          <td className="mono" style={R}>{ganz(r.mautKm)}</td>
                          <td className="mono" style={{ ...R, fontWeight: 600 }}>{euro(r.betrag)}</td>
                          <td className="mono" style={R}>{r.mautKm > 0 ? dez(r.betrag / r.mautKm, 3) : "–"}</td>
                          <td className="mono" style={R}>{euro(r.berechnet)}</td>
                          <td className="mono" style={{ ...R, fontWeight: 600, color: diffFarbe(d) }}>{diffText(d)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 10 }}>
                Kalendermonate nach Fahrt- bzw. Tourdatum. Toll Collect rechnet vom 8. bis zum 7. des Folgemonats ab – „teilweise“ = für diesen Monat liegen noch nicht alle Fahrten vor.
              </div>
            </div>
          )}

          {/* ---------------- Tagesabgleich ---------------- */}
          <div style={card}>
            <div style={{ ...h2, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span>Abgleich je Tag und LKW ({tageGefiltert.length})</span>
              <span style={{ fontSize: 12, fontWeight: 400, color: TEXT_MUTED }}>
                <span style={{ color: DANGER }}>{tageZaehler.ohne_maut} Tage Tour ohne Maut</span> · <span style={{ color: AMBER_DARK }}>{tageZaehler.ohne_tour} Tage Maut ohne Tour</span> · {tageZaehler.ohne_fahrt} Tage ohne Mautfahrt
              </span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
              <div style={{ minWidth: 230 }}>
                <label>Anzeigen</label>
                <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                  <option value="auffaellig">Nur Auffälligkeiten</option>
                  <option value="ohne_maut">Tour ohne Maut (Maut nicht berechnet?)</option>
                  <option value="ohne_tour">Maut ohne Tour</option>
                  <option value="ohne_fahrt">Maut berechnet, keine Mautfahrt</option>
                  <option value="diff">Differenz ab Grenze</option>
                  <option value="alle">Alle Tage</option>
                </select>
              </div>
              <div style={{ width: 150 }}>
                <label>Differenz ab (€)</label>
                <input type="number" min="0" step="5" value={diffGrenze} onChange={(e) => setDiffGrenze(Math.max(0, Number(e.target.value) || 0))} />
              </div>
            </div>
            <div style={{ overflowX: "auto", maxHeight: 620, overflowY: "auto" }}>
              <table>
                <thead style={{ position: "sticky", top: 0, background: CARD, zIndex: 1 }}>
                  <tr>
                    <th style={{ width: 24 }}></th><th>Datum</th><th>LKW</th><th style={R}>Mautfahrten</th><th style={R}>Maut bezahlt</th>
                    <th style={R}>Touren</th><th>Kunden</th><th style={R}>Maut berechnet</th><th style={R}>Differenz</th><th>Hinweis</th>
                  </tr>
                </thead>
                <tbody>
                  {tageGefiltert.slice(0, 600).map((t) => {
                    const typ = TAG_TYP[t.typ];
                    const offen = offenerTag === t.key;
                    return (
                      <Fragment key={t.key}>
                        <tr onClick={() => setOffenerTag(offen ? null : t.key)} style={{ cursor: "pointer", background: typ.bg || undefined }}>
                          <td>{offen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                          <td className="mono">{wt(t.datum)} {dmy(t.datum)}</td>
                          <td className="mono">{t.lkw}</td>
                          <td className="mono" style={R}>{t.fahrten.length || "–"}</td>
                          <td className="mono" style={R}>{t.fahrten.length ? euro(t.betrag) : "–"}</td>
                          <td className="mono" style={R}>{t.touren.length || "–"}</td>
                          <td style={{ fontSize: 12, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {Array.from(new Set(t.touren.map((x) => x.kunde))).join(", ")}
                          </td>
                          <td className="mono" style={R}>{t.touren.length ? euro(t.berechnet) : "–"}</td>
                          <td className="mono" style={{ ...R, fontWeight: 600, color: diffFarbe(t.diff) }}>{diffText(t.diff)}</td>
                          <td style={{ fontSize: 12, color: typ.farbe, fontWeight: 600 }} title={typ.tip}>
                            {typ.label}{t.typ === "ohne_maut" && t.touren.length > 1 ? ` (${t.ohneMaut} von ${t.touren.length})` : ""}
                          </td>
                        </tr>
                        {offen && (
                          <tr>
                            <td></td>
                            <td colSpan={9} style={{ background: "#F7F9FB", padding: "10px 12px" }}>
                              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16 }} className="maut-tag-detail">
                                <div>
                                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Touren</div>
                                  {t.touren.length === 0 ? <div style={{ fontSize: 12, color: TEXT_MUTED }}>keine</div> : (
                                    <table>
                                      <thead><tr><th>Auftrag</th><th>Kunde</th><th>Ort</th><th style={R}>km</th><th style={R}>Maut</th></tr></thead>
                                      <tbody>
                                        {t.touren.map((x) => (
                                          <tr key={x.id}>
                                            <td className="mono" style={{ fontSize: 12 }}>{x.auftragsNr}</td>
                                            <td style={{ fontSize: 12, color: x.andererAuftraggeber ? "#1D5FBF" : undefined, fontWeight: x.andererAuftraggeber ? 600 : undefined }}>{x.kunde}</td>
                                            <td style={{ fontSize: 12 }}>{x.ort}</td>
                                            <td className="mono" style={{ ...R, fontSize: 12 }}>{x.km}</td>
                                            <td className="mono" style={{ ...R, fontSize: 12, color: zahl(x.maut) === 0 && !x.andererAuftraggeber ? DANGER : undefined }}>{zahl(x.maut) ? euro(zahl(x.maut)) : "–"}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                                <div>
                                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Mautfahrten (Toll Collect)</div>
                                  {t.fahrten.length === 0 ? <div style={{ fontSize: 12, color: TEXT_MUTED }}>keine</div> : (
                                    <table>
                                      <thead><tr><th>Start</th><th>Auffahrt → Abfahrt</th><th style={R}>km</th><th style={R}>Betrag</th></tr></thead>
                                      <tbody>
                                        {t.fahrten.map((x) => (
                                          <tr key={x.id}>
                                            <td className="mono" style={{ fontSize: 12 }}>{x.zeit}</td>
                                            <td style={{ fontSize: 12 }} title={x.ueber}>{x.auffahrt} → {x.abfahrt}</td>
                                            <td className="mono" style={{ ...R, fontSize: 12 }}>{dez(x.km, 1)}</td>
                                            <td className="mono" style={{ ...R, fontSize: 12 }}>{euro(x.betrag)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {tageGefiltert.length === 0 && <tr><td colSpan={10} style={{ color: TEXT_MUTED }}>Keine Tage für diese Auswahl.</td></tr>}
                  {tageGefiltert.length > 600 && <tr><td colSpan={10} style={{ color: TEXT_MUTED }}>Nur die ersten 600 Tage angezeigt – Zeitraum oder LKW eingrenzen.</td></tr>}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 10 }}>
              Zeile anklicken für Touren und Mautfahrten des Tages. Tagesweise Differenzen sind normal (Leerfahrten, Umwege, Pauschalen je Kunde) –
              wichtig sind vor allem „Tour ohne Maut“ (Maut bezahlt, in der Tour aber nichts eingetragen) und „Maut ohne Tour“.
              Touren anderer Auftraggeber haben kein Maut-Feld und zählen nicht als „Tour ohne Maut“.
            </div>
          </div>

          {/* ---------------- Liste ---------------- */}
          <div style={card}>
            <div style={{ ...h2, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span>Mautfahrten ({liste.length.toLocaleString("de-DE")})</span>
              <span className="mono" style={{ fontSize: 13, color: MARINE }}>{ganz(listeKm)} km · {euro(listeSumme)}</span>
            </div>
            <div style={{ maxWidth: 360, marginBottom: 12 }}>
              <label>Suche (Ort, Strecke, Buchungsnr.)</label>
              <input type="text" value={f.text} placeholder="z. B. Kelsterbach" onChange={(e) => setF({ ...f, text: e.target.value })} />
            </div>
            <div style={{ overflowX: "auto", maxHeight: 640, overflowY: "auto" }}>
              <table>
                <thead style={{ position: "sticky", top: 0, background: CARD, zIndex: 1 }}>
                  <tr>
                    <th>Datum</th><th>Start</th><th>LKW</th><th>Auffahrt</th><th>über</th><th>Abfahrt</th>
                    <th style={R}>km</th><th style={R}>Betrag</th><th style={R}>€/km</th><th>Buchungsnr.</th>
                  </tr>
                </thead>
                <tbody>
                  {liste.slice(0, LISTE_MAX).map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{dmy(t.datum)}</td>
                      <td className="mono">{t.zeit}</td>
                      <td className="mono">{t.lkw}</td>
                      <td style={{ fontSize: 12 }}>{t.auffahrt}</td>
                      <td style={{ fontSize: 11.5, color: TEXT_MUTED, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.ueber}>{t.ueber}</td>
                      <td style={{ fontSize: 12 }}>{t.abfahrt}</td>
                      <td className="mono" style={R}>{dez(t.km, 1)}</td>
                      <td className="mono" style={R}>{euro(t.betrag)}</td>
                      <td className="mono" style={{ ...R, color: TEXT_MUTED }}>{t.km > 0 ? dez(t.betrag / t.km, 3) : "–"}</td>
                      <td className="mono" style={{ fontSize: 12, color: TEXT_MUTED }}>{t.buchungsnr}</td>
                    </tr>
                  ))}
                  {liste.length === 0 && <tr><td colSpan={10} style={{ color: TEXT_MUTED }}>Keine Einträge.</td></tr>}
                  {liste.length > LISTE_MAX && <tr><td colSpan={10} style={{ color: TEXT_MUTED }}>Nur die neuesten {LISTE_MAX.toLocaleString("de-DE")} Fahrten angezeigt – Zeitraum oder LKW eingrenzen. Summe oben gilt für alle {liste.length.toLocaleString("de-DE")}.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ---------------- Importierte Mautaufstellungen ---------------- */}
      <div style={card}>
        <button className="ghost" onClick={() => setZeigeAbrechnungen(!zeigeAbrechnungen)}>
          {zeigeAbrechnungen ? "▾" : "▸"} Importierte Mautaufstellungen ({abrechnungen.length})
        </button>
        {zeigeAbrechnungen && (
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table>
              <thead><tr><th>Mautaufstellung</th><th>Datum</th><th>Fahrten von – bis</th><th style={R}>Fahrten</th><th style={R}>Summe</th><th>Datei</th><th>importiert</th><th></th></tr></thead>
              <tbody>
                {abrechnungen.map((a) => (
                  <tr key={a.nr}>
                    <td className="mono">{a.nr}</td>
                    <td className="mono">{dmy(a.datum)}</td>
                    <td className="mono">{dmy(a.fahrtenVon)} – {dmy(a.fahrtenBis)}</td>
                    <td className="mono" style={R}>{a.anzahl}</td>
                    <td className="mono" style={R}>{euro(a.summe)}</td>
                    <td style={{ fontSize: 12, color: TEXT_MUTED }}>{a.dateiname}</td>
                    <td className="mono" style={{ fontSize: 12, color: TEXT_MUTED }}>{a.importiertAm ? dmy(a.importiertAm.slice(0, 10)) : ""}</td>
                    <td><button className="ghost" title="Mautaufstellung löschen" onClick={() => abrechnungLoeschen(a.nr)} style={{ padding: "4px 8px" }}><Trash2 size={13} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <style>{`
        @media (max-width: 820px) {
          .maut-filter-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .maut-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .maut-tag-detail { grid-template-columns: 1fr !important; }
        }
        @media (min-width: 821px) and (max-width: 1250px) {
          .maut-kpi-grid { grid-template-columns: repeat(3, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}
