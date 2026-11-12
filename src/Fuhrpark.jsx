// Menüpunkt "Fuhrpark": fasst die fahrzeugbezogenen Seiten unter einem Dach
// zusammen (Reiter Übersicht · Tankvorgänge · Maut · Ersatzteile).
//
// Zeitraum- und LKW-Filter werden zwischen den Reitern weitergegeben: wer sich
// im Reiter Tankvorgänge den OF RY 500 im August ansieht und auf Maut wechselt,
// sieht dort ebenfalls OF RY 500 im August.
//
// Die Übersicht stellt je LKW alle Fahrzeugkosten (Diesel/AdBlue, Tank-
// Nebenkosten, Maut, Ersatzteile) neben km und Umsatz und rechnet Kosten pro
// km. Weil die Quellen unterschiedlich aktuell sind (Maut kommt z. B. nur
// monatlich), wertet die Übersicht nur bis zu dem Tag aus, bis zu dem Tank-
// UND Mautdaten vorliegen - sonst zählten km ohne die zugehörigen Kosten.

import { useEffect, useMemo, useState } from "react";
import { LayoutGrid, Fuel, Coins, Wrench, KeyRound, ShieldCheck, Users, Loader2, RefreshCw, Info } from "lucide-react";
import Tankvorgaenge from "./Tankvorgaenge";
import Maut from "./Maut";
import Ersatzteile from "./Ersatzteile";
import Leasing from "./Leasing";
import Abgaben from "./Abgaben";
import FahrerKosten from "./FahrerKosten";
import * as tdb from "./tankDb";
import * as mdb from "./mautDb";
import * as edb from "./ersatzteilDb";
import * as ldb from "./leasingDb";
import * as adb from "./abgabenDb";
import * as fdb from "./fahrerKostenDb";
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

