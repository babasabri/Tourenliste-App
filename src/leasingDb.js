// Datenzugriff für den Fuhrpark-Reiter "Leasing/Miete":
// leasing_fahrzeuge (Vertragsdaten je Kennzeichen) und leasing_raten
// (monatliche Rate netto, monat = 1. des Monats, eindeutig je Kennzeichen+Monat).
import { supabase } from "./supabaseClient";

export async function fetchFahrzeuge() {
  const { data, error } = await supabase.from("leasing_fahrzeuge").select("*").order("reihenfolge").order("kennzeichen");
  if (error) throw error;
  return data.map((r) => ({
    kennzeichen: r.kennzeichen,
    art: r.art,
    vertragspartner: r.vertragspartner || "",
    vertragNr: r.vertrag_nr || "",
    bemerkung: r.bemerkung || "",
    reihenfolge: r.reihenfolge,
  }));
}

export async function addFahrzeug({ kennzeichen, art }) {
  const { error } = await supabase.from("leasing_fahrzeuge").insert({ kennzeichen, art, reihenfolge: 100 });
  if (error) throw new Error(error.code === "23505" ? `${kennzeichen} ist schon angelegt` : error.message);
}

export async function updateFahrzeug(kennzeichen, patch) {
  const p = {};
  if (patch.art !== undefined) p.art = patch.art;
  if (patch.vertragspartner !== undefined) p.vertragspartner = patch.vertragspartner || null;
  if (patch.vertragNr !== undefined) p.vertrag_nr = patch.vertragNr || null;
  if (patch.bemerkung !== undefined) p.bemerkung = patch.bemerkung || null;
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
