// Tab "Tankvorgänge": Tankpool-Rechnungen (PDF) hochladen, alle Tankvorgänge
// filtern und je LKW auswerten (Liter, Kosten, l/100 km, Kosten pro km).
//
// Gefahrene km kommen aus dem Einsatzplan (Wochen-KM aus routecontrol). Weil
// der Einsatzplan wochenweise rechnet, wird eine Woche, die nur teilweise im
// gewählten Zeitraum liegt, anteilig nach Tagen gezählt (z. B. 3 von 7 Tagen).
// l/100 km ist dadurch ein Näherungswert: getankt wird nicht genau dann, wenn
// die km gefahren werden - über einen Monat oder ein Jahr gleicht sich das aus.

import { useEffect, useMemo, useState } from "react";
import { Upload, Loader2, Trash2, RefreshCw, CheckCircle2, AlertTriangle, Gauge } from "lucide-react";
import { parseTankbelegPdf } from "./tankpoolParser";
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
const KM_STATUS = {
  keine_fahrten: "routecontrol: keine Fahrten um den Tankzeitpunkt",
  kein_fahrzeug: "Fahrzeug nicht in routecontrol",
  fehler: "Abruf fehlgeschlagen - erneut versuchen",
};
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

// Verbrauch "von Tankung zu Tankung" mit dem Tachostand (routecontrol, km_rc):
// Diesel-Zeilen je LKW nach Zeit sortieren; aufeinanderfolgende Zeilen, die
// weniger als 30 km auseinanderliegen, sind EIN Tankstopp (zwei Tanks bzw.
// Wechsel der Zapfsäule). Für jeden
// Stopp: km seit dem vorherigen Stopp; die dort getankten Liter gehören zu
// genau dieser Strecke. Erster Stopp eines LKW zählt nicht (keine Strecke
// davor). Sprünge über 6.000 km oder rückwärts gelten als Datenfehler.
// Shell-Tankungen (ohne Uhrzeit und ohne KM-Stand) zählen mit ihren Litern zur
// Strecke bis zum nächsten Tankpool-Stopp an einem SPÄTEREN Tag (gebucht auf
// diesen Stopp).
const MAX_KM_ZWISCHEN_TANKUNGEN = 6000;
function mitTachoStrecken(daten) {
  const proLkw = {};
  const ohneKm = {}; // Shell-Diesel je LKW
  for (const t of daten) {
    if (t.kategorie !== "diesel") continue;
    if (t.kmRc) (proLkw[t.lkw] = proLkw[t.lkw] || []).push(t);
    else if (t.quelle === "shell") (ohneKm[t.lkw] = ohneKm[t.lkw] || []).push(t);
  }
  const info = {}; // id -> { kmSeit, tachoKm, tachoL, tachoDE }
  for (const [lkw, rows] of Object.entries(proLkw)) {
    rows.sort((a, b) => (a.datum + a.zeit).localeCompare(b.datum + b.zeit));
    const stopps = [];
    for (const t of rows) {
      const letzter = stopps[stopps.length - 1];
      if (letzter && Math.abs(t.kmRc - letzter.kmLetzt) < 30) { letzter.rows.push(t); letzter.kmLetzt = t.kmRc; }
      else stopps.push({ km: t.kmRc, kmLetzt: t.kmRc, rows: [t] });
    }
    for (let i = 1; i < stopps.length; i++) {
      const delta = stopps[i].km - stopps[i - 1].kmLetzt;
      if (delta <= 0 || delta > MAX_KM_ZWISCHEN_TANKUNGEN) continue;
      stopps[i].ok = true;
      stopps[i].rows.forEach((t, j) => {
        info[t.id] = { kmSeit: j === 0 ? delta : null, tachoKm: j === 0 ? delta : 0, tachoL: t.menge || 0, tachoDE: t.wert };
      });
    }
    for (const sh of ohneKm[lkw] || []) {
      const ziel = stopps.find((st) => st.rows[0].datum > sh.datum);
      if (ziel && ziel.ok && stopps.indexOf(ziel) > 0 && stopps[stopps.indexOf(ziel) - 1].rows[0].datum <= sh.datum) {
        // Liter/Kosten auf den Stopp buchen, der die Strecke abschließt - so
        // landen Liter und km bei Monats-/Zeitraumgrenzen immer zusammen.
        const ziel0 = info[ziel.rows[0].id];
        ziel0.tachoL += sh.menge || 0;
        ziel0.tachoDE += sh.wert;
        ziel0.shellL = (ziel0.shellL || 0) + (sh.menge || 0);
      }
    }
  }
  return daten.map((t) => (info[t.id] ? { ...t, ...info[t.id] } : t));
}

