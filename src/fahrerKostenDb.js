// Datenzugriff + Verteilung für den Fuhrpark-Reiter "Fahrerkosten".
// fahrer_kosten: Arbeitgeber-Gesamtkosten je Fahrer und Monat (monat = 1. des Monats).
// Verteilung auf die LKW: über den Einsatzplan - jeder Tag des Monats zählt für
// den LKW, auf dem der Fahrer in dieser Kalenderwoche eingeteilt war (egal ob
// Aktiv, Urlaub oder Krank: der Fahrer gehört in der Woche zu diesem LKW).
// Tage ohne Einteilung -> "nicht zugeordnet".
import { supabase } from "./supabaseClient";

export async function fetchKosten() {
  const { data, error } = await supabase.from("fahrer_kosten").select("*").order("monat");
  if (error) throw error;
  return data.map((r) => ({ fahrer: r.fahrer, monat: r.monat.slice(0, 7), betrag: Number(r.betrag), bemerkung: r.bemerkung || "" }));
}

export async function setKosten(fahrer, monat, betrag) {
  const tag = `${monat}-01`;
  if (betrag === null || betrag === undefined) {
    const { error } = await supabase.from("fahrer_kosten").delete().eq("fahrer", fahrer).eq("monat", tag);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from("fahrer_kosten")
    .upsert({ fahrer, monat: tag, betrag, geaendert_am: new Date().toISOString() }, { onConflict: "fahrer,monat" });
  if (error) throw error;
}

export async function setKostenBulk(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from("fahrer_kosten").upsert(
    rows.map((r) => ({ fahrer: r.fahrer, monat: `${r.monat}-01`, betrag: r.betrag, geaendert_am: new Date().toISOString() })),
    { onConflict: "fahrer,monat" }
  );
  if (error) throw error;
}

// ISO-Kalenderwoche eines Datums -> [isoJahr, kw]
function isoWoche(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const tag = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - tag);
  const jahrStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return [t.getUTCFullYear(), Math.ceil(((t - jahrStart) / 86400000 + 1) / 7)];
}
const pad2 = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const OFFEN = "__nicht_zugeordnet__";

// Index: "fahrer|jahr|kw" -> [lkw, ...]
function einsatzIndex(einsatz) {
  const idx = {};
  for (const e of einsatz || []) {
    const f = (e.fahrer || "").trim();
    if (!f || !e.lkw) continue;
    const k = `${f}|${e.jahr}|${e.kw}`;
    (idx[k] = idx[k] || []).push(e.lkw);
  }
  return idx;
}

// Verteilt jede Monatszeile auf die LKW. Liefert Einzelanteile
// [{ fahrer, monat, lkw, betrag }] (lkw = OFFEN, wenn nicht eingeteilt).
// start/ende (ISO, optional) schneiden den Monat an: es zählen nur die Tage im Zeitraum,
// jeder Tag ist betrag / Tage-im-Monat wert.
export function verteilen(kosten, einsatz, start, ende) {
  const idx = einsatzIndex(einsatz);
  const out = [];
  for (const k of kosten) {
    const [j, m] = k.monat.split("-").map(Number);
    const tage = new Date(j, m, 0).getDate();
    const proTag = k.betrag / tage;
    const anteil = {};
    for (let t = 1; t <= tage; t++) {
      const d = new Date(j, m - 1, t);
      const s = iso(d);
      if ((start && s < start) || (ende && s > ende)) continue;
      const [wj, kw] = isoWoche(d);
      const lkws = idx[`${k.fahrer}|${wj}|${kw}`];
      if (!lkws || !lkws.length) anteil[OFFEN] = (anteil[OFFEN] || 0) + proTag;
      else for (const l of lkws) anteil[l] = (anteil[l] || 0) + proTag / lkws.length;
    }
    for (const [lkw, betrag] of Object.entries(anteil)) out.push({ fahrer: k.fahrer, monat: k.monat, lkw, betrag });
  }
  return out;
}

export function jeLkw(kosten, einsatz, start, ende) {
  const out = {};
  for (const a of verteilen(kosten, einsatz, start, ende)) out[a.lkw] = (out[a.lkw] || 0) + a.betrag;
  return out;
}
