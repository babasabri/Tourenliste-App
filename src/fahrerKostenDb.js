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

export async function fetchRollen() {
  const { data, error } = await supabase.from("fahrer_rolle").select("*");
  if (error) throw error;
  return Object.fromEntries(data.map((r) => [r.fahrer, { rolle: r.rolle, funktion: r.funktion || "", tagessatz: r.tagessatz === null ? null : Number(r.tagessatz) }]));
}
export async function setRolle(fahrer, { rolle, funktion, tagessatz }) {
  const { error } = await supabase
    .from("fahrer_rolle")
    .upsert({ fahrer, rolle, funktion: funktion || null, tagessatz: tagessatz ?? null }, { onConflict: "fahrer" });
  if (error) throw error;
}

// Arbeitstage (Mo-Fr) eines Monats - Basis für den Fahranteil
export function arbeitstage(j, m) {
  let n = 0;
  const tage = new Date(j, m, 0).getDate();
  for (let t = 1; t <= tage; t++) { const w = new Date(j, m - 1, t).getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
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
export const VERWALTUNG = "__verwaltung__";

// Index: "fahrer|datum" -> [lkw, ...] aus den Touren (wer ist wann womit gefahren)
function tourIndex(touren) {
  const idx = {};
  for (const t of touren || []) {
    const f = (t.fahrer || "").trim();
    if (!f || !t.lkw || !t.datum) continue;
    const k = `${f}|${t.datum.slice(0, 10)}`;
    const l = (idx[k] = idx[k] || []);
    if (!l.includes(t.lkw)) l.push(t.lkw);
  }
  return idx;
}

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
// [{ fahrer, monat, lkw, betrag }].
//  - Rolle "fahrer": jeder Kalendertag = betrag / Tage-im-Monat, für den LKW aus dem
//    Einsatzplan der KW; ohne Einteilung -> OFFEN.
//  - Rolle "anteilig": jeder Fahrtag (Tag mit Tour, aus den Touren) = betrag / Arbeitstage
//    (Mo-Fr) für den gefahrenen LKW; der Rest der Arbeitstage -> VERWALTUNG.
// start/ende (ISO, optional) schneiden den Monat an.
export function verteilen(kostenRoh, einsatz, start, ende, opt = {}) {
  const idx = einsatzIndex(einsatz);
  const tIdx = tourIndex(opt.touren);
  const rollen = opt.rollen || {};
  const kosten = effektiveKosten(kostenRoh, rollen, opt.touren);
  const out = [];
  for (const k of kosten) {
    const [j, m] = k.monat.split("-").map(Number);
    const tage = new Date(j, m, 0).getDate();
    const anteil = {};
    const add = (l, b) => { anteil[l] = (anteil[l] || 0) + b; };
    if (rollen[k.fahrer]?.rolle === "tagessatz") {
      // jeder Einsatztag (Tag mit Tour) = Tagessatz, auf den gefahrenen LKW
      const satz = rollen[k.fahrer].tagessatz || 0;
      for (let t = 1; t <= tage; t++) {
        const s = `${k.monat}-${String(t).padStart(2, "0")}`;
        if ((start && s < start) || (ende && s > ende)) continue;
        const lkws = tIdx[`${k.fahrer}|${s}`];
        if (lkws && lkws.length) for (const l of lkws) add(l, satz / lkws.length);
      }
    } else if (rollen[k.fahrer]?.rolle === "anteilig") {
      // erst den ganzen Monat bewerten, dann auf den Zeitraum schneiden - so ergibt
      // der volle Monat immer exakt den Monatsbetrag (auch bei Wochenendfahrten)
      const at = arbeitstage(j, m);
      const tagesliste = [];
      for (let t = 1; t <= tage; t++) {
        const d = new Date(j, m - 1, t);
        const s = iso(d);
        tagesliste.push({ s, werktag: d.getDay() !== 0 && d.getDay() !== 6, lkws: tIdx[`${k.fahrer}|${s}`] || [] });
      }
      const gefahren = tagesliste.filter((x) => x.lkws.length);
      const nichtGefahreneWerktage = tagesliste.filter((x) => !x.lkws.length && x.werktag);
      let wertFahrtag, wertVerwaltungstag;
      if (gefahren.length >= at) {
        wertFahrtag = k.betrag / gefahren.length; // fährt voll: alles auf die LKW
        wertVerwaltungstag = 0;
      } else {
        wertFahrtag = k.betrag / at;
        const rest = k.betrag - gefahren.length * wertFahrtag;
        wertVerwaltungstag = nichtGefahreneWerktage.length ? rest / nichtGefahreneWerktage.length : 0;
      }
      for (const x of tagesliste) {
        if ((start && x.s < start) || (ende && x.s > ende)) continue;
        if (x.lkws.length) for (const l of x.lkws) add(l, wertFahrtag / x.lkws.length);
        else if (x.werktag && wertVerwaltungstag) add(VERWALTUNG, wertVerwaltungstag);
      }
    } else {
      const proTag = k.betrag / tage;
      for (let t = 1; t <= tage; t++) {
        const d = new Date(j, m - 1, t);
        const s = iso(d);
        if ((start && s < start) || (ende && s > ende)) continue;
        const [wj, kw] = isoWoche(d);
        const lkws = idx[`${k.fahrer}|${wj}|${kw}`];
        if (!lkws || !lkws.length) add(OFFEN, proTag);
        else for (const l of lkws) add(l, proTag / lkws.length);
      }
    }
    for (const [lkw, betrag] of Object.entries(anteil)) out.push({ fahrer: k.fahrer, monat: k.monat, lkw, betrag });
  }
  return out;
}

// Für Personen mit Tagessatz werden die Monatskosten nicht eingetragen, sondern
// aus den Touren berechnet: Einsatztage (Tage mit Tour) x Tagessatz.
// Liefert die Kostenliste mit diesen berechneten Zeilen (auto: true, tage: n).
export function effektiveKosten(kosten, rollen, touren) {
  const ts = Object.entries(rollen || {}).filter(([, r]) => r.rolle === "tagessatz" && r.tagessatz).map(([f]) => f);
  if (!ts.length) return kosten;
  const ft = fahrtage(touren);
  const auto = Object.entries(ft)
    .map(([key, n]) => { const [f, monat] = key.split("|"); return { f, monat, n }; })
    .filter((x) => ts.includes(x.f))
    .map((x) => ({ fahrer: x.f, monat: x.monat, betrag: x.n * rollen[x.f].tagessatz, bemerkung: "", auto: true, tage: x.n }));
  return [...kosten.filter((k) => !ts.includes(k.fahrer)), ...auto];
}

// Fahrtage je Person und Monat (aus den Touren) -> { "fahrer|YYYY-MM": n }
export function fahrtage(touren) {
  const s = new Set();
  for (const t of touren || []) if (t.fahrer && t.datum) s.add(`${t.fahrer.trim()}|${t.datum.slice(0, 10)}`);
  const out = {};
  for (const k of s) { const [f, d] = k.split("|"); const key = `${f}|${d.slice(0, 7)}`; out[key] = (out[key] || 0) + 1; }
  return out;
}

export function jeLkw(kosten, einsatz, start, ende, opt) {
  const out = {};
  for (const a of verteilen(kosten, einsatz, start, ende, opt)) out[a.lkw] = (out[a.lkw] || 0) + a.betrag;
  return out;
}
