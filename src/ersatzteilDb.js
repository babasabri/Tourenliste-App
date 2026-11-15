// Datenzugriff für die Seite "Ersatzteile" (Winkler-Rechnungen/-Gutschriften,
// später weitere Lieferanten). Eigene Datei, damit parallele Änderungen an
// db.js (andere Chats) nicht kollidieren.
import { supabase } from "./supabaseClient";

const num = (v) => (v === null || v === undefined ? null : Number(v));

const fromDb = (r) => {
  const b = r.ersatzteil_belege || {};
  return {
    id: r.id,
    belegId: r.beleg_id,
    lieferant: b.lieferant,
    belegNr: b.beleg_nr,
    belegart: b.belegart,
    datum: b.beleg_datum,
    pos: r.pos,
    teil: r.teil,
    lieferschein: r.lieferschein,
    lieferdatum: r.lieferdatum,
    bestelldaten: r.bestelldaten || "",
    fin: r.fin || "",
    lkw: r.lkw || "",
    lkwQuelle: r.lkw_quelle,
    kategorie: r.kategorie,
    artikelNr: r.artikel_nr || "",
    bezeichnung: r.bezeichnung,
    zusatz: r.zusatz || "",
    menge: num(r.menge),
    einheit: r.einheit || "",
    netto: num(r.netto) || 0,
    pfand: num(r.pfand) || 0,
    bezugBelegNr: r.bezug_beleg_nr,
    bezugPos: r.bezug_pos,
    grund: r.gutschrift_grund,
    hinweis: r.hinweis || "",
    anlass: r.anlass || "",
    kmStand: r.km_stand ?? null,
    quelle: b.quelle || "winkler_pdf",
    dateiPfad: b.datei_pfad || "",
  };
};

// Paginiert (Supabase liefert max. 1000 Zeilen pro Abfrage).
export async function fetchPositionen() {
  const all = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("ersatzteil_positionen")
      .select("*, ersatzteil_belege(lieferant, beleg_nr, belegart, beleg_datum, quelle, datei_pfad)")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...data.map(fromDb));
    if (data.length < PAGE) break;
  }
  return all;
}

export async function fetchBelege() {
  const { data, error } = await supabase.from("ersatzteil_belege").select("*").order("beleg_datum", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    id: r.id,
    lieferant: r.lieferant,
    belegNr: r.beleg_nr,
    belegart: r.belegart,
    datum: r.beleg_datum,
    netto: num(r.netto),
    brutto: num(r.brutto),
    dateiname: r.dateiname,
    importiertAm: r.importiert_am,
    quelle: r.quelle || "winkler_pdf",
    dateiPfad: r.datei_pfad || "",
    bemerkung: r.bemerkung || "",
  }));
}

// { FIN: Kennzeichen } - zur Zuordnung, wenn auf dem Beleg nur die FIN steht.
export async function fetchFinMap() {
  const { data, error } = await supabase.from("fahrzeug_fin").select("*");
  if (error) throw error;
  return Object.fromEntries(data.map((r) => [r.fin, r.lkw]));
}

// Atomar: Beleg + alle Positionen oder gar nichts (Postgres-Funktion).
export async function importBeleg(parsed) {
  const { data, error } = await supabase.rpc("ersatzteil_import", {
    p_beleg: {
      lieferant: parsed.lieferant,
      beleg_nr: parsed.belegNr,
      belegart: parsed.belegart,
      beleg_datum: parsed.belegDatum,
      netto: parsed.netto,
      brutto: parsed.brutto,
      dateiname: parsed.dateiname,
      quelle: parsed.quelle || "winkler_pdf",
      datei_pfad: parsed.dateiPfad || null,
      bemerkung: parsed.bemerkung || null,
    },
    p_positionen: parsed.positionen,
  });
  if (error) throw new Error(error.message);
  return data;
}

// Kennzeichen und/oder Kategorie einer Position ändern.
export async function updatePosition(id, { lkw, kategorie }) {
  const patch = { geaendert_am: new Date().toISOString() };
  if (lkw !== undefined) { patch.lkw = lkw || null; patch.lkw_quelle = lkw ? "manuell" : null; }
  if (kategorie !== undefined) patch.kategorie = kategorie;
  const { error } = await supabase.from("ersatzteil_positionen").update(patch).eq("id", id);
  if (error) throw error;
}

// Position auf mehrere LKW aufteilen: teile = [{ lkw, menge }]
export async function aufteilen(id, teile) {
  const { error } = await supabase.rpc("ersatzteil_aufteilen", { p_id: id, p_teile: teile });
  if (error) throw new Error(error.message);
}

export async function deleteBeleg(id) {
  const { error } = await supabase.from("ersatzteil_belege").delete().eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------- Werkstatt & Teile --
export async function fetchLieferanten() {
  const { data, error } = await supabase.from("werkstatt_lieferanten").select("*").order("name");
  if (error) throw error;
  return data;
}
export async function addLieferant(name) {
  const { error } = await supabase.from("werkstatt_lieferanten").upsert({ name }, { onConflict: "name", ignoreDuplicates: true });
  if (error) throw error;
}

// PDF/Foto zum Beleg in den privaten Bucket "belege" laden -> Pfad
export async function uploadDatei(file, lieferant) {
  const jahr = new Date().getFullYear();
  const sauber = (s) => String(s || "").normalize("NFKD").replace(/[^\w.-]+/g, "_").slice(0, 60);
  const pfad = `${jahr}/${sauber(lieferant) || "beleg"}/${Date.now()}_${sauber(file.name)}`;
  const { error } = await supabase.storage.from("belege").upload(pfad, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw new Error("Datei konnte nicht gespeichert werden: " + error.message);
  return pfad;
}
// zeitlich begrenzter Link zum Ansehen (10 Minuten)
export async function dateiLink(pfad) {
  const { data, error } = await supabase.storage.from("belege").createSignedUrl(pfad, 600);
  if (error) throw error;
  return data.signedUrl;
}

// Manuellen Beleg ersetzen (Kopf + alle Positionen), atomar
export async function ersetzeBeleg(id, beleg, positionen) {
  const { error } = await supabase.rpc("ersatzteil_beleg_ersetzen", {
    p_id: id,
    p_beleg: {
      lieferant: beleg.lieferant, beleg_nr: beleg.belegNr, belegart: beleg.belegart, beleg_datum: beleg.belegDatum,
      netto: beleg.netto, brutto: beleg.brutto, datei_pfad: beleg.dateiPfad || null, dateiname: beleg.dateiname || null, bemerkung: beleg.bemerkung || null,
    },
    p_positionen: positionen,
  });
  if (error) throw new Error(error.message);
}
