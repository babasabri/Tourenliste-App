// Fuhrpark-Reiter "Leasing/Miete": monatliche Raten (netto) je Fahrzeug in
// einem Jahresraster erfassen. Eingabe direkt in die Zelle, gespeichert wird
// beim Verlassen der Zelle (leere Zelle = Rate löschen). "wie Vormonat" füllt
// leere Zellen eines Monats mit der Rate des Vormonats.
// Die Raten fließen in die Fuhrpark-Übersicht (Kosten je LKW, Kosten/km) ein.

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, CopyCheck, RefreshCw } from "lucide-react";
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
const euro = (n) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }) : "–");
const fmt = (n) => (n === undefined || n === null ? "" : n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
// "1.234,56" / "1234,56" / "1234.56" -> 1234.56 ; "" -> null ; Unsinn -> NaN
function parseBetrag(s) {
  const t = String(s || "").trim().replace(/€/g, "").replace(/\s/g, "");
  if (!t) return null;
  let n;
  if (t.includes(",")) n = Number(t.replace(/\./g, "").replace(",", "."));
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) n = Number(t.replace(/\./g, ""));
  else n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

const BADGE = { Leasing: ["#E4ECF5", MARINE], Miete: ["#FDF1DD", "#8A5A10"], Eigentum: ["#E7F6EF", "#2F8F6B"] };
function Badge({ art }) {
  const [bg, fg] = BADGE[art] || BADGE.Leasing;
  return (
    <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 7px", borderRadius: 10, background: bg, color: fg }}>
      {art === "Eigentum" ? "Eigentum (abbezahlt)" : art}
    </span>
  );
}
const ARTEN = [["Leasing", "Leasing"], ["Miete", "Miete"], ["Eigentum", "Eigentum (abbezahlt)"]];
const dmy = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "");

