// Datenzugriff + Verteilung für den Fuhrpark-Reiter "Gemeinkosten".
// gemeinkosten_posten: Zeilen des Rasters (name, kategorie, reihenfolge)
// gemeinkosten: Betrag je Posten und Monat (monat = 1. des Monats), netto.
//
// Verteilung auf die LKW (Vorgabe des Nutzers):
//  - eigene LKW: gleichmäßig, egal ob aktiv oder nicht
//  - Miet-SZM (Leasing/Miete-Art "Miete", Typ LKW): nur an den Tagen ihres
//    Mietzeitraums (Stammdaten Einsatz von/bis)
// Tagesgenau: Monatsbetrag / Tage im Monat, jeder Tag wird zu gleichen Teilen auf
// die an diesem Tag vorhandenen LKW verteilt.
import { supabase } from "./supabaseClient";

export const KATEGORIEN = ["Büro & Verwaltung", "Berater & Gebühren", "Factoring", "Allgemeine Versicherungen", "Sonstiges"];

export async function fetchPosten() {
  const { data, error } = await supabase.from("gemeinkosten_posten").select("*").order("reihenfolge").order("name");
  if (error) throw error;
  return data.map((r) => ({ name: r.name, kategorie: r.kategorie, reihenfolge: r.reihenfolge }));
}

export async function addPosten({ name, kategorie }) {
  const { error } = await supabase.from("gemeinkosten_posten").insert({ name, kategorie, reihenfolge: 100 });
  if (error) throw new Error(error.code === "23505" ? `„${name}“ gibt es schon` : error.message);
}

export async function deletePosten(name) {
  const { error } = await supabase.from("gemeinkosten_posten").delete().eq("name", name);
  if (error) throw new Error(error.code === "23503" ? `„${name}“ hat noch Beträge – erst die Beträge löschen` : error.message);
}

export async function fetchKosten() {
  const { data, error } = await supabase.from("gemeinkosten").select("*").order("monat");
  if (error) throw error;
  return data.map((r) => ({ posten: r.posten, monat: r.monat.slice(0, 7), betrag: Number(r.betrag), bemerkung: r.bemerkung || "" }));
}

// betrag null = löschen
export async function setKosten(posten, monat, betrag) {
  const tag = `${monat}-01`;
  if (betrag === null || betrag === undefined) {
    const { error } = await supabase.from("gemeinkosten").delete().eq("posten", posten).eq("monat", tag);
    if (error) throw error;
    return;
  }
  const { error } = await supabase
    .from("gemeinkosten")
    .upsert({ posten, monat: tag, betrag, geaendert_am: new Date().toISOString() }, { onConflict: "posten,monat" });
  if (error) throw error;
}

export async function setKostenBulk(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from("gemeinkosten").upsert(
    rows.map((r) => ({ posten: r.posten, monat: `${r.monat}-01`, betrag: r.betrag, geaendert_am: new Date().toISOString() })),
    { onConflict: "posten,monat" }
  );
  if (error) throw error;
}

// Welche LKW tragen an einem Tag Gemeinkosten?
// fleet: [{ plate, einsatzVon, einsatzBis }], vertraege: leasing_fahrzeuge (für die Art "Miete")
export function lkwAmTag(fleet, vertraege, iso) {
  const miete = new Set((vertraege || []).filter((v) => v.art === "Miete" && (v.typ || "LKW") === "LKW").map((v) => v.kennzeichen));
  return (fleet || [])
    .filter((f) => f.plate)
    .filter((f) => !miete.has(f.plate) || ((f.einsatzVon && f.einsatzVon <= iso) && (!f.einsatzBis || f.einsatzBis >= iso)))
    .map((f) => f.plate);
}

// -> [{ posten, monat, lkw, betrag }]; start/ende (ISO, optional) schneiden an
export function verteilen(kosten, fleet, vertraege, start, ende) {
  const out = [];
  const pad2 = (n) => String(n).padStart(2, "0");
  const cache = {};
  for (const k of kosten) {
    const [j, m] = k.monat.split("-").map(Number);
    const tage = new Date(j, m, 0).getDate();
    const proTag = k.betrag / tage;
    const anteil = {};
    for (let t = 1; t <= tage; t++) {
      const iso = `${k.monat}-${pad2(t)}`;
      if ((start && iso < start) || (ende && iso > ende)) continue;
      const lkws = cache[iso] || (cache[iso] = lkwAmTag(fleet, vertraege, iso));
      if (!lkws.length) continue;
      for (const l of lkws) anteil[l] = (anteil[l] || 0) + proTag / lkws.length;
    }
    for (const [lkw, betrag] of Object.entries(anteil)) out.push({ posten: k.posten, monat: k.monat, lkw, betrag });
  }
  return out;
}

export function jeLkw(kosten, fleet, vertraege, start, ende) {
  const out = {};
  for (const a of verteilen(kosten, fleet, vertraege, start, ende)) out[a.lkw] = (out[a.lkw] || 0) + a.betrag;
  return out;
}