function summiere(liste) {
  const s = { tankungen: 0, dieselL: 0, dieselE: 0, adblueL: 0, adblueE: 0, nebenE: 0, gesamt: 0, tachoKm: 0, tachoL: 0, tachoDE: 0 };
  for (const t of liste) {
    s.gesamt += t.wert;
    s.tachoKm += t.tachoKm || 0;
    s.tachoL += t.tachoL || 0;
    s.tachoDE += t.tachoDE || 0;
    if (t.kategorie === "diesel") { s.dieselL += t.menge || 0; s.dieselE += t.wert; s.tankungen++; }
    else if (t.kategorie === "adblue") { s.adblueL += t.menge || 0; s.adblueE += t.wert; }
    else s.nebenE += t.wert;
  }
  return s;
}

// km/Liter-Basis je LKW: Tacho-Strecken, wenn vorhanden - sonst (z. B. LKW
// ohne routecontrol) Wochen-KM aus dem Einsatzplan mit allen Dieselmengen.
function kennzahl(s, kmEinsatz) {
  const k = s.tachoKm > 0
    ? { km: s.tachoKm, liter: s.tachoL, dieselE: s.tachoDE, quelle: "tacho" }
    : { km: kmEinsatz || 0, liter: s.dieselL, dieselE: s.dieselE, quelle: "einsatzplan" };
  k.kosten = k.dieselE + s.adblueE + s.nebenE;
  return k;
}
function auswerten(rows, lkwListe, kmMap) {
  const lkwRows = lkwListe
    .map((p) => {
      const s = summiere(rows.filter((t) => t.lkw === p));
      return { lkw: p, ...s, k: kennzahl(s, kmMap[p]) };
    })
    .filter((r) => r.gesamt !== 0);
  const tot = { km: 0, liter: 0, kosten: 0, fallback: lkwRows.some((r) => r.k.quelle === "einsatzplan" && r.k.km > 0) };
  for (const r of lkwRows) {
    if (r.k.km > 0) { tot.km += r.k.km; tot.liter += r.k.liter; tot.kosten += r.k.kosten; }
  }
  return { lkwRows, ...tot };
}

function KarteBadge({ quelle }) {
  const shell = quelle === "shell";
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 10, whiteSpace: "nowrap",
      background: shell ? "#FFF4C2" : "#E4ECF5", color: shell ? "#7A5B00" : MARINE,
    }}>{shell ? "Shell" : "Tankpool"}</span>
  );
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

