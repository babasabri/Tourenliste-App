// Fuhrpark-Reiter "Factoring" (nordwest): wöchentliche Factoringabrechnungen und
// monatliche Zinsabrechnungen als PDF hochladen (Vorschau -> Übernehmen),
// Auswertung je Monat, Sperrkonto-Stand, Belegliste und Verteilung der Kosten
// (Gebühren + Zinsen, netto) nach Contargo-Umsatz auf die LKW.

import { Fragment, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Upload, Trash2, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { parseFactoringPdf } from "./factoringParser";
import * as fdb from "./factoringDb";
import * as ldb from "./leasingDb";

const MARINE = "#0F2A43";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT = "#16232E";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS = "#2F8F6B";
const SUCCESS_BG = "#E7F6EF";
const AMBER_DARK = "#8A5A10";
const WARN_BG = "#FDF1DD";

const MON = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const card = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 20 };
const h2 = { fontSize: 15, fontWeight: 600, marginBottom: 12, color: TEXT };
const right = { textAlign: "right" };
const pad2 = (x) => String(x).padStart(2, "0");
const dmy = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const euro = (x) => (Number.isFinite(x) ? x.toLocaleString("de-DE", { style: "currency", currency: "EUR" }) : "–");
const euro0 = (x) => (Number.isFinite(x) ? x.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }) : "–");
const pct = (x) => (Number.isFinite(x) ? x.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " %" : "–");

