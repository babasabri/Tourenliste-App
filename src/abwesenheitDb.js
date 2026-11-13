// Abwesenheiten (Urlaub/Krank) je Fahrer, tageweise von-bis.
// Genutzt im Einsatzplan (Erfassung, Wochen-/Jahresübersicht) und in den
// Fahrerkosten (Verteilung von Urlaubs-/Krankentagen auf die LKW).
import { supabase } from "./supabaseClient";

export const ARTEN = { urlaub: "Urlaub", krank: "Krank" };

const fromDb = (r) => ({ id: r.id, fahrer: r.fahrer, art: r.art, von: r.von, bis: r.bis, bemerkung: r.bemerkung || "" });

export async function fetchAbwesenheiten() {
  const { data, error } = await supabase.from("fahrer_abwesenheiten").select("*").order("von");
  if (error) throw error;
  return data.map(fromDb);
}
export async function addAbwesenheit(x) {
  const { error } = await supabase.from("fahrer_abwesenheiten").insert({ fahrer: x.fahrer, art: x.art, von: x.von, bis: x.bis, bemerkung: x.bemerkung || null });
  if (error) throw new Error(error.message);
}
export async function updateAbwesenheit(id, patch) {
  const p = {};
  for (const k of ["fahrer", "art", "von", "bis"]) if (patch[k] !== undefined) p[k] = patch[k];
  if (patch.bemerkung !== undefined) p.bemerkung = patch.bemerkung || null;
  const { error } = await supabase.from("fahrer_abwesenheiten").update(p).eq("id", id);
  if (error) throw new Error(error.message);
}
export async function deleteAbwesenheit(id) {
  const { error } = await supabase.from("fahrer_abwesenheiten").delete().eq("id", id);
  if (error) throw error;
}

// ---- Hilfen
const pad2 = (n) => String(n).padStart(2, "0");
export const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const istWerktag = (iso) => { const w = fromIso(iso).getDay(); return w !== 0 && w !== 6; };

// Index "fahrer|YYYY-MM-DD" -> art (nur Mo-Fr; Wochenenden zählen nicht als Abwesenheitstag)
export function abwesenheitIndex(liste) {
  const idx = {};
  for (const a of liste || []) {
    for (let d = fromIso(a.von); isoOf(d) <= a.bis; d.setDate(d.getDate() + 1)) {
      const s = isoOf(d);
      if (istWerktag(s)) idx[`${a.fahrer}|${s}`] = a.art;
    }
  }
  return idx;
}

// Werktage (Mo-Fr) eines Eintrags innerhalb [start, ende]
export function werktage(a, start, ende) {
  let n = 0;
  const von = start && start > a.von ? start : a.von;
  const bis = ende && ende < a.bis ? ende : a.bis;
  for (let d = fromIso(von); isoOf(d) <= bis; d.setDate(d.getDate() + 1)) if (istWerktag(isoOf(d))) n++;
  return n;
}