export default function Tankvorgaenge({ fleet, wochenKm, startFilter, onFilterChange }) {
  const fleetPlates = useMemo(() => (fleet || []).map((f) => f.plate), [fleet]);
  const [daten, setDaten] = useState([]);
  const [rechnungen, setRechnungen] = useState([]);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");
  const heute = new Date();
  const [f, setF] = useState({ jahr: String(heute.getFullYear()), monat: "ALLE", lkw: "ALLE", kategorie: "ALLE", quelle: "ALLE", von: "", bis: "", ...(startFilter || {}) });
  // Zeitraum/LKW an den Fuhrpark-Rahmen melden (gemeinsamer Filter der Reiter)
  useEffect(() => { onFilterChange && onFilterChange(f); }, [f.jahr, f.monat, f.lkw, f.von, f.bis]);

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
        const parsed = await parseTankbelegPdf(file, fleetPlates);
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

  const importierbar = vorschau.filter((v) => v.parsed && !v.schonDa && !v.parsed.ueberspringen && !v.parsed.summenAbweichung);

  async function uebernehmen() {
    setImportiere(true);
    let n = 0, pos = 0, nTankpool = 0;
    const fehlerListe = [];
    for (const v of importierbar) {
      try {
        pos += await tdb.importTankpoolRechnung(v.parsed);
        n++;
        if (v.parsed.quelle === "tankpool") nTankpool++;
      } catch (err) {
        fehlerListe.push(`${v.parsed.rechnungNr}: ${err.message}`);
      }
    }
    setImportiere(false);
    setVorschau([]);
    const text = `${n} Rechnung(en) mit ${pos} Positionen übernommen.` + (fehlerListe.length ? ` Fehler: ${fehlerListe.join("; ")}` : "");
    // KM-Stände nur für Tankpool (Vorgabe: bei Shell keine KM aus routecontrol)
    setMeldung({ ok: fehlerListe.length === 0, text: text + (nTankpool > 0 ? " KM-Stände werden aus routecontrol geholt …" : "") });
    if (nTankpool > 0) {
      try {
        const r = await tdb.syncTankKm();
        setMeldung({ ok: fehlerListe.length === 0, text: `${text} KM-Stände aus routecontrol: ${r.ok} ermittelt.` });
      } catch (err) {
        setMeldung({ ok: false, text: `${text} KM-Abruf aus routecontrol fehlgeschlagen (${err.message || err}) – später per Button „KM aus routecontrol holen“ nachholen.` });
      }
    }
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

  const datenMitKm = useMemo(() => mitTachoStrecken(daten), [daten]);
  const zr = useMemo(() => zeitraum(f), [f]);
  const imZeitraum = useMemo(
    () => datenMitKm.filter((t) => (!zr.start || t.datum >= zr.start) && (!zr.ende || t.datum <= zr.ende) && (f.lkw === "ALLE" || t.lkw === f.lkw)),
    [datenMitKm, zr, f.lkw]
  );
  // Tankdaten reichen nur bis zum Ende der letzten Sammelrechnung - km danach
  // dürfen nicht mitzählen, sonst wäre der Verbrauch zu niedrig.
  const abgedecktBis = useMemo(
    () => rechnungen.filter((r) => r.typ === "sammel" && r.quelle === "tankpool").reduce((m, r) => (r.datum > m ? r.datum : m), ""),
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
  const ausw = useMemo(() => auswerten(imZeitraum, lkwListe, km), [imZeitraum, lkwListe, km]);
  const proLkw = ausw.lkwRows;
  // Einsatzplan-Hinweis nur für LKW, die mangels Tachostand mit Einsatzplan-km rechnen
  const ausgelassenRelevant = ausgelassen.filter((w) => proLkw.some((r) => r.lkw === w.lkw && r.k.quelle === "einsatzplan"));

  const proMonat = useMemo(() => {
    const map = {};
    for (const t of imZeitraum) {
      const k = t.datum.slice(0, 7);
      (map[k] = map[k] || []).push(t);
    }
    return Object.keys(map).sort().reverse().map((k) => {
      const [j, m] = k.split("-").map(Number);
      const mz = { start: `${k}-01`, ende: isoOf(new Date(j, m, 0)) };
      const a = auswerten(map[k], lkwListe, kmJeLkw(wochenKm || [], kappe(mz)));
      return { monat: `${MONATE[m - 1]} ${j}`, ...summiere(map[k]), km: a.km, liter: a.liter, kosten: a.kosten, fallback: a.fallback };
    });
  }, [imZeitraum, lkwListe, wochenKm, abgedecktBis]);

  // KM-Stände aus routecontrol nachladen (für Tankungen ohne Ergebnis)
  const [kmSync, setKmSync] = useState(false);
  const ohneKm = daten.filter((t) => t.quelle !== "shell" && t.zeit && !t.kmRcStatus).length;
  async function kmHolen() {
    setKmSync(true);
    setMeldung(null);
    try {
      const r = await tdb.syncTankKm();
      setMeldung({ ok: true, text: `KM-Stände aus routecontrol: ${r.ok} ermittelt` + (r.keine_fahrten ? `, ${r.keine_fahrten} ohne Fahrten` : "") + (r.kein_fahrzeug ? `, ${r.kein_fahrzeug} Fahrzeug nicht in routecontrol` : "") + (r.fehler ? `, ${r.fehler} Fehler` : "") + "." });
    } catch (err) {
      setMeldung({ ok: false, text: "KM-Abruf fehlgeschlagen: " + (err.message || err) });
    }
    setKmSync(false);
    neuLaden();
  }

  const liste = useMemo(
    () => imZeitraum
      .filter((t) => (f.kategorie === "ALLE" || t.kategorie === f.kategorie) && (f.quelle === "ALLE" || t.quelle === f.quelle))
      .slice()
      .sort((a, b) => (b.datum + b.zeit).localeCompare(a.datum + a.zeit)),
    [imZeitraum, f.kategorie, f.quelle]
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
        <div style={h2}>Tankrechnungen hochladen (Tankpool, Shell)</div>
        <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 14 }}>
          Eine oder mehrere PDFs auf einmal auswählen – die Karte (Tankpool oder Shell) wird automatisch erkannt.
          Bei Shell werden nur Karten mit LKW-Kennzeichen aus dem Fuhrpark übernommen. Die Positionen werden direkt aus dem Text gelesen (keine KI) und
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
                  <tr><th>Datei</th><th>Karte</th><th>Rechnung</th><th>Datum</th><th style={{ textAlign: "right" }}>Positionen</th><th style={{ textAlign: "right" }}>Summe netto</th><th>Prüfung</th></tr>
                </thead>
                <tbody>
                  {vorschau.map((v, i) => {
                    const p = v.parsed;
                    const fremd = p ? Array.from(new Set(p.positionen.map((x) => x.lkw))).filter((x) => !fleetPlates.includes(x)) : [];
                    let status;
                    if (v.fehler) status = <span style={{ color: DANGER }}>{v.fehler}</span>;
                    else if (v.schonDa) status = <span style={{ color: TEXT_MUTED }}>schon importiert – wird übersprungen</span>;
                    else if (p.ueberspringen) status = <span style={{ color: TEXT_MUTED }}>{p.ueberspringen} – wird übersprungen</span>;
                    else if (p.summenAbweichung) status = <span style={{ color: DANGER }}><AlertTriangle size={13} /> Summe passt nicht ({euro(p.parsedSumme)} statt {euro(p.dokumentSumme)}) – wird nicht übernommen</span>;
                    else status = (
                      <span style={{ color: SUCCESS }}>
                        <CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> Summe stimmt
                        {p.quelle === "shell" && p.ignoriert?.anzahl > 0 && <span style={{ color: TEXT_MUTED }}> · {p.ignoriert.anzahl} Pos. anderer Karten ignoriert ({euro(p.ignoriert.summe)})</span>}
                        {fremd.length > 0 && <span style={{ color: AMBER_DARK }}> · nicht im Fuhrpark: {fremd.join(", ")}</span>}
                      </span>
                    );
                    return (
                      <tr key={i}>
                        <td style={{ fontSize: 12 }}>{v.dateiname}</td>
                        <td>{p ? <KarteBadge quelle={p.quelle} /> : "–"}</td>
                        <td className="mono">{p?.rechnungNr || "–"}</td>
                        <td className="mono">{p ? dmy(p.rechnungDatum) : "–"}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{p ? p.positionen.length : "–"}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{p ? euro(p.importSumme ?? p.parsedSumme) : "–"}</td>
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
        <div className="tank-filter-grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 10 }}>
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
            <label>Karte (Liste)</label>
            <select value={f.quelle} onChange={(e) => setF({ ...f, quelle: e.target.value })}>
              <option value="ALLE">Alle</option>
              <option value="tankpool">Tankpool</option>
              <option value="shell">Shell</option>
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
          <button className="ghost" onClick={() => setF({ jahr: String(heute.getFullYear()), monat: "ALLE", lkw: "ALLE", kategorie: "ALLE", quelle: "ALLE", von: "", bis: "" })}>Filter zurücksetzen</button>
          <button className="ghost" onClick={neuLaden} disabled={laden}><RefreshCw size={14} /> Neu laden</button>
          <button className="ghost" onClick={kmHolen} disabled={kmSync || laden} title="Tachostand zum Tankzeitpunkt aus routecontrol holen (nur Tankungen ohne KM-Stand)">
            {kmSync ? <Loader2 size={14} /> : <Gauge size={14} />} KM aus routecontrol holen{ohneKm > 0 ? ` (${ohneKm} offen)` : ""}
          </button>
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
            <Kpi label="Ø Verbrauch" value={l100(ausw.liter, ausw.km) ? `${dez(l100(ausw.liter, ausw.km), 1)} l/100 km` : "–"} sub={ausw.km > 0 ? `${Math.round(ausw.km).toLocaleString("de-DE")} km lt. Tacho${ausw.fallback ? " (teils Einsatzplan)" : ""}` : "keine km im Zeitraum"} />
            <Kpi label="Tankkosten pro km" value={proKm(ausw.kosten, ausw.km) ? `${dez(proKm(ausw.kosten, ausw.km), 3)} €/km` : "–"} sub="Diesel + AdBlue + Nebenkosten" />
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
                      <td className="mono" style={{ textAlign: "right" }} title={r.k.quelle === "tacho" ? "Tachostand routecontrol, von Tankung zu Tankung" : "kein Tachostand - Wochen-KM aus dem Einsatzplan"}>
                        {r.k.km > 0 ? `${r.k.quelle === "einsatzplan" ? "≈ " : ""}${Math.round(r.k.km).toLocaleString("de-DE")}` : "–"}
                      </td>
                      <td className="mono" style={{ textAlign: "right", fontWeight: 600, color: MARINE }}>{l100(r.k.liter, r.k.km) ? dez(l100(r.k.liter, r.k.km), 1) : "–"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{proKm(r.k.kosten, r.k.km) ? dez(proKm(r.k.kosten, r.k.km), 3) : "–"}</td>
                    </tr>
                  ))}
                  {proLkw.length === 0 && <tr><td colSpan={12} style={{ color: TEXT_MUTED }}>Keine Tankvorgänge im gewählten Zeitraum.</td></tr>}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 10 }}>
              km = Tachostand aus routecontrol von Tankung zu Tankung: l/100 km = getankte Liter ÷ km seit der vorherigen Tankung
              (die erste Tankung im Zeitraum zählt nur als Startpunkt). Shell-Tankungen haben keinen KM-Stand; ihre Liter
              zählen zur Strecke bis zur nächsten Tankpool-Tankung. „≈“ = kein Tachostand vorhanden, km aus dem Einsatzplan
              (Wochen anteilig nach Tagen{abgedecktBis && <>, nur bis {dmy(abgedecktBis)}</>}).
            </div>
            {ausgelassenRelevant.length > 0 && (
              <div style={{ fontSize: 12, color: AMBER_DARK, background: WARN_BG, borderRadius: 8, padding: "8px 12px", marginTop: 10 }}>
                <AlertTriangle size={13} style={{ verticalAlign: -2 }} /> Nicht mitgezählt, weil die Wochen-KM im Einsatzplan unplausibel sind
                (negativ oder über {MAX_WOCHEN_KM.toLocaleString("de-DE")} km) – bitte End-KM im Einsatzplan prüfen:{" "}
                {ausgelassenRelevant.map((w) => `${w.lkw} KW${w.kw}/${w.jahr} (${w.wochenKm.toLocaleString("de-DE")} km)`).join(", ")}
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
                        <td className="mono" style={{ textAlign: "right", fontWeight: 600, color: MARINE }}>{l100(r.liter, r.km) ? dez(l100(r.liter, r.km), 1) : "–"}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{proKm(r.kosten, r.km) ? dez(proKm(r.kosten, r.km), 3) : "–"}</td>
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
                    <th>Datum</th><th>Zeit</th><th>LKW</th><th>Karte</th><th>Station</th><th>Sorte</th>
                    <th style={{ textAlign: "right" }}>Menge</th><th style={{ textAlign: "right" }}>Preis netto</th><th style={{ textAlign: "right" }}>Wert netto</th>
                    <th style={{ textAlign: "right" }}>KM-Stand</th><th style={{ textAlign: "right" }}>km seit letzter</th><th>Rechnung</th>
                  </tr>
                </thead>
                <tbody>
                  {liste.map((t) => (
                    <tr key={t.id} style={t.kategorie === "neben" ? { background: WARN_BG } : undefined}>
                      <td className="mono">{dmy(t.datum)}</td>
                      <td className="mono">{t.zeit}</td>
                      <td className="mono">{t.lkw}</td>
                      <td><KarteBadge quelle={t.quelle} /></td>
                      <td>{t.station}</td>
                      <td>{t.kategorie === "neben" ? t.sorte : KATEGORIE_LABEL[t.kategorie]}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{dez(t.menge)} {t.einheit}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{t.einheit === "L" ? dez(t.preis, 4) : euro(t.preis)}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{euro(t.wert)}</td>
                      <td className="mono" style={{ textAlign: "right" }} title={t.quelle === "shell" ? "Shell: kein KM-Stand (Liter zählen zur Strecke bis zur nächsten Tankpool-Tankung)" : t.kmRc ? "Tachostand routecontrol" + (t.kmBeleg ? ` · an der Säule eingegeben: ${t.kmBeleg.toLocaleString("de-DE")}` : "") : t.kmBeleg ? "an der Säule eingegeben" : KM_STATUS[t.kmRcStatus] || "noch nicht abgerufen"}>
                        {t.kmRc ? t.kmRc.toLocaleString("de-DE") : t.kmBeleg ? <span style={{ color: TEXT_MUTED }}>{t.kmBeleg.toLocaleString("de-DE")}*</span> : <span style={{ color: TEXT_MUTED }}>–</span>}
                      </td>
                      <td className="mono" style={{ textAlign: "right", color: MARINE }} title={t.shellL ? `inkl. ${dez(t.shellL)} L Shell-Tankung(en) auf dieser Strecke` : undefined}>
                        {t.kmSeit ? t.kmSeit.toLocaleString("de-DE") : ""}{t.shellL ? <span style={{ color: "#7A5B00" }}> *</span> : null}
                      </td>
                      <td className="mono" style={{ fontSize: 12, color: TEXT_MUTED }}>{t.rechnungNr}</td>
                    </tr>
                  ))}
                  {liste.length === 0 && <tr><td colSpan={12} style={{ color: TEXT_MUTED }}>Keine Einträge.</td></tr>}
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
                  <thead><tr><th>Karte</th><th>Rechnung</th><th>Datum</th><th>Art</th><th style={{ textAlign: "right" }}>Summe netto</th><th>Datei</th><th>importiert</th><th></th></tr></thead>
                  <tbody>
                    {rechnungen.map((r) => (
                      <tr key={r.rechnungNr}>
                        <td><KarteBadge quelle={r.quelle} /></td>
                        <td className="mono">{r.rechnungNr}</td>
                        <td className="mono">{dmy(r.datum)}</td>
                        <td>{{ sammel: "Tankungen", einzel: "Einzelrechnung", gebuehren: "Service-Gebühren" }[r.typ] || r.typ}</td>
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
