// Einsatzplan: Abwesenheiten (Urlaub/Krank) je Fahrer, tageweise.
// Zeigt die Abwesenheiten der gewählten KW, erlaubt Erfassen/Bearbeiten/Löschen,
// eine Jahresübersicht (Urlaubs-/Krankentage Mo-Fr je Fahrer) und warnt, wenn ein
// Fahrer an einem Abwesenheitstag Touren hat.

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Loader2, AlertTriangle, Palmtree, Thermometer } from "lucide-react";
import * as adb from "./abwesenheitDb";

const MARINE = "#0F2A43";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT = "#16232E";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const AMBER_DARK = "#8A5A10";
const WARN_BG = "#FDF1DD";

const FARBE = { urlaub: ["#E7F1FB", "#1F5F99"], krank: ["#FBEDEA", "#A3412C"] };
const WT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const dmy = (iso) => (iso ? iso.split("-").reverse().join(".") : "");
const kurz = (iso) => { const [, m, d] = iso.split("-"); return `${d}.${m}.`; };

function isoWeekMonday(jahr, kw) {
  const d = new Date(jahr, 0, 4);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + (kw - 1) * 7);
  return d;
}

function Badge({ art }) {
  const [bg, fg] = FARBE[art];
  const Icon = art === "urlaub" ? Palmtree : Thermometer;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 10, background: bg, color: fg }}>
      <Icon size={11} /> {adb.ARTEN[art]}
    </span>
  );
}

