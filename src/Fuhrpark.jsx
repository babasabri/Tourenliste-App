// Menüpunkt "Fuhrpark": fasst die fahrzeugbezogenen Seiten unter einem Dach
// zusammen (Reiter Übersicht · Tankvorgänge · Maut · Ersatzteile).
//
// Zeitraum- und LKW-Filter werden zwischen den Reitern weitergegeben: wer sich
// im Reiter Tankvorgänge den OF RY 500 im August ansieht und auf Maut wechselt,
// sieht dort ebenfalls OF RY 500 im August.
//
// Die Übersicht stellt je LKW alle Kosten (in vier Gruppen: Fahren, Fahrzeug,
// Fahrer, Gemeinkosten) neben km und Umsatz: Kennzahlen, LKW-Vergleich je km
// als Balken und eine kompakte Tabelle mit aufklappbaren Kostenarten. Weil die Quellen unterschiedlich aktuell sind (Maut kommt z. B. nur
// monatlich), wertet die Übersicht nur bis zu dem Tag aus, bis zu dem Tank-
// UND Mautdaten vorliegen - sonst zählten km ohne die zugehörigen Kosten.

import { useEffect, useMemo, useState } from "react";
import { LayoutGrid, Fuel, Coins, Wrench, KeyRound, ShieldCheck, Users, Building2, Landmark, Loader2, RefreshCw, Info, ChevronRight, ChevronDown, CheckCircle2, AlertTriangle } from "lucide-react";
import Tankvorgaenge from "./Tankvorgaenge";
import Maut from "./Maut";
import Ersatzteile from "./Ersatzteile";
import Leasing from "./Leasing";
import Abgaben from "./Abgaben";
import FahrerKosten from "./FahrerKosten";
import Gemeinkosten from "./Gemeinkosten";
import Factoring from "./Factoring";
import * as tdb from "./tankDb";
import * as mdb from "./mautDb";
import * as edb from "./ersatzteilDb";
import * as ldb from "./leasingDb";
import * as adb from "./abgabenDb";
import * as fdb from "./fahrerKostenDb";
import * as abwDb from "./abwesenheitDb";
import * as gdb from "./gemeinkostenDb";
import * as fadb from "./factoringDb";
import { MAUT_START } from "./mautParser";

const MARINE = "#0F2A43";
const AMBER = "#F2A63C";
const AMBER_DARK = "#8A5A10";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT = "#16232E";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS = "#2F8F6B";
const WARN_BG = "#FDF1DD";

const AUFLIEGER = "Auflieger";
const REITER = [
  { id: "uebersicht", label: "Übersicht", icon: LayoutGrid },
  { id: "tanken", label: "Tankvorgänge", icon: Fuel },
  { id: "maut", label: "Maut", icon: Coins },
  { id: "ersatzteile", label: "Werkstatt & Teile", icon: Wrench },
  { id: "leasing", label: "Leasing/Miete", icon: KeyRound },
  { id: "abgaben", label: "Laufende Kosten", icon: ShieldCheck },
  { id: "fahrer", label: "Fahrerkosten", icon: Users },
  { id: "gemein", label: "Gemeinkosten", icon: Building2 },
  { id: "factoring", label: "Factoring", icon: Landmark },
];
const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dmy = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const euro = (n) => (n === null || n === undefined || !Number.isFinite(n) ? "–" : n.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }));
const dez = (n, s = 3) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { minimumFractionDigits: s, maximumFractionDigits: s }) : "–");
const kmTxt = (n) => (n > 0 ? Math.round(n).toLocaleString("de-DE") : "–");

function isoWeekMonday(jahr, kw) {
  const d = new Date(jahr, 0, 4);
  const dayNr = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayNr + (kw - 1) * 7);
  return d;
}
// wie Tankvorgänge/Maut: unplausible Einsatzplan-Wochen nicht mitzählen
const MAX_WOCHEN_KM = 4500;
function kmJeLkw(wochen, start, ende) {
  const map = {};
  for (const w of wochen || []) {
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

function zeitraum(f) {
  let start = null, ende = null;
  if (f.jahr !== "ALLE") {
    const j = Number(f.jahr);
    if (f.monat !== "ALLE") {
      const m = Number(f.monat);
      start = `${j}-${pad2(m)}-01`;
      ende = isoOf(new Date(j, m, 0));
    } else { start = `${j}-01-01`; ende = `${j}-12-31`; }
  }
  if (f.von && (!start || f.von > start)) start = f.von;
  if (f.bis && (!ende || f.bis < ende)) ende = f.bis;
  return { start, ende };
}

function Kpi({ label, value, sub, accent }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: TEXT_MUTED, fontWeight: 500 }}>{label}</div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 600, color: accent || MARINE, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const card = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 20 };
const h2 = { fontSize: 15, fontWeight: 600, marginBottom: 12, color: TEXT };
const right = { textAlign: "right" };