const REITER = [
  { id: "uebersicht", label: "Übersicht", icon: LayoutGrid },
  { id: "tanken", label: "Tankvorgänge", icon: Fuel },
  { id: "maut", label: "Maut", icon: Coins },
  { id: "ersatzteile", label: "Ersatzteile", icon: Wrench },
  { id: "leasing", label: "Leasing/Miete", icon: KeyRound },
  { id: "abgaben", label: "Versicherung & Steuer", icon: ShieldCheck },
  { id: "fahrer", label: "Fahrerkosten", icon: Users },
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
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");

  async function neuLaden() {
    setLaden(true);
    setFehler("");
    try {
      const [t, tr, m, e, lr, lf, ab, fk] = await Promise.all([tdb.fetchTankvorgaenge(), tdb.fetchTankpoolRechnungen(), mdb.fetchMautPositionen(), edb.fetchPositionen(), ldb.fetchRaten(), ldb.fetchFahrzeuge(), adb.fetchAbgaben(), fdb.fetchKosten()]);
      setTank(t);
      setTankRe(tr);
      setMaut(m.filter((x) => x.datum >= MAUT_START));
      setTeile(e);
      setRaten(lr);
      setVertraege(lf);
      setAbgaben(ab);
      setFahrerKosten(fk);
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
    const z = (lkw) => (zeilen[lkw] = zeilen[lkw] || { lkw, km: 0, umsatz: 0, touren: 0, diesel: 0, neben: 0, maut: 0, teile: 0, leasing: 0, versSteuer: 0, fahrer: 0 });
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
    for (const [lkw, b] of Object.entries(ldb.leasingJeLkw(raten, start, ende))) z(lkw).leasing += b;
    for (const [lkw, b] of Object.entries(adb.abgabenJeLkw(abgaben, start, ende))) z(lkw).versSteuer += b.versicherung + b.steuer;
    let fahrerOffen = 0;
    for (const [lkw, b] of Object.entries(fdb.jeLkw(fahrerKosten, wochenKm, start, ende))) {
      if (lkw === fdb.OFFEN) fahrerOffen += b;
      else z(lkw).fahrer += b;
    }
    const reihenfolge = [...fleetPlates, ...Object.keys(zeilen).filter((p) => !fleetPlates.includes(p)).sort()];
    const rows = reihenfolge.map((p) => zeilen[p]).filter((r) => r && (r.km || r.umsatz || r.diesel || r.neben || r.maut || r.teile || r.leasing || r.versSteuer || r.fahrer))
      .filter((r) => f.lkw === "ALLE" || r.lkw === f.lkw)
      .map((r) => ({ ...r, kosten: r.diesel + r.neben + r.maut + r.teile + r.leasing + r.versSteuer + r.fahrer }));
    const sum = rows.reduce((s, r) => {
      for (const k of ["km", "umsatz", "touren", "diesel", "neben", "maut", "teile", "leasing", "versSteuer", "fahrer", "kosten"]) s[k] += r[k];
      return s;
    }, { km: 0, umsatz: 0, touren: 0, diesel: 0, neben: 0, maut: 0, teile: 0, leasing: 0, versSteuer: 0, fahrer: 0, kosten: 0 });
    return { rows, sum, lager: f.lkw === "ALLE" ? lager : 0, offen: f.lkw === "ALLE" ? offen : 0, fahrerOffen: f.lkw === "ALLE" ? fahrerOffen : 0 };
  }, [tank, maut, teile, raten, abgaben, fahrerKosten, tours, wochenKm, start, ende, f.lkw, fleetPlates]);

  // Verlauf je Monat (Kosten nach Quelle), gleiche Kappung
  const proMonat = useMemo(() => {
    const map = {};
    const m = (d) => (map[d.slice(0, 7)] = map[d.slice(0, 7)] || { diesel: 0, neben: 0, maut: 0, teile: 0, leasing: 0, versSteuer: 0, fahrer: 0, umsatz: 0 });
    const lkwOk = (l) => f.lkw === "ALLE" || l === f.lkw;
    for (const t of tank) if (drin(t.datum) && lkwOk(t.lkw)) { const r = m(t.datum); if (t.kategorie === "neben") r.neben += t.wert; else r.diesel += t.wert; }
    for (const x of maut) if (drin(x.datum) && lkwOk(x.lkw)) m(x.datum).maut += x.betrag;
    for (const e of teile) if (drin(e.datum) && e.lkw && e.lkw !== "Lager" && lkwOk(e.lkw)) m(e.datum).teile += e.netto + e.pfand;
    for (const t of tours || []) if (drin(t.datum) && lkwOk(t.lkw)) m(t.datum).umsatz += umsatzVon(t);
    for (const r of raten) {
      if (!lkwOk(r.kennzeichen)) continue;
      const anteil = ldb.leasingJeLkw([r], start, ende)[r.kennzeichen];
      if (anteil) m(`${r.monat}-01`).leasing += anteil;
    }
    for (const a of fdb.verteilen(fahrerKosten, wochenKm, start, ende)) {
      if (a.lkw === fdb.OFFEN || !lkwOk(a.lkw) || !a.betrag) continue;
      m(`${a.monat}-01`).fahrer += a.betrag;
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
        if (anteil && a <= e) m(ms).versSteuer += anteil.versicherung + anteil.steuer;
        ms = isoOf(new Date(j, mo, 1));
      }
    }
    return Object.keys(map).sort().reverse().map((k) => {
      const [j, mo] = k.split("-").map(Number);
      const ms = `${k}-01`, me = isoOf(new Date(j, mo, 0));
      const kmMap = kmJeLkw(wochenKm, start && start > ms ? start : ms, ende && ende < me ? ende : me);
      const km = f.lkw === "ALLE" ? Object.values(kmMap).reduce((s, v) => s + v, 0) : kmMap[f.lkw] || 0;
      const r = map[k];
      return { monat: `${MONATE[mo - 1]} ${j}`, ...r, kosten: r.diesel + r.neben + r.maut + r.teile + r.leasing + r.versSteuer + r.fahrer, km };
    });
  }, [tank, maut, teile, raten, abgaben, fahrerKosten, tours, wochenKm, start, ende, f.lkw]);

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
  const maxKostenKm = Math.max(0, ...rows.map((r) => proKm(r.kosten, r.km) || 0));

  return (
    <div>
      <div style={{ ...card, padding: "14px 18px" }}>
        <div className="fp-filter-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10 }}>
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

      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}

      {laden ? (
        <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Fuhrparkdaten …</div>
      ) : (
        <>
          {gekappt && (
            <div style={{ fontSize: 12.5, color: AMBER_DARK, background: WARN_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16, display: "flex", gap: 8 }}>
              <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                Ausgewertet bis <b>{dmy(datenBis)}</b> – bis dahin liegen Tank- und Mautdaten vollständig vor
                (Tankpool bis {dmy(tankBis) || "–"}, Maut bis {dmy(mautBis) || "–"}). Km, Umsatz und Kosten danach zählen erst mit,
                wenn die nächsten Abrechnungen importiert sind. Letzter Ersatzteil-Beleg: {dmy(teileBis) || "–"}.
              </span>
            </div>
          )}

          <div className="fp-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
            <Kpi label="Fahrzeugkosten gesamt" value={euro(sum.kosten)} sub="Diesel, AdBlue, Tank-Nebenk., Maut, Ersatzteile, Leasing/Miete, Versicherung, Steuer, Fahrer" />
            <Kpi label="Kosten pro km" value={proKm(sum.kosten, sum.km) ? `${dez(proKm(sum.kosten, sum.km))} €` : "–"} sub={`${kmTxt(sum.km)} km lt. Einsatzplan`} />
            <Kpi label="Umsatz" value={euro(sum.umsatz)} sub={`${sum.touren.toLocaleString("de-DE")} Touren · ${proKm(sum.umsatz, sum.km) ? dez(proKm(sum.umsatz, sum.km)) + " €/km" : "–"}`} />
            <Kpi label="Umsatz − Fahrzeugkosten" value={euro(sum.umsatz - sum.kosten)} accent={sum.umsatz - sum.kosten >= 0 ? SUCCESS : DANGER}
              sub={sum.umsatz ? `${Math.round(((sum.umsatz - sum.kosten) / sum.umsatz) * 100)} % vom Umsatz · ohne Werkstattlohn und Gemeinkosten` : null} />
            <Kpi label="Anteile der Kosten" value={sum.kosten ? `${Math.round((sum.diesel / sum.kosten) * 100)} % Diesel` : "–"}
              sub={sum.kosten ? `Maut ${Math.round((sum.maut / sum.kosten) * 100)} % · Leasing/Miete ${Math.round((sum.leasing / sum.kosten) * 100)} % · Teile ${Math.round((sum.teile / sum.kosten) * 100)} %` : null} />
          </div>

          <div style={card}>
            <div style={h2}>Kosten je LKW</div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>LKW</th><th style={right}>km</th><th style={right}>Umsatz</th><th style={right}>Umsatz/km</th>
                    <th style={right}>Diesel + AdBlue</th><th style={right}>Tank-Nebenk.</th><th style={right}>Maut</th><th style={right}>Ersatzteile</th>
                    <th style={right}>Leasing/Miete</th><th style={right} title="Kfz-Versicherung und Kfz-Steuer, tagesgenau verteilt">Versich. + Steuer</th><th style={right} title="Fahrerkosten, über den Einsatzplan auf die LKW verteilt">Fahrer</th>
                    <th style={right}>Kosten gesamt</th><th style={right}>Kosten/km</th><th style={right}>Umsatz − Kosten</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const ckm = proKm(r.kosten, r.km);
                    const diff = r.umsatz - r.kosten;
                    return (
                      <tr key={r.lkw}>
                        <td className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                          {r.lkw}
                          {!fleetPlates.includes(r.lkw) && <div style={{ fontSize: 10.5, color: TEXT_MUTED, fontWeight: 400 }}>nicht im Fuhrpark</div>}
                        </td>
                        <td className="mono" style={right}>{kmTxt(r.km)}</td>
                        <td className="mono" style={right}>{euro(r.umsatz)}</td>
                        <td className="mono" style={right}>{proKm(r.umsatz, r.km) ? dez(proKm(r.umsatz, r.km)) : "–"}</td>
                        <td className="mono" style={right}>{euro(r.diesel)}</td>
                        <td className="mono" style={right}>{r.neben ? euro(r.neben) : "–"}</td>
                        <td className="mono" style={right}>{euro(r.maut)}</td>
                        <td className="mono" style={right}>{r.teile ? euro(r.teile) : "–"}</td>
                        <td className="mono" style={right}>{r.leasing ? euro(r.leasing) : "–"}</td>
                        <td className="mono" style={right}>{r.versSteuer ? euro(r.versSteuer) : "–"}</td>
                        <td className="mono" style={right}>{r.fahrer ? euro(r.fahrer) : "–"}</td>
                        <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(r.kosten)}</td>
                        <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE }}>
                          {ckm ? (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                              <span style={{ display: "inline-block", width: 40, height: 6, background: "#EEF1F4", borderRadius: 3, overflow: "hidden" }}>
                                <span style={{ display: "block", height: 6, width: `${(ckm / maxKostenKm) * 100}%`, background: AMBER, borderRadius: 3 }} />
                              </span>
                              {dez(ckm)}
                            </span>
                          ) : "–"}
                        </td>
                        <td className="mono" style={{ ...right, color: diff >= 0 ? SUCCESS : DANGER }}>{euro(diff)}</td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && <tr><td colSpan={14} style={{ color: TEXT_MUTED }}>Keine Daten im gewählten Zeitraum.</td></tr>}
                  {rows.length > 1 && (
                    <tr style={{ borderTop: `2px solid ${BORDER}` }}>
                      <td style={{ fontWeight: 600 }}>Summe</td>
                      <td className="mono" style={right}>{kmTxt(sum.km)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.umsatz)}</td>
                      <td className="mono" style={right}>{proKm(sum.umsatz, sum.km) ? dez(proKm(sum.umsatz, sum.km)) : "–"}</td>
                      <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.diesel)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.neben)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.maut)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.teile)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.leasing)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.versSteuer)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.fahrer)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 700 }}>{euro(sum.kosten)}</td>
                      <td className="mono" style={{ ...right, fontWeight: 700, color: MARINE }}>{proKm(sum.kosten, sum.km) ? dez(proKm(sum.kosten, sum.km)) : "–"}</td>
                      <td className="mono" style={{ ...right, fontWeight: 700, color: sum.umsatz - sum.kosten >= 0 ? SUCCESS : DANGER }}>{euro(sum.umsatz - sum.kosten)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 10, lineHeight: 1.5 }}>
              Alle Beträge netto. km aus dem Einsatzplan (Wochen anteilig nach Tagen, unplausible Wochen ausgelassen). Umsatz = Summe der Touren
              (Fracht, FD, ADR, Multistop, Wartezeit, Maut, Diesel). Ersatzteile nach Belegdatum, Gutschriften verrechnet. Leasing/Miete: Monatsrate, angeschnittene Monate anteilig nach Tagen. Versicherung und Kfz-Steuer tagesgenau über ihren Zeitraum verteilt. Fahrerkosten über den Einsatzplan auf die LKW verteilt.
              {(auswertung.lager !== 0 || auswertung.offen !== 0) && (
                <> Nicht enthalten: Ersatzteile „Lager“ {euro(auswertung.lager)}{auswertung.offen !== 0 && <>, ohne Fahrzeug {euro(auswertung.offen)}</>}.</>
              )}
              {auswertung.fahrerOffen > 0.5 && <> Fahrerkosten ohne LKW-Zuordnung im Einsatzplan: {euro(auswertung.fahrerOffen)} (nicht enthalten).</>}{" "}Nicht erfasst ist Werkstattlohn.
              {schlussraten.length > 0 && (
                <div style={{ marginTop: 6, color: TEXT }}>
                  <b>Schlussraten im Zeitraum (nicht in den Kosten oben enthalten):</b>{" "}
                  {schlussraten.map((v) => `${v.kennzeichen} ${euro(v.schlussrateBetrag)} am ${dmy(v.schlussrateDatum)}`).join(" · ")}
                  {" "}= {euro(schlussraten.reduce((s, v) => s + v.schlussrateBetrag, 0))}
                </div>
              )}
            </div>
          </div>

          {proMonat.length > 1 && (
            <div style={card}>
              <div style={h2}>Verlauf je Monat{f.lkw !== "ALLE" && ` · ${f.lkw}`}</div>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Monat</th><th style={right}>km</th><th style={right}>Umsatz</th><th style={right}>Diesel + AdBlue</th><th style={right}>Tank-Nebenk.</th>
                      <th style={right}>Maut</th><th style={right}>Ersatzteile</th><th style={right}>Leasing/Miete</th><th style={right}>Versich. + Steuer</th><th style={right}>Fahrer</th><th style={right}>Kosten gesamt</th><th style={right}>Kosten/km</th>
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
          .fp-filter-grid { grid-template-columns: repeat(2, 1fr) !important; }
          .fp-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
        @media (min-width: 821px) and (max-width: 1250px) {
          .fp-kpi-grid { grid-template-columns: repeat(3, 1fr) !important; }
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
      {aktiv === "fahrer" && <FahrerKosten drivers={drivers} fleet={fleet} einsatz={wochenKm} />}
    </div>
  );
}
