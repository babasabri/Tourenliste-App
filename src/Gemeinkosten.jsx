// Fuhrpark-Reiter "Gemeinkosten": Kosten, die keinem einzelnen LKW gehören
// (Büro & Verwaltung, Berater & Gebühren, Factoring, allgemeine Versicherungen …),
// monatlich im Jahresraster erfassen. Darunter die automatische Verteilung auf
// die LKW: eigene LKW gleichmäßig, Miet-SZM nur für ihren Mietzeitraum.

import { useEffect, useMemo, useState } from "react";
import { Loader2, CopyCheck, RefreshCw, Plus, Trash2 } from "lucide-react";
import * as gdb from "./gemeinkostenDb";
import * as ldb from "./leasingDb";

const MARINE = "#0F2A43";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT = "#16232E";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS_BG = "#E7F6EF";

const MON = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const card = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 20 };
const h2 = { fontSize: 15, fontWeight: 600, marginBottom: 12, color: TEXT };
const right = { textAlign: "right" };
const pad2 = (n) => String(n).padStart(2, "0");
const euro = (n) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }) : "–");
const euro2 = (n) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }) : "–");
const fmt = (n) => (n === undefined || n === null ? "" : n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function parseBetrag(s) {
  const t = String(s || "").trim().replace(/€/g, "").replace(/\s/g, "");
  if (!t) return null;
  let n;
  if (t.includes(",")) n = Number(t.replace(/\./g, "").replace(",", "."));
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) n = Number(t.replace(/\./g, ""));
  else n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

export default function Gemeinkosten({ fleet }) {
  const heute = new Date();
  const [jahr, setJahr] = useState(heute.getFullYear());
  const [posten, setPosten] = useState([]);
  const [kosten, setKosten] = useState([]);
  const [vertraege, setVertraege] = useState([]);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");
  const [entwurf, setEntwurf] = useState({});
  const [status, setStatus] = useState({});
  const [neu, setNeu] = useState({ name: "", kategorie: gdb.KATEGORIEN[0] });

  async function neuLaden() {
    setFehler("");
    try {
      const [p, k, v] = await Promise.all([gdb.fetchPosten(), gdb.fetchKosten(), ldb.fetchFahrzeuge()]);
      setPosten(p); setKosten(k); setVertraege(v);
    } catch (e) { setFehler("Gemeinkosten konnten nicht geladen werden: " + (e.message || e)); }
    setLaden(false);
  }
  useEffect(() => { neuLaden(); }, []);

  const monate = MON.map((_, i) => `${jahr}-${pad2(i + 1)}`);
  const map = useMemo(() => Object.fromEntries(kosten.map((k) => [`${k.posten}|${k.monat}`, k.betrag])), [kosten]);
  const jahre = useMemo(() => {
    const s = new Set(kosten.map((k) => Number(k.monat.slice(0, 4))));
    for (let j = 2026; j <= heute.getFullYear() + 1; j++) s.add(j);
    return Array.from(s).sort((a, b) => b - a);
  }, [kosten]);

  async function speichern(p, monat) {
    const key = `${p}|${monat}`;
    if (!(key in entwurf)) return;
    const wert = parseBetrag(entwurf[key]);
    const alt = map[key] ?? null;
    if (Number.isNaN(wert)) { setStatus((s) => ({ ...s, [key]: "fehler" })); return; }
    if (wert === alt) { setEntwurf(({ [key]: _, ...r }) => r); return; }
    setStatus((s) => ({ ...s, [key]: "speichert" }));
    try {
      await gdb.setKosten(p, monat, wert);
      setKosten((ks) => {
        const ohne = ks.filter((k) => !(k.posten === p && k.monat === monat));
        return wert === null ? ohne : [...ohne, { posten: p, monat, betrag: wert, bemerkung: "" }];
      });
      setEntwurf(({ [key]: _, ...r }) => r);
      setStatus((s) => ({ ...s, [key]: "ok" }));
      setTimeout(() => setStatus(({ [key]: _, ...r }) => r), 1200);
    } catch (e) {
      setStatus((s) => ({ ...s, [key]: "fehler" }));
      setFehler("Speichern fehlgeschlagen: " + (e.message || e));
    }
  }

  async function wieVormonat(i) {
    const monat = monate[i];
    const vor = i === 0 ? `${jahr - 1}-12` : monate[i - 1];
    const rows = posten
      .filter((p) => map[`${p.name}|${monat}`] === undefined && map[`${p.name}|${vor}`] !== undefined)
      .map((p) => ({ posten: p.name, monat, betrag: map[`${p.name}|${vor}`] }));
    if (!rows.length) return;
    try {
      await gdb.setKostenBulk(rows);
      setKosten((ks) => [...ks, ...rows.map((r) => ({ ...r, bemerkung: "" }))]);
    } catch (e) { setFehler("Übernehmen fehlgeschlagen: " + (e.message || e)); }
  }

  async function postenAnlegen() {
    const name = neu.name.trim();
    if (!name) return;
    try { await gdb.addPosten({ name, kategorie: neu.kategorie }); setNeu({ ...neu, name: "" }); await neuLaden(); }
    catch (e) { setFehler(e.message || String(e)); }
  }
  async function postenLoeschen(p) {
    if (!window.confirm(`Zeile „${p.name}“ entfernen?`)) return;
    try { await gdb.deletePosten(p.name); await neuLaden(); } catch (e) { setFehler(e.message || String(e)); }
  }

  const zeile = (p) => monate.reduce((s, m) => s + (map[`${p}|${m}`] || 0), 0);
  const spalte = (m) => posten.reduce((s, p) => s + (map[`${p.name}|${m}`] || 0), 0);
  const gesamt = monate.reduce((s, m) => s + spalte(m), 0);

  // Verteilung LKW x Monat
  const verteilung = useMemo(() => gdb.verteilen(kosten.filter((k) => k.monat.startsWith(`${jahr}-`)), fleet, vertraege, null, null), [kosten, fleet, vertraege, jahr]);
  const fleetPlates = (fleet || []).map((f) => f.plate);
  const mietSet = new Set(vertraege.filter((v) => v.art === "Miete" && (v.typ || "LKW") === "LKW").map((v) => v.kennzeichen));
  const lkwZeilen = useMemo(() => {
    const keys = Array.from(new Set(verteilung.map((v) => v.lkw)));
    return fleetPlates.filter((k) => keys.includes(k)).map((k) => {
      const proMonat = Object.fromEntries(monate.map((m) => [m, verteilung.filter((v) => v.lkw === k && v.monat === m).reduce((s, v) => s + v.betrag, 0)]));
      return { lkw: k, proMonat, summe: Object.values(proMonat).reduce((s, v) => s + v, 0) };
    });
  }, [verteilung, jahr, fleetPlates.join()]);

  if (laden) return <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Gemeinkosten …</div>;

  const inputStil = (key, hatWert) => {
    const st = status[key];
    return {
      width: 88, textAlign: "right", padding: "5px 6px", fontSize: 12.5, fontFamily: "inherit",
      background: st === "ok" ? SUCCESS_BG : st === "fehler" ? DANGER_BG : hatWert ? "#FFFFFF" : "#F7F9FB",
      borderColor: st === "fehler" ? DANGER : undefined,
    };
  };

  const mietTxt = fleetPlates.filter((p) => mietSet.has(p)).map((p) => {
    const f = (fleet || []).find((x) => x.plate === p);
    const d = (s) => (s ? s.split("-").reverse().join(".") : "");
    return `${p} ${f?.einsatzVon ? `ab ${d(f.einsatzVon)}` : "(kein Mietbeginn in den Stammdaten)"}${f?.einsatzBis ? ` bis ${d(f.einsatzBis)}` : ""}`;
  });

  return (
    <div>
      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
          <div style={{ ...h2, marginBottom: 0 }}>Gemeinkosten je Monat</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ margin: 0 }}>Jahr</label>
            <select value={jahr} onChange={(e) => setJahr(Number(e.target.value))} style={{ width: 100 }}>
              {jahre.map((j) => <option key={j} value={j}>{j}</option>)}
            </select>
            <button className="ghost" onClick={neuLaden}><RefreshCw size={14} /></button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 12 }}>
          Beträge <b>netto</b> je Monat eintragen (z. B. <span className="mono">1.250,00</span>). Gespeichert wird beim Verlassen der Zelle, leere Zelle löscht.
          „wie Vormonat“ füllt leere Zellen mit dem Vormonatswert. Eigene Zeilen (z. B. „Steuerberater“, „Büromiete“) unten anlegen.
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: CARD, zIndex: 1 }}>Posten</th>
                {MON.map((m, i) => (
                  <th key={m} style={{ ...right, whiteSpace: "nowrap" }}>
                    <div>{m}</div>
                    <button className="ghost" title="Leere Zellen mit dem Wert des Vormonats füllen" onClick={() => wieVormonat(i)} style={{ padding: "1px 5px", fontSize: 10, marginTop: 3, fontWeight: 500 }}>
                      <CopyCheck size={11} /> wie Vormonat
                    </button>
                  </th>
                ))}
                <th style={right}>Summe {jahr}</th>
              </tr>
            </thead>
            <tbody>
              {posten.map((p) => (
                <tr key={p.name}>
                  <td style={{ position: "sticky", left: 0, background: CARD, zIndex: 1, whiteSpace: "nowrap" }}>
                    <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                      {p.name}
                      {!kosten.some((k) => k.posten === p.name) && (
                        <button className="ghost" title="Zeile entfernen" onClick={() => postenLoeschen(p)} style={{ padding: "1px 4px" }}><Trash2 size={12} /></button>
                      )}
                    </div>
                    {p.kategorie !== p.name && <div style={{ fontSize: 10.5, color: TEXT_MUTED }}>{p.kategorie}</div>}
                  </td>
                  {monate.map((m) => {
                    const key = `${p.name}|${m}`;
                    const wert = map[key];
                    return (
                      <td key={m} style={{ padding: "6px 4px" }}>
                        <input className="mono" inputMode="decimal" value={key in entwurf ? entwurf[key] : fmt(wert)} placeholder="–"
                          onChange={(e) => setEntwurf((d) => ({ ...d, [key]: e.target.value }))}
                          onBlur={() => speichern(p.name, m)}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEntwurf(({ [key]: _, ...r }) => r); }}
                          disabled={status[key] === "speichert"} style={inputStil(key, wert !== undefined)} />
                      </td>
                    );
                  })}
                  <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE, whiteSpace: "nowrap" }}>{zeile(p.name) ? euro2(zeile(p.name)) : "–"}</td>
                </tr>
              ))}
              <tr style={{ borderTop: `2px solid ${BORDER}` }}>
                <td style={{ position: "sticky", left: 0, background: CARD, fontWeight: 600 }}>Summe</td>
                {monate.map((m) => <td key={m} className="mono" style={{ ...right, fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" }}>{spalte(m) ? euro(spalte(m)) : "–"}</td>)}
                <td className="mono" style={{ ...right, fontWeight: 700, color: MARINE, whiteSpace: "nowrap" }}>{euro2(gesamt)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 14, flexWrap: "wrap" }}>
          <div>
            <label>Neue Zeile</label>
            <input value={neu.name} placeholder="z. B. Steuerberater" onChange={(e) => setNeu({ ...neu, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") postenAnlegen(); }} style={{ width: 200 }} />
          </div>
          <div>
            <label>Kategorie</label>
            <select value={neu.kategorie} onChange={(e) => setNeu({ ...neu, kategorie: e.target.value })} style={{ width: 210 }}>
              {gdb.KATEGORIEN.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <button className="ghost" onClick={postenAnlegen} disabled={!neu.name.trim()}><Plus size={14} /> Zeile anlegen</button>
        </div>
      </div>

      <div style={card}>
        <div style={h2}>Verteilung auf die LKW {jahr}</div>
        <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 12 }}>
          Tagesgenau: jeder Tag des Monats wird zu gleichen Teilen auf die LKW verteilt, die an diesem Tag zum Fuhrpark gehören.
          <b> Eigene LKW</b> tragen immer mit, egal ob sie fahren. <b>Miet-SZM</b> tragen nur in ihrem Mietzeitraum mit
          {mietTxt.length > 0 && <> ({mietTxt.join(" · ")}, aus den Stammdaten)</>}. Die LKW-Zeilen fließen in die Fuhrpark-Übersicht.
        </div>
        {lkwZeilen.length === 0 ? (
          <div style={{ color: TEXT_MUTED, fontSize: 13 }}>Für {jahr} sind noch keine Gemeinkosten erfasst.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>LKW</th>{MON.map((m) => <th key={m} style={right}>{m}</th>)}<th style={right}>Summe</th></tr>
              </thead>
              <tbody>
                {lkwZeilen.map((z) => (
                  <tr key={z.lkw}>
                    <td className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                      {z.lkw}
                      {mietSet.has(z.lkw) && <div style={{ fontSize: 10.5, fontWeight: 400, color: TEXT_MUTED, fontFamily: "inherit" }}>Miet-SZM</div>}
                    </td>
                    {monate.map((m) => <td key={m} className="mono" style={{ ...right, fontSize: 12 }}>{z.proMonat[m] ? euro(z.proMonat[m]) : "–"}</td>)}
                    <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE }}>{euro(z.summe)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