function Kpi({ label, value, sub, accent }) {
  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "12px 14px" }}>
      <div style={{ fontSize: 11, color: TEXT_MUTED, fontWeight: 500 }}>{label}</div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 600, color: accent || MARINE, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function Factoring({ fleet, tours, umsatzVon }) {
  const heute = new Date();
  const [jahr, setJahr] = useState(heute.getFullYear());
  const [abr, setAbr] = useState([]);
  const [zins, setZins] = useState([]);
  const [vertraege, setVertraege] = useState([]);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");
  const [vorschau, setVorschau] = useState([]); // [{ dateiname, beleg?, fehler?, dublette? }]
  const [liest, setLiest] = useState(false);
  const [speichert, setSpeichert] = useState(false);
  const [offen, setOffen] = useState({});
  const [meldung, setMeldung] = useState("");

  async function neuLaden() {
    setFehler("");
    try {
      const [a, z, v] = await Promise.all([fdb.fetchAbrechnungen(), fdb.fetchZinsen(), ldb.fetchFahrzeuge()]);
      setAbr(a); setZins(z); setVertraege(v);
    } catch (e) { setFehler("Factoring-Daten konnten nicht geladen werden: " + (e.message || e)); }
    setLaden(false);
  }
  useEffect(() => { neuLaden(); }, []);

  async function dateienGewaehlt(files) {
    setMeldung(""); setFehler("");
    const liste = Array.from(files || []).filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!liste.length) return;
    setLiest(true);
    const out = [];
    for (const f of liste) {
      try {
        const beleg = await parseFactoringPdf(f);
        const dublette = beleg.typ === "abrechnung" ? abr.some((a) => a.nr === beleg.nr) : zins.some((z) => z.rechnungsnr === beleg.rechnungsnr);
        out.push({ dateiname: f.name, beleg, dublette });
      } catch (e) { out.push({ dateiname: f.name, fehler: e.message || String(e) }); }
    }
    // gleiche Abrechnung zweimal in der Auswahl -> nur einmal
    const gesehen = new Set();
    for (const x of out) {
      if (!x.beleg) continue;
      const k = x.beleg.typ === "abrechnung" ? `A${x.beleg.nr}` : `Z${x.beleg.rechnungsnr}`;
      if (gesehen.has(k)) x.doppeltInAuswahl = true;
      gesehen.add(k);
    }
    setVorschau(out);
    setLiest(false);
  }

  const uebernehmbar = vorschau.filter((x) => x.beleg && !x.dublette && !x.doppeltInAuswahl);
  async function uebernehmen() {
    setSpeichert(true); setFehler("");
    let ok = 0;
    const fehlerListe = [];
    for (const x of uebernehmbar) {
      try { await fdb.speichern(x.beleg); ok++; } catch (e) { fehlerListe.push(`${x.dateiname}: ${e.message || e}`); }
    }
    setSpeichert(false);
    setVorschau([]);
    if (fehlerListe.length) setFehler(fehlerListe.join(" · "));
    setMeldung(`${ok} Beleg${ok === 1 ? "" : "e"} übernommen.`);
    await neuLaden();
  }

  async function loeschen(typ, id) {
    if (!window.confirm(typ === "a" ? `Factoringabrechnung ${id} löschen?` : `Zinsabrechnung ${id} löschen?`)) return;
    try { if (typ === "a") await fdb.loeschenAbrechnung(id); else await fdb.loeschenZinsen(id); await neuLaden(); }
    catch (e) { setFehler("Löschen fehlgeschlagen: " + (e.message || e)); }
  }

  const jahre = useMemo(() => {
    const s = new Set([...abr.map((a) => Number(a.datum.slice(0, 4))), ...zins.map((z) => Number(z.perDatum.slice(0, 4)))]);
    s.add(heute.getFullYear());
    return Array.from(s).sort((a, b) => b - a);
  }, [abr, zins]);

  const imJahr = (d) => d && d.startsWith(`${jahr}-`);
  const abrJahr = abr.filter((a) => imJahr(a.datum));
  const zinsJahr = zins.filter((z) => imJahr(z.perDatum));

  const monate = MON.map((_, i) => `${jahr}-${pad2(i + 1)}`);
  const proMonat = useMemo(() => {
    const kpm = fdb.kostenProMonat(abrJahr, zinsJahr);
    return monate.map((m) => {
      const a = abrJahr.filter((x) => x.datum.startsWith(m));
      const eingereicht = a.reduce((s, x) => s + x.eingereicht, 0);
      const k = kpm[m] || { gebuehren: 0, zinsen: 0, summe: 0 };
      return {
        monat: m, abrechnungen: a.length, eingereicht, ...k,
        quote: eingereicht ? (k.summe / eingereicht) * 100 : null,
        einbehalt: a.reduce((s, x) => s + x.sperrEinbehalt, 0), freigabe: a.reduce((s, x) => s + x.sperrFreigabe, 0),
        auszahlung: a.reduce((s, x) => s + x.auszahlung, 0), nichtAngekauft: a.reduce((s, x) => s + x.nichtAngekauft, 0),
      };
    });
  }, [abr, zins, jahr]);
  const sum = proMonat.reduce((s, r) => {
    for (const k of ["abrechnungen", "eingereicht", "gebuehren", "zinsen", "summe", "einbehalt", "freigabe", "auszahlung", "nichtAngekauft"]) s[k] += r[k];
    return s;
  }, { abrechnungen: 0, eingereicht: 0, gebuehren: 0, zinsen: 0, summe: 0, einbehalt: 0, freigabe: 0, auszahlung: 0, nichtAngekauft: 0 });

  // Sperrkonto über alle importierten Abrechnungen (nicht nur das Jahr)
  const sperrStand = abr.reduce((s, a) => s + a.sperrEinbehalt - a.sperrFreigabe, 0);
  const ersteAbr = abr.length ? abr.reduce((m, a) => (a.datum < m.datum ? a : m)) : null;

  const verteilung = useMemo(() => fdb.verteilen(abrJahr, zinsJahr, null, null, { tours, umsatzVon, fleet, vertraege }), [abr, zins, jahr, tours, fleet, vertraege]);
  const fleetPlates = (fleet || []).map((f) => f.plate);
  const lkwZeilen = useMemo(() => {
    const keys = Array.from(new Set(verteilung.map((v) => v.lkw)));
    const ordnung = [...fleetPlates, ...keys.filter((k) => !fleetPlates.includes(k)).sort()];
    return ordnung.filter((k) => keys.includes(k)).map((k) => {
      const pm = Object.fromEntries(monate.map((m) => [m, verteilung.filter((v) => v.lkw === k && v.monat === m).reduce((s, v) => s + v.betrag, 0)]));
      return { lkw: k, pm, summe: Object.values(pm).reduce((s, v) => s + v, 0) };
    });
  }, [verteilung, jahr, fleetPlates.join()]);
  const gleichMonate = Array.from(new Set(verteilung.filter((v) => v.schluessel === "gleich").map((v) => v.monat))).sort();

  if (laden) return <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Factoring …</div>;

  return (
    <div>
      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}
      {meldung && <div style={{ fontSize: 12.5, color: SUCCESS, background: SUCCESS_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{meldung}</div>}

      {/* Upload */}
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
          <div style={{ ...h2, marginBottom: 0 }}>Belege von nordwest hochladen</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ margin: 0 }}>Jahr</label>
            <select value={jahr} onChange={(e) => setJahr(Number(e.target.value))} style={{ width: 100 }}>
              {jahre.map((j) => <option key={j} value={j}>{j}</option>)}
            </select>
            <button className="ghost" onClick={neuLaden}><RefreshCw size={14} /></button>
          </div>
        </div>
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); dateienGewaehlt(e.dataTransfer.files); }}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, border: `1.5px dashed ${BORDER}`, borderRadius: 10, padding: "20px 14px", cursor: "pointer", color: TEXT_MUTED, fontSize: 13, background: "#F7F9FB", margin: 0 }}>
          {liest ? <><Loader2 size={16} /> Lese PDFs …</> : <><Upload size={16} /> Factoringabrechnungen und Zinsabrechnungen (PDF) hierher ziehen oder klicken – mehrere gleichzeitig möglich</>}
          <input type="file" accept="application/pdf,.pdf" multiple style={{ display: "none" }} onChange={(e) => { dateienGewaehlt(e.target.files); e.target.value = ""; }} />
        </label>

        {vorschau.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr><th>Datei</th><th>Beleg</th><th>Datum</th><th style={right}>Eingereicht</th><th style={right}>Gebühren/Zinsen netto</th><th style={right}>Sperrkonto</th><th style={right}>Auszahlung</th><th>Prüfung</th></tr>
                </thead>
                <tbody>
                  {vorschau.map((x, i) => {
                    const b = x.beleg;
                    return (
                      <tr key={i} style={x.fehler ? { background: DANGER_BG } : x.dublette || x.doppeltInAuswahl ? { background: "#F4F6F8", color: TEXT_MUTED } : b?.warnungen?.length ? { background: WARN_BG } : undefined}>
                        <td style={{ fontSize: 12 }}>{x.dateiname}</td>
                        {x.fehler ? <td colSpan={7} style={{ color: DANGER }}>{x.fehler}</td> : b.typ === "abrechnung" ? (
                          <>
                            <td>Abrechnung {b.nr}<div style={{ fontSize: 10.5, color: TEXT_MUTED }}>{b.positionen.length} Rechnung{b.positionen.length === 1 ? "" : "en"}</div></td>
                            <td className="mono">{dmy(b.datum)}</td>
                            <td className="mono" style={right}>{euro(b.eingereicht)}</td>
                            <td className="mono" style={right}>{euro(b.gebuehrenNetto)}</td>
                            <td className="mono" style={right}>{b.sperrEinbehalt ? `+${euro(b.sperrEinbehalt)}` : ""}{b.sperrFreigabe ? ` −${euro(b.sperrFreigabe)}` : ""}{!b.sperrEinbehalt && !b.sperrFreigabe ? "–" : ""}</td>
                            <td className="mono" style={right}>{euro(b.auszahlung)}</td>
                            <td style={{ fontSize: 12 }}>{x.dublette ? "schon importiert" : x.doppeltInAuswahl ? "doppelt in der Auswahl" : b.warnungen.length ? <span style={{ color: AMBER_DARK }}>{b.warnungen.join(" · ")}</span> : <span style={{ color: SUCCESS, display: "inline-flex", gap: 4, alignItems: "center" }}><CheckCircle2 size={13} /> Summen stimmen</span>}</td>
                          </>
                        ) : (
                          <>
                            <td>Zinsen {b.rechnungsnr}<div style={{ fontSize: 10.5, color: TEXT_MUTED }}>per {dmy(b.perDatum)}</div></td>
                            <td className="mono">{dmy(b.rechnungsdatum)}</td>
                            <td className="mono" style={right}>–</td>
                            <td className="mono" style={right}>{euro(b.netto)}</td>
                            <td className="mono" style={right}>–</td>
                            <td className="mono" style={right}>–</td>
                            <td style={{ fontSize: 12 }}>{x.dublette ? "schon importiert" : x.doppeltInAuswahl ? "doppelt in der Auswahl" : b.warnungen.length ? <span style={{ color: AMBER_DARK }}>{b.warnungen.join(" · ")}</span> : <span style={{ color: SUCCESS, display: "inline-flex", gap: 4, alignItems: "center" }}><CheckCircle2 size={13} /> Summen stimmen</span>}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button onClick={uebernehmen} disabled={!uebernehmbar.length || speichert}>
                {speichert ? <Loader2 size={14} /> : <CheckCircle2 size={14} />} {uebernehmbar.length} übernehmen
              </button>
              <button className="ghost" onClick={() => setVorschau([])}>Abbrechen</button>
            </div>
          </div>
        )}
      </div>

      {/* Kennzahlen */}
      <div className="fa-kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 20 }}>
        <Kpi label={`Factoring-Kosten ${jahr} (netto)`} value={euro0(sum.summe)} sub={`Gebühren ${euro0(sum.gebuehren)} · Zinsen ${euro0(sum.zinsen)}`} />
        <Kpi label="Kostenquote" value={sum.eingereicht ? pct((sum.summe / sum.eingereicht) * 100) : "–"} sub={`vom eingereichten Volumen ${euro0(sum.eingereicht)}`} />
        <Kpi label={`Ausgezahlt ${jahr}`} value={euro0(sum.auszahlung)} sub={`${sum.abrechnungen} Abrechnung${sum.abrechnungen === 1 ? "" : "en"}${sum.nichtAngekauft ? ` · nicht angekauft ${euro0(sum.nichtAngekauft)}` : ""}`} />
        <Kpi label="Sperrkonto (Einbehalt − Freigaben)" value={euro0(sperrStand)} accent={MARINE}
          sub={ersteAbr ? `aus allen Abrechnungen seit ${dmy(ersteAbr.datum)}` : "noch keine Abrechnung importiert"} />
      </div>

      {/* je Monat */}
      <div style={card}>
        <div style={h2}>Factoring je Monat {jahr}</div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Monat</th><th style={right}>Abr.</th><th style={right}>Eingereicht</th><th style={right}>Gebühren</th><th style={right}>Zinsen</th><th style={right}>Kosten netto</th>
                <th style={right}>Quote</th><th style={right}>Sperrk. Einbehalt</th><th style={right}>Sperrk. Freigabe</th><th style={right}>Auszahlung</th>
              </tr>
            </thead>
            <tbody>
              {proMonat.filter((r) => r.abrechnungen || r.summe).map((r) => (
                <tr key={r.monat}>
                  <td>{MON[Number(r.monat.slice(5)) - 1]} {jahr}</td>
                  <td className="mono" style={right}>{r.abrechnungen || "–"}</td>
                  <td className="mono" style={right}>{r.eingereicht ? euro0(r.eingereicht) : "–"}</td>
                  <td className="mono" style={right}>{r.gebuehren ? euro(r.gebuehren) : "–"}</td>
                  <td className="mono" style={right}>{r.zinsen ? euro(r.zinsen) : "–"}</td>
                  <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(r.summe)}</td>
                  <td className="mono" style={right}>{pct(r.quote)}</td>
                  <td className="mono" style={right}>{r.einbehalt ? euro0(r.einbehalt) : "–"}</td>
                  <td className="mono" style={right}>{r.freigabe ? euro0(r.freigabe) : "–"}</td>
                  <td className="mono" style={right}>{r.auszahlung ? euro0(r.auszahlung) : "–"}</td>
                </tr>
              ))}
              {!proMonat.some((r) => r.abrechnungen || r.summe) && <tr><td colSpan={10} style={{ color: TEXT_MUTED }}>Für {jahr} sind noch keine Belege importiert.</td></tr>}
              {proMonat.filter((r) => r.abrechnungen || r.summe).length > 1 && (
                <tr style={{ borderTop: `2px solid ${BORDER}` }}>
                  <td style={{ fontWeight: 600 }}>Summe</td>
                  <td className="mono" style={right}>{sum.abrechnungen}</td>
                  <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro0(sum.eingereicht)}</td>
                  <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.gebuehren)}</td>
                  <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(sum.zinsen)}</td>
                  <td className="mono" style={{ ...right, fontWeight: 700, color: MARINE }}>{euro(sum.summe)}</td>
                  <td className="mono" style={right}>{sum.eingereicht ? pct((sum.summe / sum.eingereicht) * 100) : "–"}</td>
                  <td className="mono" style={right}>{euro0(sum.einbehalt)}</td>
                  <td className="mono" style={right}>{euro0(sum.freigabe)}</td>
                  <td className="mono" style={right}>{euro0(sum.auszahlung)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 10, lineHeight: 1.5 }}>
          Gebühren zählen im Monat des Abrechnungsdatums, Zinsen im Monat ihrer Zinsperiode („per“-Datum). Alle Kosten netto – die Umsatzsteuer ist Vorsteuer.
          Quote = Kosten ÷ eingereichtes Volumen. Der Sperrkonto-Stand rechnet nur mit den importierten Abrechnungen; ein Bestand von vorher ist nicht enthalten.
        </div>
      </div>

      {/* Verteilung */}
      <div style={card}>
        <div style={h2}>Verteilung auf die LKW {jahr}</div>
        <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 12 }}>
          Nach dem Contargo-Umsatz des Monats (Touren ohne „Anderer Auftraggeber“): ein LKW mit mehr Umsatz trägt mehr Factoring-Kosten. Fließt in die Fuhrpark-Übersicht (Spalte „Factoring“).
        </div>
        {lkwZeilen.length === 0 ? <div style={{ color: TEXT_MUTED, fontSize: 13 }}>Noch keine Factoring-Kosten für {jahr}.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>LKW</th>{MON.map((m) => <th key={m} style={right}>{m}</th>)}<th style={right}>Summe</th></tr></thead>
              <tbody>
                {lkwZeilen.map((z) => (
                  <tr key={z.lkw}>
                    <td className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{z.lkw}</td>
                    {monate.map((m) => <td key={m} className="mono" style={{ ...right, fontSize: 12 }}>{z.pm[m] ? euro0(z.pm[m]) : "–"}</td>)}
                    <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE }}>{euro0(z.summe)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {gleichMonate.length > 0 && (
          <div style={{ fontSize: 12, color: AMBER_DARK, background: WARN_BG, borderRadius: 8, padding: "9px 12px", marginTop: 12, display: "flex", gap: 8 }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Ohne Contargo-Umsatz in {gleichMonate.map((m) => `${MON[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`).join(", ")} – dort wie die übrigen Gemeinkosten verteilt (eigene LKW gleich, Miet-SZM nach Mietzeitraum).</span>
          </div>
        )}
      </div>

      {/* Belege */}
      <div style={card}>
        <div style={h2}>Factoringabrechnungen {jahr}</div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th></th><th>Nr.</th><th>Datum</th><th style={right}>Eingereicht</th><th style={right}>Nicht angekauft</th><th style={right}>Sperrkonto</th><th style={right}>Gebühren netto</th><th style={right}>USt</th><th style={right}>Auszahlung</th><th></th></tr>
            </thead>
            <tbody>
              {abrJahr.map((a) => (
                <Fragment key={a.nr}>
                  <tr>
                    <td style={{ width: 26 }}>
                      {a.positionen.length > 0 && <button className="ghost" style={{ padding: "1px 4px" }} onClick={() => setOffen((o) => ({ ...o, [a.nr]: !o[a.nr] }))}>{offen[a.nr] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>}
                    </td>
                    <td className="mono" style={{ fontWeight: 600 }}>{a.nr}{a.warnungen.length > 0 && <AlertTriangle size={12} color={AMBER_DARK} style={{ marginLeft: 4 }} title={a.warnungen.join(" · ")} />}</td>
                    <td className="mono">{dmy(a.datum)}</td>
                    <td className="mono" style={right}>{euro(a.eingereicht)}</td>
                    <td className="mono" style={right}>{a.nichtAngekauft ? euro(a.nichtAngekauft) : "–"}</td>
                    <td className="mono" style={right}>{a.sperrEinbehalt ? `+${euro(a.sperrEinbehalt)}` : ""}{a.sperrFreigabe ? ` −${euro(a.sperrFreigabe)}` : ""}{!a.sperrEinbehalt && !a.sperrFreigabe ? "–" : ""}</td>
                    <td className="mono" style={right}>{euro(a.gebuehrenNetto)}</td>
                    <td className="mono" style={right}>{euro(a.ust)}</td>
                    <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(a.auszahlung)}</td>
                    <td><button className="ghost" title="Abrechnung löschen" onClick={() => loeschen("a", a.nr)} style={{ padding: "2px 5px" }}><Trash2 size={13} /></button></td>
                  </tr>
                  {offen[a.nr] && (
                    <tr>
                      <td></td>
                      <td colSpan={9} style={{ background: "#F7F9FB" }}>
                        <table style={{ fontSize: 12 }}>
                          <thead><tr><th>Rechnung/Gutschrift</th><th>Datum</th><th>Debitor</th><th style={right}>Betrag</th><th style={right}>nicht angek.</th><th style={right}>Sperrkonto</th><th style={right}>Gebühren</th><th style={right}>USt</th><th style={right}>Auszahlung</th></tr></thead>
                          <tbody>
                            {a.positionen.map((p, i) => (
                              <tr key={i}>
                                <td className="mono">{p.rechnung}<span style={{ color: TEXT_MUTED }}> {p.trans}</span></td>
                                <td className="mono">{dmy(p.datum)}</td>
                                <td>{p.debitor}</td>
                                <td className="mono" style={right}>{euro(p.betrag)}</td>
                                <td className="mono" style={right}>{p.nichtAngekauft ? euro(p.nichtAngekauft) : "–"}</td>
                                <td className="mono" style={right}>{euro(p.sperrkonto)}</td>
                                <td className="mono" style={right}>{euro((p.gebuehrEf || 0) + (p.gebuehrIk || 0))}</td>
                                <td className="mono" style={right}>{euro(p.ust)}</td>
                                <td className="mono" style={right}>{euro(p.summe)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {abrJahr.length === 0 && <tr><td colSpan={10} style={{ color: TEXT_MUTED }}>Keine Abrechnungen für {jahr}.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div style={card}>
        <div style={h2}>Zinsabrechnungen {jahr}</div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Rechnung</th><th>Periode per</th><th style={right}>Ø finanzierter Saldo</th><th style={right}>Zinssatz</th><th style={right}>Zinsen netto</th><th style={right}>MwSt</th><th style={right}>Brutto</th><th></th></tr></thead>
            <tbody>
              {zinsJahr.map((z) => {
                const saetze = Array.from(new Set(z.zeilen.map((x) => x.zinssatz).filter(Boolean)));
                return (
                  <tr key={z.rechnungsnr}>
                    <td className="mono" style={{ fontWeight: 600 }}>{z.rechnungsnr}{z.warnungen.length > 0 && <AlertTriangle size={12} color={AMBER_DARK} style={{ marginLeft: 4 }} title={z.warnungen.join(" · ")} />}</td>
                    <td className="mono">{dmy(z.perDatum)}</td>
                    <td className="mono" style={right}>{z.durchschnittSaldo ? euro0(z.durchschnittSaldo) : "–"}</td>
                    <td className="mono" style={right}>{saetze.length ? `${Math.min(...saetze).toLocaleString("de-DE", { maximumFractionDigits: 3 })}${saetze.length > 1 ? `–${Math.max(...saetze).toLocaleString("de-DE", { maximumFractionDigits: 3 })}` : ""} %` : "–"}</td>
                    <td className="mono" style={{ ...right, fontWeight: 600 }}>{euro(z.netto)}</td>
                    <td className="mono" style={right}>{euro(z.mwst)}</td>
                    <td className="mono" style={right}>{euro(z.brutto)}</td>
                    <td><button className="ghost" title="Zinsabrechnung löschen" onClick={() => loeschen("z", z.rechnungsnr)} style={{ padding: "2px 5px" }}><Trash2 size={13} /></button></td>
                  </tr>
                );
              })}
              {zinsJahr.length === 0 && <tr><td colSpan={8} style={{ color: TEXT_MUTED }}>Keine Zinsabrechnungen für {jahr}.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <style>{`@media (max-width: 1100px) { .fa-kpi-grid { grid-template-columns: repeat(2, 1fr) !important; } }`}</style>
    </div>
  );
}
