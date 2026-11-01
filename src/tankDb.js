// Datenzugriff für die Seite "Tankvorgänge" (Tankpool-Rechnungen).
// Bewusst eigene Datei statt db.js, damit parallele Änderungen an db.js
// (anderer Chat) nicht kollidieren.
import { supabase } from "./supabaseClient";

const num = (v) => (v === null || v === undefined ? null : Number(v));

const fromDb = (r) => ({
  id: r.id,
  rechnungNr: r.rechnung_nr,
  karte: r.karte,
  kennzeichenBeleg: r.kennzeichen_beleg,
  lkw: r.lkw || r.kennzeichen_beleg || "?",
  datum: r.datum,
  zeit: r.zeit ? r.zeit.slice(0, 5) : "",
  station: r.station || "",
  sorte: r.sorte,
  kategorie: r.kategorie,
  menge: num(r.menge),
  einheit: r.einheit,
  preis: num(r.preis_netto),
  wert: num(r.wert_netto) || 0,
  kmBeleg: r.km_beleg,
});

// Paginiert (Supabase liefert max. 1000 Zeilen pro Abfrage).
export async function fetchTankvorgaenge() {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("tankvorgaenge")
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...data.map(fromDb));
    if (data.length < PAGE) break;
  }
  return all;
}

export async function fetchTankpoolRechnungen() {
  const { data, error } = await supabase
    .from("tankpool_rechnungen")
    .select("*")
    .order("rechnung_datum", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    rechnungNr: r.rechnung_nr,
    datum: r.rechnung_datum,
    typ: r.typ,
    summe: num(r.summe_netto),
    dateiname: r.dateiname,
    importiertAm: r.importiert_am,
  }));
}

// Atomar: Rechnung + alle Positionen oder gar nichts (Postgres-Funktion).
export async function importTankpoolRechnung(parsed) {
  const { data, error } = await supabase.rpc("tankpool_import", {
    p_rechnung: {
      rechnung_nr: parsed.rechnungNr,
      rechnung_datum: parsed.rechnungDatum,
      typ: parsed.typ,
      summe_netto: parsed.dokumentSumme,
      dateiname: parsed.dateiname,
    },
    p_positionen: parsed.positionen.map((p) => ({
      karte: p.karte,
      kennzeichen_beleg: p.kennzeichen_beleg,
      lkw: p.lkw,
      datum: p.datum,
      zeit: p.zeit || "",
      station: p.station,
      sorte: p.sorte,
      kategorie: p.kategorie,
      menge: p.menge,
      einheit: p.einheit,
      preis_netto: p.preis_netto,
      wert_netto: p.wert_netto,
      mwst_satz: p.mwst_satz,
      km_beleg: p.km_beleg,
    })),
  });
  if (error) throw new Error(error.message);
  return data;
}

// Löscht eine Rechnung samt ihrer Positionen (on delete cascade).
export async function deleteTankpoolRechnung(rechnungNr) {
  const { error } = await supabase.from("tankpool_rechnungen").delete().eq("rechnung_nr", rechnungNr);
  if (error) throw error;
}
