// Fuhrpark-Reiter "Fahrerkosten": Arbeitgeber-Gesamtkosten je Fahrer und Monat
// im Jahresraster erfassen (Eingabe direkt in die Zelle, "wie Vormonat").
// Darunter: automatische Verteilung auf die LKW über den Einsatzplan
// (Tage, an denen der Fahrer in der jeweiligen KW auf dem LKW eingeteilt war).

import { useEffect, useMemo, useState } from "react";
import { Loader2, CopyCheck, RefreshCw, Info } from "lucide-react";
import * as fdb from "./fahrerKostenDb";

const MARINE = "#0F2A43";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT = "#16232E";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS_BG = "#E7F6EF";
const AMBER_DARK = "#8A5A10";
const WARN_BG = "#FDF1DD";

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

export default function FahrerKosten({ drivers, fleet, einsatz, tours }) {
  const heute = new Date();
  const [jahr, setJahr] = useState(heute.getFullYear());
  const [kosten, setKosten] = useState([]);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");
  const [entwurf, setEntwurf] = useState({});
  const [status, setStatus] = useState({});
  const [rollen, setRollen] = useState({});

  async function neuLaden() {
    setFehler("");
    try { const [k, r] = await Promise.all([fdb.fetchKosten(), fdb.fetchRollen()]); setKosten(k); setRollen(r); } catch (e) { setFehler("Fahrerkosten konnten nicht geladen werden: " + (e.message || e)); }
    setLaden(false);
  }
  useEffect(() => { neuLaden(); }, []);

  const monate = MON.map((_, i) => `${jahr}-${pad2(i + 1)}`);
  const map = useMemo(() => Object.fromEntries(kosten.map((k) => [`${k.fahrer}|${k.monat}`, k.betrag])), [kosten]);

  // Zeilen: Fahrer aus den Stammdaten + alle, die im Jahr im Einsatzplan oder in
  // Touren vorkommen (z. B. ausgeschiedene Fahrer) + alle mit erfassten Kosten;
  // "Ersatzfahrer" ans Ende
  const fahrer = useMemo(() => {
    const s = new Set([
      ...(drivers || []).map((d) => d.name || d),
      ...(einsatz || []).filter((e) => e.jahr === jahr).map((e) => e.fahrer),
      ...(tours || []).filter((t) => (t.datum || "").startsWith(`${jahr}-`)).map((t) => t.fahrer),
      ...kosten.filter((k) => k.monat.startsWith(`${jahr}-`)).map((k) => k.fahrer),
    ].map((x) => (x || "").trim()).filter(Boolean));
    return Array.from(s).sort((a, b) => (a === "Ersatzfahrer") - (b === "Ersatzfahrer") || a.localeCompare(b, "de"));
  }, [drivers, einsatz, tours, kosten, jahr]);
  const ftage = useMemo(() => fdb.fahrtage(tours), [tours]);

  async function rolleAendern(f, patch) {
    const neu = { rolle: rollen[f]?.rolle || "fahrer", funktion: rollen[f]?.funktion || "", ...patch };
    try { await fdb.setRolle(f, neu); setRollen((r) => ({ ...r, [f]: neu })); } catch (e) { setFehler("Speichern fehlgeschlagen: " + (e.message || e)); }
  }

  const jahre = useMemo(() => {
    const s = new Set(kosten.map((k) => Number(k.monat.slice(0, 4))));
    for (let j = 2026; j <= heute.getFullYear() + 1; j++) s.add(j);
    return Array.from(s).sort((a, b) => b - a);
  }, [kosten]);

  // Einsatz-Wochen je Fahrer und Monat (Hinweis in der Zelle)
  const verteilung = useMemo(() => fdb.verteilen(kosten.filter((k) => k.monat.startsWith(`${jahr}-`)), einsatz, null, null, { touren: tours, rollen }), [kosten, einsatz, tours, rollen, jahr]);

  async function speichern(f, monat) {
    const key = `${f}|${monat}`;
    if (!(key in entwurf)) return;
    const wert = parseBetrag(entwurf[key]);
    const alt = map[key] ?? null;
    if (Number.isNaN(wert)) { setStatus((s) => ({ ...s, [key]: "fehler" })); return; }
    if (wert === alt) { setEntwurf(({ [key]: _, ...r }) => r); return; }
    setStatus((s) => ({ ...s, [key]: "speichert" }));
    try {
      await fdb.setKosten(f, monat, wert);
      setKosten((ks) => {
        const ohne = ks.filter((k) => !(k.fahrer === f && k.monat === monat));
        return wert === null ? ohne : [...ohne, { fahrer: f, monat, betrag: wert, bemerkung: "" }];
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
    const rows = fahrer
      .filter((f) => map[`${f}|${monat}`] === undefined && map[`${f}|${vor}`] !== undefined)
      .map((f) => ({ fahrer: f, monat, betrag: map[`${f}|${vor}`] }));
    if (!rows.length) return;
    try {
      await fdb.setKostenBulk(rows);
      setKosten((ks) => [...ks, ...rows.map((r) => ({ ...r, bemerkung: "" }))]);
    } catch (e) { setFehler("Übernehmen fehlgeschlagen: " + (e.message || e)); }
  }

  const zeile = (f) => monate.reduce((s, m) => s + (map[`${f}|${m}`] || 0), 0);
  const spalte = (m) => fahrer.reduce((s, f) => s + (map[`${f}|${m}`] || 0), 0);
  const gesamt = monate.reduce((s, m) => s + spalte(m), 0);

  // Verteilung LKW x Monat
  const fleetPlates = (fleet || []).map((f) => f.plate);
  const lkwZeilen = useMemo(() => {
    const keys = Array.from(new Set(verteilung.map((v) => v.lkw)));
    const ordnung = [...fleetPlates, ...keys.filter((k) => k !== fdb.OFFEN && k !== fdb.VERWALTUNG && !fleetPlates.includes(k)).sort(), fdb.VERWALTUNG, fdb.OFFEN];
    return ordnung.filter((k) => keys.includes(k)).map((k) => {
      const proMonat = Object.fromEntries(monate.map((m) => [m, verteilung.filter((v) => v.lkw === k && v.monat === m).reduce((s, v) => s + v.betrag, 0)]));
      return { lkw: k, proMonat, summe: Object.values(proMonat).reduce((s, v) => s + v, 0) };
    });
  }, [verteilung, jahr, fleetPlates.join()]);
  const offen = lkwZeilen.find((z) => z.lkw === fdb.OFFEN);
  // welche Fahrer haben nicht zugeordnete Tage?
  const offenWer = useMemo(() => {
    const m = {};
    for (const v of verteilung) if (v.lkw === fdb.OFFEN) m[v.fahrer] = (m[v.fahrer] || 0) + v.betrag;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [verteilung]);

  if (laden) return <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Fahrerkosten …</div>;

  const inputStil = (key, hatWert) => {
    const st = status[key];
    return {
      width: 88, textAlign: "right", padding: "5px 6px", fontSize: 12.5, fontFamily: "inherit",
      background: st === "ok" ? SUCCESS_BG : st === "fehler" ? DANGER_BG : hatWert ? "#FFFFFF" : "#F7F9FB",
      borderColor: st === "fehler" ? DANGER : undefined,
    };
  };

  return (
    <div>
      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
          <div style={{ ...h2, marginBottom: 0 }}>Fahrerkosten je Monat</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ margin: 0 }}>Jahr</label>
            <select value={jahr} onChange={(e) => setJahr(Number(e.target.value))} style={{ width: 100 }}>
              {jahre.map((j) => <option key={j} value={j}>{j}</option>)}
            </select>
            <button className="ghost" onClick={neuLaden}><RefreshCw size={14} /></button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 12 }}>
          Je Fahrer die <b>Arbeitgeber-Gesamtkosten</b> des Monats eintragen (Bruttolohn + Arbeitgeberanteile Sozialversicherung + Spesen, z. B. <span className="mono">3.850,00</span>).
          Gespeichert wird beim Verlassen der Zelle, leere Zelle löscht. „wie Vormonat“ füllt leere Zellen mit dem Vormonatswert.
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: CARD, zIndex: 1 }}>Fahrer</th>
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
              {fahrer.map((f) => (
                <tr key={f}>
                  <td style={{ position: "sticky", left: 0, background: CARD, zIndex: 1, whiteSpace: "nowrap" }}>
                    <div style={{ fontWeight: 600 }}>{f}</div>
                    <select value={rollen[f]?.rolle || "fahrer"} onChange={(e) => rolleAendern(f, { rolle: e.target.value })}
                      title="Fahrer: Monatskosten komplett auf die LKW (über den Einsatzplan). Anteilig: nur Fahrtage aus den Touren, Rest = Verwaltung/Büro."
                      style={{ width: 150, padding: "2px 4px", fontSize: 11, marginTop: 3 }}>
                      <option value="fahrer">Fahrer (voll auf LKW)</option>
                      <option value="anteilig">anteilig nach Fahrtagen</option>
                    </select>
                    {rollen[f]?.funktion && <div style={{ fontSize: 10.5, color: TEXT_MUTED, marginTop: 2 }}>{rollen[f].funktion}</div>}
                  </td>
                  {monate.map((m) => {
                    const key = `${f}|${m}`;
                    const wert = map[key];
                    return (
                      <td key={m} style={{ padding: "6px 4px" }}>
                        <input className="mono" inputMode="decimal" value={key in entwurf ? entwurf[key] : fmt(wert)} placeholder="–"
                          onChange={(e) => setEntwurf((d) => ({ ...d, [key]: e.target.value }))}
                          onBlur={() => speichern(f, m)}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEntwurf(({ [key]: _, ...r }) => r); }}
                          disabled={status[key] === "speichert"} style={inputStil(key, wert !== undefined)} />
                      </td>
                    );
                  })}
                  <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE, whiteSpace: "nowrap" }}>{zeile(f) ? euro2(zeile(f)) : "–"}</td>
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
      </div>

      <div style={card}>
        <div style={h2}>Verteilung auf die LKW {jahr}</div>
        <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 12 }}>
          <b>Fahrer (voll auf LKW):</b> jeder Tag zählt für den LKW, auf dem der Fahrer in dieser Kalenderwoche im Einsatzplan eingeteilt war – auch bei Urlaub oder Krankheit;
          ohne Einteilung landet der Betrag unter „nicht zugeordnet“. <b>Anteilig nach Fahrtagen:</b> jeder Tag mit Tour geht auf den gefahrenen LKW, der Rest des Gehalts
          unter „Verwaltung/Büro“. Die LKW-Zeilen fließen in die Fuhrpark-Übersicht.
        </div>
        {lkwZeilen.length === 0 ? (
          <div style={{ color: TEXT_MUTED, fontSize: 13 }}>Für {jahr} sind noch keine Fahrerkosten erfasst.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>LKW</th>{MON.map((m) => <th key={m} style={right}>{m}</th>)}<th style={right}>Summe</th></tr>
              </thead>
              <tbody>
                {lkwZeilen.map((z) => {
                  const off = z.lkw === fdb.OFFEN;
                  const verw = z.lkw === fdb.VERWALTUNG;
                  return (
                    <tr key={z.lkw} style={off ? { background: WARN_BG } : verw ? { background: "#F4F6F8", borderTop: `2px solid ${BORDER}` } : undefined}>
                      <td className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap", color: off ? AMBER_DARK : verw ? TEXT_MUTED : undefined }}>
                        {off ? "nicht zugeordnet" : verw ? "Verwaltung/Büro" : z.lkw}
                        {verw && <div style={{ fontSize: 10.5, fontWeight: 400 }}>nicht in den LKW-Kosten</div>}
                      </td>
                      {monate.map((m) => <td key={m} className="mono" style={{ ...right, fontSize: 12 }}>{z.proMonat[m] ? euro(z.proMonat[m]) : "–"}</td>)}
                      <td className="mono" style={{ ...right, fontWeight: 600, color: off ? AMBER_DARK : verw ? TEXT_MUTED : MARINE }}>{euro(z.summe)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {fahrer.some((f) => rollen[f]?.rolle === "anteilig") && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 6 }}>Fahranteil (Personen mit anderer Hauptaufgabe)</div>
            <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 8 }}>
              Fahrtage = Tage mit mindestens einer Tour in der Tourenliste. Anteil = Fahrtage ÷ Arbeitstage (Mo–Fr) des Monats, höchstens 100 %.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Person</th>{MON.map((m) => <th key={m} style={right}>{m}</th>)}</tr></thead>
                <tbody>
                  {fahrer.filter((f) => rollen[f]?.rolle === "anteilig").map((f) => (
                    <tr key={f}>
                      <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{f}{rollen[f]?.funktion && <span style={{ fontWeight: 400, color: TEXT_MUTED, fontSize: 11 }}> · {rollen[f].funktion}</span>}</td>
                      {monate.map((m, i) => {
                        const n = ftage[`${f}|${m}`] || 0;
                        const at = fdb.arbeitstage(jahr, i + 1);
                        return (
                          <td key={m} className="mono" style={{ ...right, fontSize: 11.5, whiteSpace: "nowrap", color: n ? TEXT : TEXT_MUTED }}>
                            {n ? <>{n}/{at}<div style={{ fontSize: 10.5, color: TEXT_MUTED }}>{Math.min(100, Math.round((n / at) * 100))} %</div></> : "–"}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {offen && offen.summe > 0.5 && (
          <div style={{ fontSize: 12, color: AMBER_DARK, background: WARN_BG, borderRadius: 8, padding: "9px 12px", marginTop: 12, display: "flex", gap: 8 }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>
              Nicht zugeordnet, weil der Fahrer in diesen Wochen im Einsatzplan nicht eingeteilt ist:{" "}
              {offenWer.map(([f, b]) => `${f} ${euro(b)}`).join(" · ")}. Im Einsatzplan eintragen, dann verteilt es sich automatisch.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