export default function Abwesenheiten({ fahrerNamen, jahr, kw, tours, onChanged }) {
  const [liste, setListe] = useState([]);
  const [laden, setLaden] = useState(true);
  const [fehler, setFehler] = useState("");
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [zeigeJahr, setZeigeJahr] = useState(false);

  async function neuLaden() {
    try { setListe(await adb.fetchAbwesenheiten()); setFehler(""); } catch (e) { setFehler("Abwesenheiten konnten nicht geladen werden: " + (e.message || e)); }
    setLaden(false);
  }
  useEffect(() => { neuLaden(); }, []);
  const geaendert = () => { neuLaden(); onChanged && onChanged(); };

  // Auswahl: Stammdaten-Fahrer + alle, die im Jahr Touren haben oder schon Abwesenheiten (z. B. ausgeschiedene Fahrer)
  const namen = useMemo(() => Array.from(new Set([
    ...(fahrerNamen || []),
    ...(tours || []).filter((t) => (t.datum || "").startsWith(`${jahr}-`)).map((t) => (t.fahrer || "").trim()),
    ...liste.map((a) => a.fahrer),
  ].filter(Boolean))).sort((a, b) => a.localeCompare(b, "de")), [fahrerNamen, tours, liste, jahr]);

  const mo = isoWeekMonday(jahr, kw);
  const wStart = adb.isoOf(mo);
  const so = new Date(mo); so.setDate(mo.getDate() + 6);
  const wEnde = adb.isoOf(so);
  const fr = new Date(mo); fr.setDate(mo.getDate() + 4);

  const dieseWoche = liste.filter((a) => a.von <= wEnde && a.bis >= wStart).sort((a, b) => a.fahrer.localeCompare(b.fahrer, "de"));

  // Konflikte: Tour an einem Abwesenheitstag
  const konflikte = useMemo(() => {
    const idx = adb.abwesenheitIndex(liste);
    const seen = new Set();
    const out = [];
    for (const t of tours || []) {
      const f = (t.fahrer || "").trim();
      const d = (t.datum || "").slice(0, 10);
      const art = idx[`${f}|${d}`];
      if (!art || seen.has(`${f}|${d}`)) continue;
      seen.add(`${f}|${d}`);
      out.push({ fahrer: f, datum: d, art, lkw: t.lkw });
    }
    return out.sort((a, b) => b.datum.localeCompare(a.datum));
  }, [liste, tours]);

  const jahresUebersicht = useMemo(() => {
    const js = `${jahr}-01-01`, je = `${jahr}-12-31`;
    const m = {};
    for (const a of liste) {
      if (a.bis < js || a.von > je) continue;
      const n = adb.werktage(a, js, je);
      m[a.fahrer] = m[a.fahrer] || { urlaub: 0, krank: 0, eintraege: 0 };
      m[a.fahrer][a.art] += n;
      m[a.fahrer].eintraege++;
    }
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0], "de"));
  }, [liste, jahr]);

  async function speichern() {
    if (!form.fahrer || !form.von || !form.bis) { setFehler("Bitte Fahrer, von und bis angeben."); return; }
    if (form.bis < form.von) { setFehler("„bis“ liegt vor „von“."); return; }
    const ueberschneidung = liste.find((a) => a.fahrer === form.fahrer && a.id !== form.id && a.von <= form.bis && a.bis >= form.von);
    if (ueberschneidung && !window.confirm(`${form.fahrer} ist ${dmy(ueberschneidung.von)}–${dmy(ueberschneidung.bis)} schon als ${adb.ARTEN[ueberschneidung.art]} eingetragen. Trotzdem speichern?`)) return;
    setBusy(true);
    try {
      if (form.id) await adb.updateAbwesenheit(form.id, form);
      else await adb.addAbwesenheit(form);
      setForm(null);
      geaendert();
    } catch (e) { setFehler(e.message); }
    setBusy(false);
  }
  async function loeschen(a) {
    if (!window.confirm(`${adb.ARTEN[a.art]} ${a.fahrer} ${dmy(a.von)}–${dmy(a.bis)} löschen?`)) return;
    try { await adb.deleteAbwesenheit(a.id); geaendert(); } catch (e) { setFehler(e.message); }
  }

  const tageText = (a) => {
    const n = adb.werktage(a);
    return `${n} Arbeitstag${n === 1 ? "" : "e"}`;
  };

  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 18, marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: TEXT }}>Abwesenheiten (Urlaub / Krank)</div>
          <div style={{ fontSize: 12, color: TEXT_MUTED }}>
            KW {kw}/{jahr} · {kurz(wStart)} – {kurz(adb.isoOf(fr))} · Urlaub und Krank gehören zum Fahrer, nicht zum LKW. Gezählt werden Mo–Fr.
          </div>
        </div>
        <button className="ghost" onClick={() => setForm(form && !form.id ? null : { fahrer: "", art: "urlaub", von: wStart, bis: adb.isoOf(fr), bemerkung: "" })}>
          <Plus size={14} /> Abwesenheit eintragen
        </button>
      </div>

      {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>{fehler}</div>}

      {form && (
        <div style={{ background: "#F7F9FB", border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label>Fahrer</label>
            <select value={form.fahrer} onChange={(e) => setForm({ ...form, fahrer: e.target.value })} style={{ width: 150 }}>
              <option value="">– wählen –</option>
              {namen.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div>
            <label>Art</label>
            <select value={form.art} onChange={(e) => setForm({ ...form, art: e.target.value })} style={{ width: 110 }}>
              <option value="urlaub">Urlaub</option>
              <option value="krank">Krank</option>
            </select>
          </div>
          <div>
            <label>von</label>
            <input type="date" value={form.von} onChange={(e) => setForm({ ...form, von: e.target.value, bis: form.bis < e.target.value ? e.target.value : form.bis })} style={{ width: 145 }} />
          </div>
          <div>
            <label>bis</label>
            <input type="date" value={form.bis} onChange={(e) => setForm({ ...form, bis: e.target.value })} style={{ width: 145 }} />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label>Bemerkung</label>
            <input value={form.bemerkung} onChange={(e) => setForm({ ...form, bemerkung: e.target.value })} />
          </div>
          {form.von && form.bis && form.bis >= form.von && (
            <div style={{ fontSize: 12, color: TEXT_MUTED, paddingBottom: 9 }}>{tageText(form)}</div>
          )}
          <button className="primary" onClick={speichern} disabled={busy}>{busy ? <Loader2 size={14} /> : null} Speichern</button>
          <button className="ghost" onClick={() => setForm(null)}>Abbrechen</button>
        </div>
      )}

      {laden ? (
        <div style={{ color: TEXT_MUTED, fontSize: 13 }}><Loader2 size={14} /> Lade …</div>
      ) : dieseWoche.length === 0 ? (
        <div style={{ color: TEXT_MUTED, fontSize: 13 }}>In dieser Woche ist niemand abwesend.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Fahrer</th><th>Art</th><th>Zeitraum</th><th>Tage</th><th>Bemerkung</th><th></th></tr></thead>
            <tbody>
              {dieseWoche.map((a) => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.fahrer}</td>
                  <td><Badge art={a.art} /></td>
                  <td className="mono" style={{ whiteSpace: "nowrap", fontSize: 12.5 }}>
                    {WT[new Date(a.von + "T12:00").getDay()]} {dmy(a.von)} – {WT[new Date(a.bis + "T12:00").getDay()]} {dmy(a.bis)}
                  </td>
                  <td style={{ fontSize: 12.5, color: TEXT_MUTED, whiteSpace: "nowrap" }}>{tageText(a)}</td>
                  <td style={{ fontSize: 12, color: TEXT_MUTED }}>{a.bemerkung}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="ghost" style={{ padding: "4px 8px" }} onClick={() => setForm({ ...a })}>Bearbeiten</button>
                    <button className="ghost" style={{ padding: "4px 8px", marginLeft: 4 }} onClick={() => loeschen(a)}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {konflikte.length > 0 && (
        <div style={{ fontSize: 12, color: AMBER_DARK, background: WARN_BG, borderRadius: 8, padding: "9px 12px", marginTop: 12 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", fontWeight: 600, marginBottom: 4 }}><AlertTriangle size={13} /> Touren an Abwesenheitstagen ({konflikte.length})</div>
          {konflikte.slice(0, 8).map((k) => `${k.fahrer} ${dmy(k.datum)} (${adb.ARTEN[k.art]}, Tour auf ${k.lkw})`).join(" · ")}
          {konflikte.length > 8 && ` · … und ${konflikte.length - 8} weitere`}
          <div style={{ marginTop: 4 }}>Entweder die Abwesenheit kürzen oder bei der Tour den richtigen Fahrer eintragen.</div>
        </div>
      )}

      <button className="ghost" style={{ marginTop: 12 }} onClick={() => setZeigeJahr(!zeigeJahr)}>
        {zeigeJahr ? "▾" : "▸"} Jahresübersicht {jahr}
      </button>
      {zeigeJahr && (
        <div style={{ overflowX: "auto", marginTop: 8 }}>
          <table>
            <thead><tr><th>Fahrer</th><th style={{ textAlign: "right" }}>Urlaubstage</th><th style={{ textAlign: "right" }}>Krankentage</th><th style={{ textAlign: "right" }}>Einträge</th><th>Zeiträume</th></tr></thead>
            <tbody>
              {jahresUebersicht.map(([f, v]) => (
                <tr key={f}>
                  <td style={{ fontWeight: 600 }}>{f}</td>
                  <td className="mono" style={{ textAlign: "right", color: FARBE.urlaub[1] }}>{v.urlaub || "–"}</td>
                  <td className="mono" style={{ textAlign: "right", color: FARBE.krank[1] }}>{v.krank || "–"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{v.eintraege}</td>
                  <td style={{ fontSize: 11.5, color: TEXT_MUTED }}>
                    {liste.filter((a) => a.fahrer === f && a.bis >= `${jahr}-01-01` && a.von <= `${jahr}-12-31`).map((a) => `${adb.ARTEN[a.art]} ${kurz(a.von)}–${kurz(a.bis)}`).join(" · ")}
                  </td>
                </tr>
              ))}
              {jahresUebersicht.length === 0 && <tr><td colSpan={5} style={{ color: TEXT_MUTED }}>Keine Abwesenheiten in {jahr}.</td></tr>}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 6 }}>Gezählt werden Arbeitstage Mo–Fr innerhalb von {jahr}; Feiertage sind nicht abgezogen.</div>
        </div>
      )}
    </div>
  );
}