export default function Leasing() {
  const heute = new Date();
  const [jahr, setJahr] = useState(heute.getFullYear());
  const [fahrzeuge, setFahrzeuge] = useState([]);
  const [raten, setRaten] = useState([]);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");
  const [entwurf, setEntwurf] = useState({}); // "kz|2026-01" -> Text während der Eingabe
  const [status, setStatus] = useState({}); // "kz|2026-01" -> "speichert" | "ok" | "fehler"
  const [neu, setNeu] = useState({ kennzeichen: "", art: "Miete" });

  async function neuLaden() {
    setLaden(true);
    setFehler("");
    try {
      const [f, r] = await Promise.all([ldb.fetchFahrzeuge(), ldb.fetchRaten()]);
      setFahrzeuge(f);
      setRaten(r);
    } catch (e) {
      setFehler("Leasing/Miete konnte nicht geladen werden: " + (e.message || e));
    }
    setLaden(false);
  }
  useEffect(() => { neuLaden(); }, []);

  const rateMap = useMemo(() => Object.fromEntries(raten.map((r) => [`${r.kennzeichen}|${r.monat}`, r.betrag])), [raten]);
  const monate = MON.map((_, i) => `${jahr}-${pad2(i + 1)}`);
  const jahre = useMemo(() => {
    const s = new Set(raten.map((r) => Number(r.monat.slice(0, 4))));
    for (let j = 2026; j <= heute.getFullYear() + 1; j++) s.add(j);
    return Array.from(s).sort((a, b) => b - a);
  }, [raten]);

  async function speichern(kz, monat) {
    const key = `${kz}|${monat}`;
    if (!(key in entwurf)) return;
    const wert = parseBetrag(entwurf[key]);
    const alt = rateMap[key] ?? null;
    if (Number.isNaN(wert)) { setStatus((s) => ({ ...s, [key]: "fehler" })); return; }
    if (wert === alt) {
      setEntwurf(({ [key]: _, ...rest }) => rest);
      return;
    }
    setStatus((s) => ({ ...s, [key]: "speichert" }));
    try {
      await ldb.setRate(kz, monat, wert);
      setRaten((rs) => {
        const ohne = rs.filter((r) => !(r.kennzeichen === kz && r.monat === monat));
        return wert === null ? ohne : [...ohne, { kennzeichen: kz, monat, betrag: wert, bemerkung: "" }];
      });
      setEntwurf(({ [key]: _, ...rest }) => rest);
      setStatus((s) => ({ ...s, [key]: "ok" }));
      setTimeout(() => setStatus(({ [key]: _, ...rest }) => rest), 1200);
    } catch (e) {
      setStatus((s) => ({ ...s, [key]: "fehler" }));
      setFehler("Speichern fehlgeschlagen: " + (e.message || e));
    }
  }

  async function wieVormonat(idx) {
    const monat = monate[idx];
    const vor = idx === 0 ? `${jahr - 1}-12` : monate[idx - 1];
    const rows = fahrzeuge
      .filter((f) => !ldb.nachAbbezahlt(f, monat) && rateMap[`${f.kennzeichen}|${monat}`] === undefined && rateMap[`${f.kennzeichen}|${vor}`] !== undefined)
      .map((f) => ({ kennzeichen: f.kennzeichen, monat, betrag: rateMap[`${f.kennzeichen}|${vor}`] }));
    if (!rows.length) return;
    try {
      await ldb.setRatenBulk(rows);
      setRaten((rs) => [...rs, ...rows.map((r) => ({ ...r, bemerkung: "" }))]);
    } catch (e) {
      setFehler("Übernehmen fehlgeschlagen: " + (e.message || e));
    }
  }

  async function fahrzeugAendern(kz, patch) {
    try {
      await ldb.updateFahrzeug(kz, patch);
      setFahrzeuge((fs) => fs.map((f) => (f.kennzeichen === kz ? { ...f, ...patch } : f)));
    } catch (e) {
      setFehler("Speichern fehlgeschlagen: " + (e.message || e));
    }
  }

  async function fahrzeugAnlegen() {
    const kz = neu.kennzeichen.trim().toUpperCase().replace(/\s+/g, " ");
    if (!kz) return;
    try {
      await ldb.addFahrzeug({ kennzeichen: kz, art: neu.art });
      setNeu({ kennzeichen: "", art: "Miete" });
      neuLaden();
    } catch (e) {
      setFehler(e.message || String(e));
    }
  }

  async function fahrzeugLoeschen(f) {
    const n = raten.filter((r) => r.kennzeichen === f.kennzeichen).length;
    if (!window.confirm(`${f.kennzeichen} aus Leasing/Miete entfernen?${n ? ` Dabei werden auch ${n} erfasste Rate(n) gelöscht.` : ""}`)) return;
    try {
      await ldb.deleteFahrzeug(f.kennzeichen);
      neuLaden();
    } catch (e) {
      setFehler("Löschen fehlgeschlagen: " + (e.message || e));
    }
  }

  const zeileSumme = (kz) => monate.reduce((s, m) => s + (rateMap[`${kz}|${m}`] || 0), 0);
  const spalteSumme = (m) => fahrzeuge.reduce((s, f) => s + (rateMap[`${f.kennzeichen}|${m}`] || 0), 0);
  const jahrSumme = monate.reduce((s, m) => s + spalteSumme(m), 0);

  if (laden) return <div style={{ padding: 30, color: TEXT_MUTED, display: "flex", gap: 8, alignItems: "center" }}><Loader2 size={16} /> Lade Leasing/Miete …</div>;

  const inputStil = (key, hatWert) => {
    const st = status[key];
    return {
      width: 84, textAlign: "right", padding: "5px 6px", fontSize: 12.5, fontFamily: "inherit",
      background: st === "ok" ? SUCCESS_BG : st === "fehler" ? DANGER_BG : hatWert ? "#FFFFFF" : "#F7F9FB",
      borderColor: st === "fehler" ? DANGER : undefined,
    };
  };

  return (
    <div>
      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>{fehler}</div>}

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
          <div style={{ ...h2, marginBottom: 0 }}>Monatliche Raten (netto)</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ margin: 0 }}>Jahr</label>
            <select value={jahr} onChange={(e) => setJahr(Number(e.target.value))} style={{ width: 100 }}>
              {jahre.map((j) => <option key={j} value={j}>{j}</option>)}
            </select>
            <button className="ghost" onClick={neuLaden}><RefreshCw size={14} /></button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 12 }}>
          Betrag in die Zelle tippen (z. B. <span className="mono">1.850,00</span>) – gespeichert wird beim Verlassen der Zelle, leere Zelle löscht die Rate.
          „wie Vormonat“ füllt die leeren Zellen eines Monats mit der Rate aus dem Monat davor. Nach dem Abbezahlt-Datum steht „abbezahlt“ (Doppelklick, falls doch noch eine Rate kam).
          Schlussraten gehören nicht ins Raster, sondern unten zum Vertrag.
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: CARD, zIndex: 1 }}>Fahrzeug</th>
                {MON.map((m, i) => (
                  <th key={m} style={{ ...right, whiteSpace: "nowrap" }}>
                    <div>{m}</div>
                    <button className="ghost" title="Leere Zellen mit der Rate des Vormonats füllen" onClick={() => wieVormonat(i)}
                      style={{ padding: "1px 5px", fontSize: 10, marginTop: 3, fontWeight: 500 }}>
                      <CopyCheck size={11} /> wie Vormonat
                    </button>
                  </th>
                ))}
                <th style={right}>Summe {jahr}</th>
              </tr>
            </thead>
            <tbody>
              {fahrzeuge.map((f) => (
                <tr key={f.kennzeichen}>
                  <td style={{ position: "sticky", left: 0, background: CARD, zIndex: 1, whiteSpace: "nowrap" }}>
                    <div className="mono" style={{ fontWeight: 600 }}>{f.kennzeichen}</div>
                    <Badge art={f.art} />
                    {f.abbezahltAm && <div style={{ fontSize: 10.5, color: TEXT_MUTED, marginTop: 2 }}>abbezahlt {dmy(f.abbezahltAm)}</div>}
                  </td>
                  {monate.map((m) => {
                    const key = `${f.kennzeichen}|${m}`;
                    const wert = rateMap[key];
                    if (wert === undefined && !(key in entwurf) && ldb.nachAbbezahlt(f, m)) {
                      return (
                        <td key={m} style={{ padding: "6px 4px" }}>
                          <div title={`Abbezahlt am ${dmy(f.abbezahltAm)} – keine Rate mehr`} onDoubleClick={() => setEntwurf((d) => ({ ...d, [key]: "" }))}
                            style={{ width: 84, textAlign: "center", fontSize: 10.5, color: "#2F8F6B", padding: "6px 0", background: "#F1F8F4", borderRadius: 6 }}>
                            abbezahlt
                          </div>
                        </td>
                      );
                    }
                    return (
                      <td key={m} style={{ padding: "6px 4px" }}>
                        <input className="mono" inputMode="decimal" value={key in entwurf ? entwurf[key] : fmt(wert)} placeholder="–"
                          onChange={(e) => setEntwurf((d) => ({ ...d, [key]: e.target.value }))}
                          onBlur={() => speichern(f.kennzeichen, m)}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setEntwurf(({ [key]: _, ...rest }) => rest); }}
                          disabled={status[key] === "speichert"}
                          style={inputStil(key, wert !== undefined)} />
                      </td>
                    );
                  })}
                  <td className="mono" style={{ ...right, fontWeight: 600, color: MARINE, whiteSpace: "nowrap" }}>{zeileSumme(f.kennzeichen) ? euro(zeileSumme(f.kennzeichen)) : "–"}</td>
                </tr>
              ))}
              <tr style={{ borderTop: `2px solid ${BORDER}` }}>
                <td style={{ position: "sticky", left: 0, background: CARD, fontWeight: 600 }}>Summe</td>
                {monate.map((m) => <td key={m} className="mono" style={{ ...right, fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" }}>{spalteSumme(m) ? euro(spalteSumme(m)) : "–"}</td>)}
                <td className="mono" style={{ ...right, fontWeight: 700, color: MARINE, whiteSpace: "nowrap" }}>{euro(jahrSumme)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style={card}>
        <div style={h2}>Fahrzeuge & Verträge</div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Kennzeichen</th><th>Art</th><th>Leasinggeber / Vermieter</th><th>Vertrags-Nr.</th>
                <th>abbezahlt am</th><th>Schlussrate am</th><th style={right}>Schlussrate netto</th>
                <th>Bemerkung</th><th style={right}>Raten erfasst</th><th></th>
              </tr>
            </thead>
            <tbody>
              {fahrzeuge.map((f) => (
                <tr key={f.kennzeichen}>
                  <td className="mono" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{f.kennzeichen}</td>
                  <td>
                    <select value={f.art} onChange={(e) => fahrzeugAendern(f.kennzeichen, { art: e.target.value })} style={{ width: 170 }}>
                      {ARTEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  {["vertragspartner", "vertragNr"].map((feld) => (
                    <td key={feld}>
                      <input defaultValue={f[feld]} key={`${f.kennzeichen}-${feld}-${f[feld]}`}
                        onBlur={(e) => { if (e.target.value !== f[feld]) fahrzeugAendern(f.kennzeichen, { [feld]: e.target.value }); }}
                        style={{ minWidth: 140 }} />
                    </td>
                  ))}
                  {["abbezahltAm", "schlussrateDatum"].map((feld) => (
                    <td key={feld}>
                      <input type="date" value={f[feld]} onChange={(e) => fahrzeugAendern(f.kennzeichen, { [feld]: e.target.value })} style={{ width: 140 }} />
                    </td>
                  ))}
                  <td>
                    <input className="mono" inputMode="decimal" placeholder="–" key={`${f.kennzeichen}-sr-${f.schlussrateBetrag}`} defaultValue={fmt(f.schlussrateBetrag)}
                      onBlur={(e) => {
                        const v = parseBetrag(e.target.value);
                        if (Number.isNaN(v)) { setFehler(`Schlussrate ${f.kennzeichen}: „${e.target.value}“ ist kein Betrag`); return; }
                        if (v !== f.schlussrateBetrag) fahrzeugAendern(f.kennzeichen, { schlussrateBetrag: v });
                      }}
                      style={{ width: 110, textAlign: "right" }} />
                  </td>
                  {["bemerkung"].map((feld) => (
                    <td key={feld}>
                      <input defaultValue={f[feld]} key={`${f.kennzeichen}-${feld}-${f[feld]}`}
                        onBlur={(e) => { if (e.target.value !== f[feld]) fahrzeugAendern(f.kennzeichen, { [feld]: e.target.value }); }}
                        style={{ minWidth: 200 }} />
                    </td>
                  ))}
                  <td className="mono" style={right}>{raten.filter((r) => r.kennzeichen === f.kennzeichen).length}</td>
                  <td><button className="ghost" title="Fahrzeug entfernen" onClick={() => fahrzeugLoeschen(f)} style={{ padding: "4px 8px" }}><Trash2 size={13} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <label>Weiteres Fahrzeug</label>
            <input placeholder="Kennzeichen, z. B. F-AB 123" value={neu.kennzeichen} onChange={(e) => setNeu({ ...neu, kennzeichen: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && fahrzeugAnlegen()} style={{ width: 200 }} />
          </div>
          <div>
            <label>Art</label>
            <select value={neu.art} onChange={(e) => setNeu({ ...neu, art: e.target.value })} style={{ width: 170 }}>
              {ARTEN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <button className="ghost" onClick={fahrzeugAnlegen} disabled={!neu.kennzeichen.trim()}><Plus size={14} /> Anlegen</button>
        </div>
      </div>
    </div>
  );
}
