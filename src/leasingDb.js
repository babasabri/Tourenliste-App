// Datenzugriff für den Fuhrpark-Reiter "Leasing/Miete":
// leasing_fahrzeuge (Vertragsdaten je Kennzeichen) und leasing_raten
// (monatliche Rate netto, monat = 1. des Monats, eindeutig je Kennzeichen+Monat).
import { supabase } from "./supabaseClient";

export async function fetchFahrzeuge() {
  const [{ data, error }, zu] = await Promise.all([
    supabase.from("leasing_fahrzeuge").select("*").order("reihenfolge").order("kennzeichen"),
    supabase.from("leasing_zuordnung").select("*").order("von"),
  ]);
  if (error) throw error;
  if (zu.error) throw zu.error;
  const verlauf = {};
  for (const z of zu.data) (verlauf[z.kennzeichen] = verlauf[z.kennzeichen] || []).push({ id: z.id, lkw: z.lkw, von: z.von, bis: z.bis || "" });
  return data.map((r) => ({
    kennzeichen: r.kennzeichen,
    art: r.art,
    vertragspartner: r.vertragspartner || "",
    vertragNr: r.vertrag_nr || "",
    bemerkung: r.bemerkung || "",
    reihenfolge: r.reihenfolge,
    abbezahltAm: r.abbezahlt_am || "", // bei Miete: zurückgegeben am
    typ: r.typ || "LKW",
    zuordnung: verlauf[r.kennzeichen] || [], // Auflieger: [{ lkw, von, bis }] - bei welchem LKW wann
    schlussrateDatum: r.schlussrate_datum || "",
    schlussrateBetrag: r.schlussrate_betrag === null || r.schlussrate_betrag === undefined ? null : Number(r.schlussrate_betrag),
  }));
}

export async function addFahrzeug({ kennzeichen, art, typ }) {
  const { error } = await supabase.from("leasing_fahrzeuge").insert({ kennzeichen, art, typ: typ || "LKW", reihenfolge: typ === "Auflieger" ? 120 : 100 });
  if (error) throw new Error(error.code === "23505" ? `${kennzeichen} ist schon angelegt` : error.message);
}

export async function updateFahrzeug(kennzeichen, patch) {
  const p = {};
  if (patch.art !== undefined) p.art = patch.art;
  if (patch.vertragspartner !== undefined) p.vertragspartner = patch.vertragspartner || null;
  if (patch.vertragNr !== undefined) p.vertrag_nr = patch.vertragNr || null;
  if (patch.bemerkung !== undefined) p.bemerkung = patch.bemerkung || null;
  if (patch.abbezahltAm !== undefined) p.abbezahlt_am = patch.abbezahltAm || null;
  if (patch.typ !== undefined) p.typ = patch.typ;
  if (patch.schlussrateDatum !== undefined) p.schlussrate_datum = patch.schlussrateDatum || null;
  if (patch.schlussrateBetrag !== undefined) p.schlussrate_betrag = patch.schlussrateBetrag;
  const { error } = await supabase.from("leasing_fahrzeuge").update(p).eq("kennzeichen", kennzeichen);
  if (error) throw error;
}

export async function deleteFahrzeug(kennzeichen) {
  const { error } = await supabase.from("leasing_fahrzeuge").delete().eq("kennzeichen", kennzeichen);
  if (error) throw error;
}

// alle Raten (wenige hundert Zeilen) - [{ kennzeichen, monat: "2026-01", betrag, bemerkung }]
export async function fetchRaten() {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("leasing_raten").select("*").order("monat").range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...data.map((r) => ({ kennzeichen: r.kennzeichen, monat: r.monat.slice(0, 7), betrag: Number(r.betrag), bemerkung: r.bemerkung || "" })));
    if (data.length < PAGE) break;
  }
  return all;
}

