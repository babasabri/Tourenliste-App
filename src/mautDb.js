// Datenzugriff für die Seite "Maut" (Toll Collect). Eigene Datei statt db.js,
// damit parallele Änderungen an db.js nicht kollidieren.
import { supabase } from "./supabaseClient";

const num = (v) => (v === null || v === undefined ? null : Number(v));

// Paginiert (Supabase liefert max. 1000 Zeilen pro Abfrage).
export async function fetchMautPositionen() {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("maut_positionen")
      .select("id, abrechnung_nr, buchungsnr, lkw, datum, zeit, art, auffahrt, ueber, abfahrt, km, betrag, storno")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data) {
      all.push({
        id: r.id,
        abrechnungNr: r.abrechnung_nr,
        buchungsnr: r.buchungsnr,
        lkw: r.lkw,
        datum: r.datum,
        zeit: r.zeit ? r.zeit.slice(0, 5) : "",
        art: r.art || "",
        auffahrt: r.auffahrt || "",
        ueber: r.ueber || "",
        abfahrt: r.abfahrt || "",
        km: num(r.km) || 0,
        betrag: (num(r.betrag) || 0) + (num(r.storno) || 0),
      });
    }
    if (data.length < PAGE) break;
  }
  return all;
}

export async function fetchMautAbrechnungen() {
  const { data, error } = await supabase.from("maut_abrechnungen").select("*").order("fahrten_von", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    nr: r.nr,
    datum: r.datum,
    fahrtenVon: r.fahrten_von,
    fahrtenBis: r.fahrten_bis,
    anzahl: r.anzahl,
    summe: num(r.summe),
    dateiname: r.dateiname,
    importiertAm: r.importiert_am,
  }));
}

// Atomar: Mautaufstellung + alle Fahrten oder gar nichts (Postgres-Funktion).
export async function importMautAbrechnung(p) {
  const { data, error } = await supabase.rpc("maut_import", {
    p_abrechnung: {
      nr: p.nr,
      datum: p.datum || "",
      fahrten_von: p.fahrtenVon,
      fahrten_bis: p.fahrtenBis,
      anzahl: p.anzahl,
      summe: p.summe,
      dateiname: p.dateiname,
      quelle: "csv",
    },
    p_positionen: p.positionen.map((x) => ({
      buchungsnr: x.buchungsnr,
      lkw: x.lkw,
      datum: x.datum,
      zeit: x.zeit,
      art: x.art,
      auffahrt: x.auffahrt,
      ueber: x.ueber,
      abfahrt: x.abfahrt,
      kostenstelle: x.kostenstelle,
      tarifmodell: x.tarifmodell,
      achsklasse: x.achsklasse,
      gewichtsklasse: x.gewichtsklasse,
      schadstoffklasse: x.schadstoffklasse,
      co2_klasse: x.co2_klasse,
      verfahren: x.verfahren,
      km: x.km === null ? "" : String(x.km),
      betrag: String(x.betrag),
      storno: String(x.storno),
    })),
  });
  if (error) throw new Error(error.message);
  return data;
}

// Löscht eine Mautaufstellung samt Fahrten (on delete cascade).
export async function deleteMautAbrechnung(nr) {
  const { error } = await supabase.from("maut_abrechnungen").delete().eq("nr", nr);
  if (error) throw error;
}