// ------------------------------------------------------------- Übersicht
function Uebersicht({ fleet, tours, wochenKm, umsatzVon, startFilter, onFilterChange }) {
  const fleetPlates = useMemo(() => (fleet || []).map((f) => f.plate), [fleet]);
  const heute = new Date();
  const leer = { jahr: String(heute.getFullYear()), monat: "ALLE", lkw: "ALLE", von: "", bis: "" };
  const [f, setF] = useState({ ...leer, ...(startFilter || {}) });
  useEffect(() => { onFilterChange && onFilterChange(f); }, [f.jahr, f.monat, f.lkw, f.von, f.bis]);

  const [tank, setTank] = useState([]);
  const [tankRe, setTankRe] = useState([]);
  const [maut, setMaut] = useState([]);
  const [teile, setTeile] = useState([]);
  const [raten, setRaten] = useState([]);
  const [vertraege, setVertraege] = useState([]);
  const [abgaben, setAbgaben] = useState([]);
  const [fahrerKosten, setFahrerKosten] = useState([]);
  const [rollen, setRollen] = useState({});
  const [abw, setAbw] = useState([]);
  const [gemein, setGemein] = useState([]);
  const [faAbr, setFaAbr] = useState([]);
  const [faZins, setFaZins] = useState([]);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");

  async function neuLaden() {
    setLaden(true);
    setFehler("");
    try {
      const [t, tr, m, e, lr, lf, ab, fk, ro, aw, gk, fa, fz] = await Promise.all([tdb.fetchTankvorgaenge(), tdb.fetchTankpoolRechnungen(), mdb.fetchMautPositionen(), edb.fetchPositionen(), ldb.fetchRaten(), ldb.fetchFahrzeuge(), adb.fetchAbgaben(), fdb.fetchKosten(), fdb.fetchRollen(), abwDb.fetchAbwesenheiten().catch(() => []), gdb.fetchKosten().catch(() => []), fadb.fetchAbrechnungen().catch(() => []), fadb.fetchZinsen().catch(() => [])]);
      setTank(t);
      setTankRe(tr);
      setMaut(m.filter((x) => x.datum >= MAUT_START));
      setTeile(e);
      setRaten(lr);
      setVertraege(lf);
      setAbgaben(ab);
      setFahrerKosten(fk);
      setRollen(ro);
      setAbw(aw);
      setGemein(gk);
      setFaAbr(fa);
      setFaZins(fz);
    } catch (err) {
      setFehler("Daten konnten nicht geladen werden: " + (err.message || err));
    }
    setLaden(false);
  }
  useEffect(() => { neuLaden(); }, []);

  // Bis wann liegen Tank- UND Mautdaten vor?
  const tankBis = useMemo(() => tankRe.filter((r) => r.typ === "sammel" && r.quelle === "tankpool").reduce((m, r) => (r.datum > m ? r.datum : m), ""), [tankRe]);
  const mautBis = useMemo(() => {
    // je LKW das letzte Mautdatum; maßgeblich ist das früheste davon unter den
    // eigenen LKW (Miet-LKW kommen separat und dürfen nicht nach vorne ziehen)
    const proLkw = {};
    for (const x of maut) if (!proLkw[x.lkw] || x.datum > proLkw[x.lkw]) proLkw[x.lkw] = x.datum;
    const eigene = fleetPlates.filter((p) => proLkw[p] && /^OF /.test(p)).map((p) => proLkw[p]);
    const alle = eigene.length ? eigene : Object.values(proLkw);
    return alle.length ? alle.reduce((m, d) => (d < m ? d : m)) : "";
  }, [maut, fleetPlates]);
  const teileBis = useMemo(() => teile.reduce((m, t) => (t.datum > m ? t.datum : m), ""), [teile]);
  const datenBis = [tankBis, mautBis].filter(Boolean).reduce((m, d) => (!m || d < m ? d : m), "");

  const zr = useMemo(() => zeitraum(f), [f]);
  const gekappt = !!(datenBis && (!zr.ende || zr.ende > datenBis));
  const ende = gekappt ? datenBis : zr.ende;
  const start = zr.start;
  const drin = (d) => d && (!start || d >= start) && (!ende || d <= ende);

  const auswertung = useMemo(() => {
    const zeilen = {};
    const z = (lkw) => (zeilen[lkw] = zeilen[lkw] || { lkw, km: 0, umsatz: 0, touren: 0, diesel: 0, neben: 0, maut: 0, teile: 0, leasing: 0, versSteuer: 0, fahrer: 0, gemein: 0, factoring: 0 });
    for (const t of tank) if (drin(t.datum)) { const r = z(t.lkw); if (t.kategorie === "neben") r.neben += t.wert; else r.diesel += t.wert; }
    for (const m of maut) if (drin(m.datum)) z(m.lkw).maut += m.betrag;
    let lager = 0, offen = 0;
    for (const e of teile) {
      if (!drin(e.datum)) continue;
      const b = e.netto + e.pfand;
      if (!e.lkw) offen += b;
      else if (e.lkw === "Lager") lager += b;
      else z(e.lkw).teile += b;
    }
    for (const t of tours || []) if (drin(t.datum) && t.lkw) { const r = z(t.lkw); r.umsatz += umsatzVon(t); r.touren++; }
    const km = kmJeLkw(wochenKm, start, ende);
    for (const [lkw, k] of Object.entries(km)) z(lkw).km += k;
    // Auflieger (Leasing/Miete mit Fahrzeugart "Auflieger") gesammelt in einer Zeile
    // Auflieger mit festem LKW zählen dort mit (ab "seit"), sonst in der Sammelzeile
    for (const [ziel, b] of Object.entries(ldb.leasingJeZiel(raten, vertraege, start, ende, AUFLIEGER))) z(ziel).leasing += b;
    for (const [lkw, b] of Object.entries(adb.abgabenJeLkw(abgaben, start, ende))) z(lkw).versSteuer += b.versicherung + b.steuer + b.telematik;
    let fahrerOffen = 0, verwaltung = 0;
    for (const [lkw, b] of Object.entries(fdb.jeLkw(fahrerKosten, wochenKm, start, ende, { touren: tours, rollen, abwesenheiten: abw }))) {
      if (lkw === fdb.OFFEN) fahrerOffen += b;
      else if (lkw === fdb.VERWALTUNG) verwaltung += b;
      else z(lkw).fahrer += b;
    }
    for (const [lkw, b] of Object.entries(gdb.jeLkw(gemein, fleet, vertraege, start, ende))) z(lkw).gemein += b;
    for (const [lkw, b] of Object.entries(fadb.jeLkw(faAbr, faZins, start, ende, { tours, umsatzVon, fleet, vertraege }))) z(lkw).factoring += b;
    const reihenfolge = [...fleetPlates, ...Object.keys(zeilen).filter((p) => !fleetPlates.includes(p) && p !== AUFLIEGER).sort(), AUFLIEGER];
    const rows = reihenfolge.map((p) => zeilen[p]).filter((r) => r && (r.km || r.umsatz || r.diesel || r.neben || r.maut || r.teile || r.leasing || r.versSteuer || r.fahrer || r.gemein || r.factoring))
      .filter((r) => f.lkw === "ALLE" ? true : r.lkw === f.lkw)
      .map((r) => ({ ...r, kosten: r.diesel + r.neben + r.maut + r.teile + r.leasing + r.versSteuer + r.fahrer + r.gemein + r.factoring }));
    const sum = rows.reduce((s, r) => {
      for (const k of ["km", "umsatz", "touren", "diesel", "neben", "maut", "teile", "leasing", "versSteuer", "fahrer", "gemein", "factoring", "kosten"]) s[k] += r[k];
      return s;
    }, { km: 0, umsatz: 0, touren: 0, diesel: 0, neben: 0, maut: 0, teile: 0, leasing: 0, versSteuer: 0, fahrer: 0, gemein: 0, factoring: 0, kosten: 0 });
    return { rows, sum, lager: f.lkw === "ALLE" ? lager : 0, offen: f.lkw === "ALLE" ? offen : 0, fahrerOffen: f.lkw === "ALLE" ? fahrerOffen : 0, verwaltung: f.lkw === "ALLE" ? verwaltung : 0 };
  }, [tank, maut, teile, raten, vertraege, abgaben, fahrerKosten, rollen, abw, gemein, faAbr, faZins, fleet, tours, wochenKm, start, ende, f.lkw, fleetPlates]);

  // Verlauf je Monat (Kosten nach Quelle), gleiche Kappung
  const proMonat = useMemo(() => {
    const map = {};
    const m = (d) => (map[d.slice(0, 7)] = map[d.slice(0, 7)] || { diesel: 0, neben: 0, maut: 0, teile: 0, leasing: 0, versSteuer: 0, fahrer: 0, gemein: 0, factoring: 0, umsatz: 0 });
    const lkwOk = (l) => f.lkw === "ALLE" || l === f.lkw;
    for (const t of tank) if (drin(t.datum) && lkwOk(t.lkw)) { const r = m(t.datum); if (t.kategorie === "neben") r.neben += t.wert; else r.diesel += t.wert; }
    for (const x of maut) if (drin(x.datum) && lkwOk(x.lkw)) m(x.datum).maut += x.betrag;
    for (const e of teile) if (drin(e.datum) && e.lkw && e.lkw !== "Lager" && lkwOk(e.lkw)) m(e.datum).teile += e.netto + e.pfand;
    for (const t of tours || []) if (drin(t.datum) && lkwOk(t.lkw)) m(t.datum).umsatz += umsatzVon(t);
    for (const r of raten) {
      for (const [ziel, anteil] of Object.entries(ldb.leasingJeZiel([r], vertraege, start, ende, AUFLIEGER))) {
        if (lkwOk(ziel) && anteil) m(`${r.monat}-01`).leasing += anteil;
      }
    }
    for (const a of fdb.verteilen(fahrerKosten, wochenKm, start, ende, { touren: tours, rollen, abwesenheiten: abw })) {
      if (a.lkw === fdb.OFFEN || a.lkw === fdb.VERWALTUNG || !lkwOk(a.lkw) || !a.betrag) continue;
      m(`${a.monat}-01`).fahrer += a.betrag;
    }
    for (const a of gdb.verteilen(gemein, fleet, vertraege, start, ende)) {
      if (!lkwOk(a.lkw) || !a.betrag) continue;
      m(`${a.monat}-01`).gemein += a.betrag;
    }
    for (const a of fadb.verteilen(faAbr, faZins, start, ende, { tours, umsatzVon, fleet, vertraege })) {
      if (!lkwOk(a.lkw) || !a.betrag) continue;
      m(`${a.monat}-01`).factoring += a.betrag;
    }
    // Versicherung/Steuer: je Kalendermonat tagesgenau verteilen
    for (const x of abgaben) {
      if (!lkwOk(x.kennzeichen)) continue;
      let ms = `${x.von.slice(0, 7)}-01`;
      while (ms <= x.bis) {
        const [j, mo] = ms.split("-").map(Number);
        const me = isoOf(new Date(j, mo, 0));
        const a = [ms, start].filter(Boolean).reduce((p, q) => (q > p ? q : p));
        const e = [me, ende].filter(Boolean).reduce((p, q) => (q < p ? q : p));
        const anteil = adb.abgabenJeLkw([x], a, e)[x.kennzeichen];
        if (anteil && a <= e) m(ms).versSteuer += anteil.versicherung + anteil.steuer + anteil.telematik;
        ms = isoOf(new Date(j, mo, 1));
      }
    }
    return Object.keys(map).sort().reverse().map((k) => {
      const [j, mo] = k.split("-").map(Number);
      const ms = `${k}-01`, me = isoOf(new Date(j, mo, 0));
      const kmMap = kmJeLkw(wochenKm, start && start > ms ? start : ms, ende && ende < me ? ende : me);
      const km = f.lkw === "ALLE" ? Object.values(kmMap).reduce((s, v) => s + v, 0) : kmMap[f.lkw] || 0;
      const r = map[k];
      return { monat: `${MONATE[mo - 1]} ${j}`, ...r, kosten: r.diesel + r.neben + r.maut + r.teile + r.leasing + r.versSteuer + r.fahrer + r.gemein + r.factoring, km };
    });
  }, [tank, maut, teile, raten, vertraege, abgaben, fahrerKosten, rollen, abw, gemein, faAbr, faZins, fleet, tours, wochenKm, start, ende, f.lkw]);

  const jahre = useMemo(() => {
    const s = new Set([...tank, ...maut].map((t) => (t.datum || "").slice(0, 4)).filter(Boolean));
    s.add(String(heute.getFullYear()));
    return Array.from(s).sort().reverse();
  }, [tank, maut]);
  const lkwListe = useMemo(() => {
    const andere = Array.from(new Set([...tank, ...maut].map((t) => t.lkw))).filter((p) => p && !fleetPlates.includes(p)).sort();
    return [...fleetPlates, ...andere];
  }, [tank, maut, fleetPlates]);

  const { rows, sum } = auswertung;
  // Schlussraten (Einmalzahlung bei Übernahme ins Eigentum) - getrennt, nicht in Kosten/km
  const schlussraten = vertraege.filter((v) => v.schlussrateBetrag && v.schlussrateDatum && drin(v.schlussrateDatum) && (f.lkw === "ALLE" || v.kennzeichen === f.lkw));
  const proKm = (e, k) => (k > 0 ? e / k : null);

  // ---- Zeitraum-Schnellwahl (bildet auf jahr/monat/von/bis ab, damit der
  // gemeinsame Filter der anderen Reiter unverändert funktioniert)
  const J = f.jahr === "ALLE" ? null : Number(f.jahr);
  const quartal = (j, q) => ({ von: `${j}-${pad2(q * 3 - 2)}-01`, bis: isoOf(new Date(j, q * 3, 0)) });
  const zrWahl = (() => {
    if (f.von || f.bis) {
      for (let q = 1; q <= 4; q++) if (J && f.monat === "ALLE" && f.von === quartal(J, q).von && f.bis === quartal(J, q).bis) return `q${q}`;
      return "eigen";
    }
    if (f.monat !== "ALLE") return `m${f.monat}`;
    return "jahr";
  })();
  function setZr(v, jahr = f.jahr) {
    const j = jahr === "ALLE" ? null : Number(jahr);
    if (v === "jahr") return setF({ ...f, jahr, monat: "ALLE", von: "", bis: "" });
    if (v === "eigen") return setF({ ...f, jahr, monat: "ALLE", von: f.von || start || (j ? `${j}-01-01` : ""), bis: f.bis || zr.ende || (j ? `${j}-12-31` : "") });
    if (!j) return;
    if (v.startsWith("q")) return setF({ ...f, jahr, monat: "ALLE", ...quartal(j, Number(v.slice(1))) });
    if (v.startsWith("m")) return setF({ ...f, jahr, monat: v.slice(1), von: "", bis: "" });
  }
  function letzterMonat() {
    const d = new Date(heute.getFullYear(), heute.getMonth() - 1, 1);
    setF({ ...f, jahr: String(d.getFullYear()), monat: String(d.getMonth() + 1), von: "", bis: "" });
  }

  // ---- Datenstand je Quelle
  const faBis = faAbr.reduce((m, a) => (a.datum > m ? a.datum : m), "");
  const zielEnde = zr.ende && zr.ende < isoOf(heute) ? zr.ende : isoOf(heute);
  const quellen = [
    { label: "Tankpool", bis: tankBis, kappt: true },
    { label: "Maut", bis: mautBis, kappt: true },
    { label: "Werkstatt", bis: teileBis },
    { label: "Factoring", bis: faBis },
  ];

  // ---- Kostengruppen
  const gruppen = (r) => [
    { id: "fahren", label: "Fahren", farbe: AMBER, wert: r.diesel + r.neben + r.maut, teile: [["Diesel + AdBlue", r.diesel], ["Maut", r.maut], ["Tank-Nebenkosten", r.neben]] },
    { id: "fahrzeug", label: "Fahrzeug", farbe: "#3D6B8C", wert: r.teile + r.leasing + r.versSteuer, teile: [["Werkstatt & Teile", r.teile], ["Leasing/Miete", r.leasing], ["Versicherung, Steuer, Telematik", r.versSteuer]] },
    { id: "fahrer", label: "Fahrer", farbe: "#86AECB", wert: r.fahrer, teile: [["Fahrerkosten", r.fahrer]] },
    { id: "gemein", label: "Gemeinkosten", farbe: "#C7D1DB", wert: r.gemein + r.factoring, teile: [["Gemeinkosten", r.gemein], ["Factoring", r.factoring]] },
  ];
  const GRUPPEN_LEGENDE = gruppen(sum);
  const ergebnis = (r) => r.umsatz - r.kosten;
  const marge = (r) => (r.umsatz ? (ergebnis(r) / r.umsatz) * 100 : null);
  // Grafik: nur LKW mit km; sortiert nach Ergebnis
  const mitKm = rows.filter((r) => r.km > 0).sort((a, b) => ergebnis(b) - ergebnis(a));
  const skala = Math.max(0.01, ...mitKm.map((r) => Math.max(proKm(r.kosten, r.km) || 0, proKm(r.umsatz, r.km) || 0))) * 1.08;
  const [offenZeile, setOffenZeile] = useState(null);
  const tabRows = [...rows].sort((a, b) => {
    // eigene Fahrzeuge zuerst (Fuhrpark-Reihenfolge), Auflieger zuletzt
    const ia = a.lkw === AUFLIEGER ? 999 : fleetPlates.indexOf(a.lkw) === -1 ? 500 : fleetPlates.indexOf(a.lkw);
    const ib = b.lkw === AUFLIEGER ? 999 : fleetPlates.indexOf(b.lkw) === -1 ? 500 : fleetPlates.indexOf(b.lkw);
    return ia - ib;
  });
  const geldFarbe = (x) => (x >= 0 ? SUCCESS : DANGER);
  const pkm = (x) => (Number.isFinite(x) ? `${dez(x, 2)} €` : "–");

  function Aufschluesselung({ r }) {
    return (
      <div className="fp-detail" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, padding: "6px 4px 10px" }}>
        {gruppen(r).map((g) => (
          <div key={g.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: TEXT, marginBottom: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: g.farbe, display: "inline-block" }} /> {g.label}
              <span className="mono" style={{ marginLeft: "auto" }}>{euro(g.wert)}</span>
            </div>
            {g.teile.map(([name, w]) => (
              <div key={name} style={{ display: "flex", fontSize: 11.5, color: TEXT_MUTED, padding: "1px 0 1px 16px", gap: 8 }}>
                <span style={{ flex: 1 }}>{name}</span>
                <span className="mono">{w ? euro(w) : "–"}</span>
                <span className="mono" style={{ width: 62, textAlign: "right" }}>{r.km > 0 && w ? `${dez(w / r.km, 3)}` : ""}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* ------------------------------------------------ A: Zeitraum + Datenstand */}
      <div style={{ ...card, padding: "14px 18px" }}>
        <div className="fp-filter-row" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ width: 110 }}>
            <label>Jahr</label>
            <select value={f.jahr} onChange={(e) => (zrWahl.startsWith("q") || zrWahl.startsWith("m") ? setZr(zrWahl, e.target.value) : setF({ ...f, jahr: e.target.value, von: "", bis: "", monat: "ALLE" }))}>
              <option value="ALLE">Alle</option>
              {jahre.map((j) => <option key={j} value={j}>{j}</option>)}
            </select>
          </div>
          <div style={{ width: 170 }}>
            <label>Zeitraum</label>
            <select value={zrWahl} onChange={(e) => setZr(e.target.value)}>
              <option value="jahr">{J ? "Ganzes Jahr" : "Gesamter Zeitraum"}</option>
              {J && <optgroup label="Quartal">{[1, 2, 3, 4].map((q) => <option key={q} value={`q${q}`}>{q}. Quartal</option>)}</optgroup>}
              {J && <optgroup label="Monat">{MONATE.map((m, i) => <option key={m} value={`m${i + 1}`}>{m}</option>)}</optgroup>}
              <option value="eigen">Eigener Zeitraum …</option>
            </select>
          </div>
          {zrWahl === "eigen" && (
            <>
              <div style={{ width: 150 }}><label>von</label><input type="date" value={f.von} onChange={(e) => setF({ ...f, von: e.target.value })} /></div>
              <div style={{ width: 150 }}><label>bis</label><input type="date" value={f.bis} onChange={(e) => setF({ ...f, bis: e.target.value })} /></div>
            </>
          )}
          <div style={{ width: 150 }}>
            <label>LKW</label>
            <select value={f.lkw} onChange={(e) => setF({ ...f, lkw: e.target.value })}>
              <option value="ALLE">Alle LKW</option>
              {lkwListe.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="fp-filter-btns" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="ghost" onClick={() => setF(leer)} title="Dieses Jahr, alle LKW">Dieses Jahr</button>
            <button className="ghost" onClick={letzterMonat}>Letzter Monat</button>
            <button className="ghost" onClick={neuLaden} disabled={laden} title="Daten neu laden"><RefreshCw size={14} /></button>
          </div>
        </div>
        {!laden && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 12, fontSize: 12 }}>
            <span style={{ color: TEXT_MUTED, marginRight: 2 }}>Datenstand:</span>
            {quellen.map((q) => {
              const fehlt = !q.bis;
              const alt = q.bis && q.bis < zielEnde;
              const warn = q.kappt && (fehlt || alt);
              return (
                <span key={q.label} title={q.kappt ? "Begrenzt die Auswertung: ausgewertet wird nur bis zum frühesten dieser Stände" : "Letzter Beleg"}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 9px", borderRadius: 20, border: `1px solid ${warn ? "#F0D3A1" : BORDER}`, background: warn ? WARN_BG : "#F7F9FB", color: warn ? AMBER_DARK : TEXT }}>
                  {warn ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} color={SUCCESS} />}
                  {q.label} <b className="mono" style={{ fontWeight: 600 }}>{q.bis ? dmy(q.bis).slice(0, 6) : "–"}</b>
                </span>
              );
            })}
            {gekappt && (
              <span style={{ marginLeft: 4, color: AMBER_DARK }}>
                → ausgewertet bis <b>{dmy(datenBis)}</b> (danach fehlen noch Tank- oder Mautdaten)
              </span>
            )}
          </div>
        )}
      </div>

      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}

      {laden ? (
        <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Fuhrparkdaten …</div>
      ) : (
        <>
          {/* ------------------------------------------------ B: Kennzahlen */}
          <div className="fp-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 12 }}>
            <Kpi label="Umsatz" value={euro(sum.umsatz)} sub={`${sum.touren.toLocaleString("de-DE")} Touren · ${kmTxt(sum.km)} km`} />
            <Kpi label="Kosten" value={euro(sum.kosten)} sub={`davon Gemeinkosten + Factoring ${euro(sum.gemein + sum.factoring)}`} />
            <Kpi label="Ergebnis" value={euro(ergebnis(sum))} accent={geldFarbe(ergebnis(sum))}
              sub={marge(sum) !== null ? `${marge(sum) >= 0 ? "+" : ""}${Math.round(marge(sum))} % vom Umsatz` : null} />
            <Kpi label="Je Kilometer" accent={geldFarbe(ergebnis(sum))}
              value={sum.km > 0 ? `${ergebnis(sum) >= 0 ? "+" : ""}${dez(proKm(ergebnis(sum), sum.km), 2)} €` : "–"}
              sub={sum.km > 0 ? `Umsatz ${dez(proKm(sum.umsatz, sum.km), 2)} € − Kosten ${dez(proKm(sum.kosten, sum.km), 2)} €` : "keine km im Zeitraum"} />
          </div>
          {sum.kosten > 0 && (
            <div style={{ ...card, padding: "12px 16px", marginBottom: 20 }}>
              <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", background: "#EEF1F4" }}>
                {GRUPPEN_LEGENDE.map((g) => g.wert > 0 && <div key={g.id} title={`${g.label}: ${euro(g.wert)}`} style={{ width: `${(g.wert / sum.kosten) * 100}%`, background: g.farbe }} />)}
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8, fontSize: 12, color: TEXT }}>
                {GRUPPEN_LEGENDE.map((g) => (
                  <span key={g.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: g.farbe }} />
                    {g.label} <b className="mono">{Math.round((g.wert / sum.kosten) * 100)} %</b>
                    <span style={{ color: TEXT_MUTED }} className="mono">{euro(g.wert)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ------------------------------------------------ C: LKW-Vergleich */}
          {mitKm.length > 0 && (
            <div style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                <div style={{ ...h2, marginBottom: 2 }}>LKW-Vergleich je Kilometer</div>
                <div style={{ fontSize: 11.5, color: TEXT_MUTED, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  {GRUPPEN_LEGENDE.map((g) => <span key={g.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: g.farbe }} />{g.label}</span>)}
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 3, height: 14, background: SUCCESS, borderRadius: 1 }} />Umsatz/km</span>
                </div>
              </div>
              <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 14 }}>Balken = Kosten pro km, grüner Strich = Umsatz pro km (€). Liegt der Strich rechts vom Balken, verdient der LKW Geld. Sortiert nach Ergebnis, rechts das Ergebnis im Zeitraum.</div>
              {mitKm.map((r) => {
                const ckm = proKm(r.kosten, r.km), ukm = proKm(r.umsatz, r.km), e = ergebnis(r);
                return (
                  <div key={r.lkw} className="fp-bar-row" style={{ display: "grid", gridTemplateColumns: "92px 1fr 170px", gap: 12, alignItems: "center", padding: "7px 0", borderTop: `1px solid #F0F2F5`, cursor: "pointer" }}
                    onClick={() => setOffenZeile(offenZeile === r.lkw ? null : r.lkw)} title="Klicken: Kostenarten in der Tabelle unten aufklappen">
                    <div className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{r.lkw}</div>
                    <div style={{ position: "relative", height: 22 }}>
                      <div style={{ position: "absolute", inset: "3px 0", display: "flex", borderRadius: 4, overflow: "hidden", width: `${(ckm / skala) * 100}%` }}>
                        {gruppen(r).map((g) => g.wert > 0 && <div key={g.id} title={`${g.label}: ${dez(g.wert / r.km, 3)} €/km (${euro(g.wert)})`} style={{ width: `${(g.wert / r.kosten) * 100}%`, background: g.farbe }} />)}
                      </div>
                      {ukm !== null && <div title={`Umsatz ${dez(ukm, 3)} €/km`} style={{ position: "absolute", top: 0, bottom: 0, left: `calc(${(ukm / skala) * 100}% - 1.5px)`, width: 3, background: SUCCESS, borderRadius: 1 }} />}
                    </div>
                    <div className="mono" style={{ fontSize: 12, textAlign: "right", lineHeight: 1.35 }}>
                      <div style={{ color: TEXT_MUTED, fontSize: 11 }}>Kosten {dez(ckm, 2)} · Umsatz {ukm !== null ? dez(ukm, 2) : "–"}</div>
                      <div style={{ fontWeight: 600, color: geldFarbe(e) }}>{e >= 0 ? "+" : ""}{euro(e)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ------------------------------------------------ D: kompakte Tabelle */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <div style={h2}>Kosten je LKW</div>
              <div style={{ fontSize: 12, color: TEXT_MUTED }}>Zeile anklicken = Kostenarten aufklappen</div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 22 }}></th><th>LKW</th><th style={right}>km</th><th style={right}>Umsatz</th><th style={right}>Kosten</th><th style={right}>Ergebnis</th>
                    <th style={right}>Umsatz/km</th><th style={right}>Kosten/km</th><th style={right}>Marge</th>
                  </tr>
                </thead>
                <tbody>
                  {[...tabRows, ...(rows.length > 1 ? [{ ...sum, lkw: "__SUMME__" }] : [])].map((r) => {
                    const summe = r.lkw === "__SUMME__";
                    const offen = offenZeile === r.lkw;
                    const e = ergebnis(r), m = marge(r);
                    const fett = summe ? { fontWeight: 700 } : {};
                    return [
                      <tr key={r.lkw} onClick={() => setOffenZeile(offen ? null : r.lkw)} style={{ cursor: "pointer", background: offen ? "#F7F9FB" : undefined, ...(summe ? { borderTop: `2px solid ${BORDER}` } : {}) }}>
                        <td style={{ color: TEXT_MUTED }}>{offen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                        <td className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                          {summe ? <span style={{ fontFamily: "inherit" }}>Summe</span> : r.lkw}
                          {r.lkw === AUFLIEGER
                            ? <div style={{ fontSize: 10.5, color: TEXT_MUTED, fontWeight: 400 }}>ohne festen LKW</div>
                            : !summe && !fleetPlates.includes(r.lkw) && <div style={{ fontSize: 10.5, color: TEXT_MUTED, fontWeight: 400 }}>nicht im Fuhrpark</div>}
                        </td>
                        <td className="mono" style={{ ...right, ...fett }}>{kmTxt(r.km)}</td>
                        <td className="mono" style={{ ...right, ...fett }}>{euro(r.umsatz)}</td>
                        <td className="mono" style={{ ...right, ...fett }}>{euro(r.kosten)}</td>
                        <td className="mono" style={{ ...right, fontWeight: 600, color: geldFarbe(e) }}>{euro(e)}</td>
                        <td className="mono" style={{ ...right, ...fett }}>{proKm(r.umsatz, r.km) ? dez(proKm(r.umsatz, r.km)) : "–"}</td>
                        <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE }}>{proKm(r.kosten, r.km) ? dez(proKm(r.kosten, r.km)) : "–"}</td>
                        <td className="mono" style={{ ...right, color: m === null ? TEXT_MUTED : geldFarbe(m) }}>{m === null ? "–" : `${Math.round(m)} %`}</td>
                      </tr>,
                      offen && (
                        <tr key={r.lkw + "-d"} style={{ background: "#F7F9FB" }}>
                          <td></td>
                          <td colSpan={8}>
                            <Aufschluesselung r={r} />
                            <div style={{ fontSize: 11, color: TEXT_MUTED, padding: "0 4px 4px" }}>Beträge netto · rechte Spalte: € je km</div>
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                  {rows.length === 0 && <tr><td colSpan={9} style={{ color: TEXT_MUTED }}>Keine Daten im gewählten Zeitraum.</td></tr>}
                </tbody>
              </table>
            </div>
            {(auswertung.lager !== 0 || auswertung.offen !== 0 || auswertung.fahrerOffen > 0.5 || auswertung.verwaltung > 0.5 || schlussraten.length > 0) && (
              <div style={{ fontSize: 12, color: TEXT, marginTop: 10, lineHeight: 1.6 }}>
                <b>Nicht in den Kosten enthalten:</b>{" "}
                {[
                  auswertung.lager !== 0 && `Werkstatt-Lager ${euro(auswertung.lager)}`,
                  auswertung.offen !== 0 && `Werkstatt ohne Fahrzeug ${euro(auswertung.offen)}`,
                  auswertung.fahrerOffen > 0.5 && `Fahrerkosten ohne LKW im Einsatzplan ${euro(auswertung.fahrerOffen)}`,
                  auswertung.verwaltung > 0.5 && `Personal Verwaltung/Büro ${euro(auswertung.verwaltung)}`,
                  schlussraten.length > 0 && `Schlussraten ${schlussraten.map((v) => `${v.kennzeichen} ${euro(v.schlussrateBetrag)} (${dmy(v.schlussrateDatum)})`).join(", ")}`,
                ].filter(Boolean).join(" · ")}
              </div>
            )}
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontSize: 12.5, color: MARINE, fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 6 }}><Info size={13} /> So wird gerechnet</summary>
              <ul style={{ fontSize: 12, color: TEXT_MUTED, lineHeight: 1.6, margin: "8px 0 0", paddingLeft: 18 }}>
                <li>Alle Beträge netto. km aus dem Einsatzplan (Wochen anteilig nach Tagen, unplausible Wochen ausgelassen).</li>
                <li>Umsatz = Summe der Touren (Fracht, FD, ADR, Multistop, Wartezeit, Maut, Diesel).</li>
                <li><b>Fahren:</b> Diesel/AdBlue und Tank-Nebenkosten aus Tankpool/Shell, Maut aus Toll Collect.</li>
                <li><b>Fahrzeug:</b> Werkstatt & Teile nach Belegdatum (Gutschriften/Förderungen verrechnet); Leasing/Miete als Monatsrate, angeschnittene Monate nach Tagen, Auflieger mit festem LKW zählen dort; Versicherung, Kfz-Steuer und Telematik tagesgenau über ihren Zeitraum.</li>
                <li><b>Fahrer:</b> Fahrerkosten über Einsatzplan und Touren auf die LKW verteilt.</li>
                <li><b>Gemeinkosten:</b> eigene LKW gleichmäßig, Miet-SZM nur im Mietzeitraum; Factoring (Gebühren + Zinsen) nach Contargo-Umsatz des Monats.</li>
                <li>Ausgewertet wird nur bis zu dem Tag, bis zu dem Tank- und Mautdaten vollständig vorliegen – sonst stünden km ohne die zugehörigen Kosten da.</li>
              </ul>
            </details>
          </div>

          {proMonat.length > 1 && (
            <div style={card}>
              <div style={h2}>Verlauf je Monat{f.lkw !== "ALLE" && ` · ${f.lkw}`}</div>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Monat</th><th style={right}>km</th><th style={right}>Umsatz</th><th style={right}>Diesel + AdBlue</th><th style={right}>Tank-Nebenk.</th>
                      <th style={right}>Maut</th><th style={right}>Werkstatt & Teile</th><th style={right}>Leasing/Miete</th><th style={right}>Laufende Kosten</th><th style={right}>Fahrer</th><th style={right}>Gemeinkosten</th><th style={right}>Factoring</th><th style={right}>Kosten gesamt</th><th style={right}>Kosten/km</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proMonat.map((r) => (
                      <tr key={r.monat}>
                        <td>{r.monat}</td>
                        <td className="mono" style={right}>{kmTxt(r.km)}</td>
                        <td className="mono" style={right}>{euro(r.umsatz)}</td>
                        <td className="mono" style={right}>{euro(r.diesel)}</td>
                        <td className="mono" style={right}>{r.neben ? euro(r.neben) : "–"}</td>
                        <td className="mono" style={right}>{euro(r.maut)}</td>
                        <td className="mono" style={right}>{r.teile ? euro(r.teile) : "–"}</td>
                        <td className="mono" style={right}>{r.leasing ? euro(r.leasing) : "–"}</td>
                        <td className="mono" style={right}>{r.versSteuer ? euro(r.versSteuer) : "–"}</td>
                        <td className="mono" style={right}>{r.fahrer ? euro(r.fahrer) : "–"}</td>
                        <td className="mono" style={right}>{r.gemein ? euro(r.gemein) : "–"}</td>
                        <td className="mono" style={right}>{r.factoring ? euro(r.factoring) : "–"}</td>
                        <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(r.kosten)}</td>
                        <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE }}>{proKm(r.kosten, r.km) ? dez(proKm(r.kosten, r.km)) : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      <style>{`
        @media (max-width: 820px) {
          .fp-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .fp-detail { grid-template-columns: 1fr !important; }
          .fp-bar-row { grid-template-columns: 74px 1fr 112px !important; }
          .fp-filter-row > div { width: calc(50% - 5px) !important; }
          .fp-filter-row > .fp-filter-btns { width: 100% !important; }
        }
        @media (min-width: 821px) and (max-width: 1250px) {
          .fp-detail { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}

// ----------------------------------------------------------------- Rahmen
export default function Fuhrpark({ fleet, drivers, tours, wochenKm, umsatzVon, reiter, onReiter }) {
  const fleetPlates = useMemo(() => (fleet || []).map((f) => f.plate), [fleet]);
  const aktiv = REITER.some((r) => r.id === reiter) ? reiter : "uebersicht";
  // gemeinsamer Filter (Jahr, Monat, LKW, von, bis) - wird beim Reiterwechsel
  // als Startwert übergeben
  const [geteilt, setGeteilt] = useState({});
  const merke = (x) => setGeteilt({ jahr: x.jahr, monat: x.monat, von: x.von, bis: x.bis, lkw: x.lkw });
  // "Lager"/"offen" gibt es nur bei Ersatzteile - andere Reiter starten dann mit "Alle"
  const start = (erlaubtExtra) => {
    const g = { ...geteilt };
    if (g.lkw && g.lkw !== "ALLE" && !fleetPlates.includes(g.lkw) && !erlaubtExtra) g.lkw = "ALLE";
    return g;
  };

  return (
    <div>
      <div className="fp-reiter" style={{ display: "flex", gap: 6, marginBottom: 18, borderBottom: `1px solid ${BORDER}`, flexWrap: "wrap" }}>
        {REITER.map((r) => {
          const Icon = r.icon;
          const an = r.id === aktiv;
          return (
            <button key={r.id} onClick={() => onReiter(r.id)}
              style={{
                display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 14px", fontSize: 13.5, fontWeight: an ? 600 : 500,
                background: "transparent", border: "none", borderBottom: `2.5px solid ${an ? AMBER : "transparent"}`, marginBottom: -1,
                color: an ? MARINE : TEXT_MUTED, cursor: "pointer", borderRadius: 0,
              }}>
              <Icon size={15} color={an ? MARINE : TEXT_MUTED} /> {r.label}
            </button>
          );
        })}
      </div>
      {aktiv === "uebersicht" && <Uebersicht fleet={fleet} tours={tours} wochenKm={wochenKm} umsatzVon={umsatzVon} startFilter={start(false)} onFilterChange={merke} />}
      {aktiv === "tanken" && <Tankvorgaenge fleet={fleet} wochenKm={wochenKm} startFilter={start(false)} onFilterChange={merke} />}
      {aktiv === "maut" && <Maut fleet={fleet} tours={tours} wochenKm={wochenKm} startFilter={start(false)} onFilterChange={merke} />}
      {aktiv === "ersatzteile" && <Ersatzteile fleet={fleet} startFilter={start(true)} onFilterChange={merke} />}
      {aktiv === "leasing" && <Leasing />}
      {aktiv === "abgaben" && <Abgaben fleet={fleet} />}
      {aktiv === "fahrer" && <FahrerKosten drivers={drivers} fleet={fleet} einsatz={wochenKm} tours={tours} />}
      {aktiv === "gemein" && <Gemeinkosten fleet={fleet} />}
      {aktiv === "factoring" && <Factoring fleet={fleet} tours={tours} umsatzVon={umsatzVon} />}
    </div>
  );
}