// betrag null/leer = Rate löschen
export async function setRate(kennzeichen, monat, betrag) {
  const tag = `${monat}-01`;
  if (betrag === null || betrag === undefined) {
    const { error } = await supabase.from("leasing_raten").delete().eq("kennzeichen", kennzeichen).eq("monat", tag);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from("leasing_raten")
    .upsert({ kennzeichen, monat: tag, betrag, geaendert_am: new Date().toISOString() }, { onConflict: "kennzeichen,monat" });
  if (error) throw error;
}

export async function setRatenBulk(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from("leasing_raten").upsert(
    rows.map((r) => ({ kennzeichen: r.kennzeichen, monat: `${r.monat}-01`, betrag: r.betrag, geaendert_am: new Date().toISOString() })),
    { onConflict: "kennzeichen,monat" }
  );
  if (error) throw error;
}

// Leasing/Miete anteilig für einen Zeitraum: volle Monate voll, angeschnittene
// Monate nach Tagen. start/ende ISO (null = offen). -> { kennzeichen: betrag }
export function leasingJeLkw(raten, start, ende) {
  const out = {};
  for (const r of raten) {
    const [j, m] = r.monat.split("-").map(Number);
    const tage = new Date(j, m, 0).getDate();
    const ms = `${r.monat}-01`;
    const me = `${r.monat}-${String(tage).padStart(2, "0")}`;
    const a = start && start > ms ? start : ms;
    const e = ende && ende < me ? ende : me;
    if (a > e) continue;
    const drin = Number(e.slice(8, 10)) - Number(a.slice(8, 10)) + 1;
    out[r.kennzeichen] = (out[r.kennzeichen] || 0) + (r.betrag * drin) / tage;
  }
  return out;
}

// Monat (YYYY-MM) liegt nach dem Abbezahlt-Monat -> keine Rate mehr erwartet
export function nachAbbezahlt(fahrzeug, monat) {
  return !!(fahrzeug && fahrzeug.abbezahltAm && monat > fahrzeug.abbezahltAm.slice(0, 7));
}

// ---- Zuordnungsverlauf Auflieger -> LKW
export async function addZuordnung(kennzeichen, { lkw, von, bis }) {
  const { error } = await supabase.from("leasing_zuordnung").insert({ kennzeichen, lkw, von, bis: bis || null });
  if (error) throw new Error(error.message);
}
export async function updateZuordnung(id, patch) {
  const p = {};
  if (patch.lkw !== undefined) p.lkw = patch.lkw;
  if (patch.von !== undefined) p.von = patch.von;
  if (patch.bis !== undefined) p.bis = patch.bis || null;
  const { error } = await supabase.from("leasing_zuordnung").update(p).eq("id", id);
  if (error) throw new Error(error.message);
}
export async function deleteZuordnung(id) {
  const { error } = await supabase.from("leasing_zuordnung").delete().eq("id", id);
  if (error) throw error;
}
// LKW eines Aufliegers an einem Tag (ISO) oder null
export function lkwAm(fahrzeug, iso) {
  const z = (fahrzeug?.zuordnung || []).find((x) => x.von <= iso && (!x.bis || x.bis >= iso));
  return z ? z.lkw : null;
}

// Leasing/Miete je Ziel für [start, ende], tagesgenau: Auflieger zählen an jedem
// Tag beim LKW laut Zuordnungsverlauf, an Tagen ohne Zuordnung unter sammelKey.
// -> { ziel: betrag }
export function leasingJeZiel(raten, fahrzeuge, start, ende, sammelKey) {
  const fz = Object.fromEntries((fahrzeuge || []).map((f) => [f.kennzeichen, f]));
  const out = {};
  const add = (k, b) => { if (b) out[k] = (out[k] || 0) + b; };
  for (const r of raten) {
    const f = fz[r.kennzeichen];
    if (!f || f.typ !== "Auflieger") { add(r.kennzeichen, leasingJeLkw([r], start, ende)[r.kennzeichen]); continue; }
    const [j, m] = r.monat.split("-").map(Number);
    const tage = new Date(j, m, 0).getDate();
    for (let t = 1; t <= tage; t++) {
      const iso = `${r.monat}-${String(t).padStart(2, "0")}`;
      if ((start && iso < start) || (ende && iso > ende)) continue;
      add(lkwAm(f, iso) || sammelKey, r.betrag / tage);
    }
  }
  return out;
}
