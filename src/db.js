import { supabase } from "./supabaseClient";

// ============================================================================
// Datenschicht: übersetzt zwischen den camelCase-Feldnamen, die die App intern
// benutzt (unverändert seit dem Prototyp), und den snake_case-Spalten in
// Supabase/Postgres. Die UI-Komponente (App.jsx) merkt davon nichts - sie
// ruft weiterhin z. B. persistTours(neueListe) auf; nur WIE das gespeichert
// wird, hat sich geändert (echte Datenbank-Zeilen statt ein JSON-Block).
//
// Jede sync*-Funktion vergleicht die gewünschte neue Liste mit der zuletzt
// bekannten Liste (aus dem React-State) und schreibt nur das, was sich
// geändert hat (insert/update/delete), statt alles neu zu schreiben. Danach
// wird die betroffene Tabelle frisch aus Supabase gelesen, damit der
// React-State immer dem tatsächlichen Datenbankstand entspricht (wichtig,
// sobald mehrere Kollegen gleichzeitig an der App arbeiten).
// ============================================================================

function emptyToNull(v) {
  return v === "" || v === undefined ? null : v;
}
// Für Spalten, die in der DB als NOT NULL mit Standardwert 0 definiert sind
// (fracht, fd, adr, multistop, wartezeit, maut, diesel). Ein explizites
// null würde den Spalten-Default umgehen und die NOT-NULL-Constraint
// verletzen ("Speichern fehlgeschlagen") - daher hier 0 statt null.
function emptyToZero(v) {
  return v === "" || v === undefined || v === null ? 0 : v;
}
function nullToEmpty(v) {
  return v === null || v === undefined ? "" : v;
}
function timeToEmpty(v) {
  if (v === null || v === undefined) return "";
  return String(v).slice(0, 5); // "08:00:00" -> "08:00"
}

// ---------------------------------------------------------------- Touren --
const tourToDb = (t) => ({
  id: t.id,
  datum: emptyToNull(t.datum),
  lkw: emptyToNull(t.lkw),
  fahrer: emptyToNull(t.fahrer),
  auftrags_nr: emptyToNull(t.auftragsNr),
  container_nr: emptyToNull(t.containerNr),
  kunde: emptyToNull(t.kunde),
  plz: emptyToNull(t.plz),
  ort: emptyToNull(t.ort),
  ankunft: emptyToNull(t.ankunft),
  abfahrt: emptyToNull(t.abfahrt),
  km: emptyToNull(t.km),
  fracht: emptyToZero(t.fracht),
  fd: emptyToZero(t.fd),
  adr: emptyToZero(t.adr),
  multistop: emptyToZero(t.multistop),
  wartezeit: emptyToZero(t.wartezeit),
  maut: emptyToZero(t.maut),
  diesel: emptyToZero(t.diesel),
  bemerkungen: t.bemerkungen || "",
  status: emptyToNull(t.status),
});

const tourFromDb = (r) => ({
  id: r.id,
  datum: nullToEmpty(r.datum),
  lkw: nullToEmpty(r.lkw),
  fahrer: nullToEmpty(r.fahrer),
  auftragsNr: nullToEmpty(r.auftrags_nr),
  containerNr: nullToEmpty(r.container_nr),
  kunde: nullToEmpty(r.kunde),
  plz: nullToEmpty(r.plz),
  ort: nullToEmpty(r.ort),
  ankunft: timeToEmpty(r.ankunft),
  abfahrt: timeToEmpty(r.abfahrt),
  km: nullToEmpty(r.km),
  fracht: nullToEmpty(r.fracht),
  fd: nullToEmpty(r.fd),
  adr: nullToEmpty(r.adr),
  multistop: nullToEmpty(r.multistop),
  wartezeit: nullToEmpty(r.wartezeit),
  maut: nullToEmpty(r.maut),
  diesel: nullToEmpty(r.diesel),
  bemerkungen: nullToEmpty(r.bemerkungen),
  status: nullToEmpty(r.status),
});

// Supabase/PostgREST liefert pro Anfrage standardmäßig maximal 1000 Zeilen
// zurück. Bei über 1000 Touren muss daher seitenweise nachgeladen werden,
// bis eine Seite weniger als PAGE_SIZE Zeilen enthält (= letzte Seite).
// Die Sortierung braucht zusätzlich "id" als Tiebreaker, weil viele Touren
// dasselbe Datum haben - sonst wäre die Reihenfolge zwischen Seiten nicht
// stabil und einzelne Zeilen könnten doppelt auftauchen oder fehlen.
const PAGE_SIZE = 1000;

export async function fetchTours() {
  let allRows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("tours")
      .select("*")
      .order("datum", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    allRows = allRows.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return allRows.map(tourFromDb);
}

// Vergleicht `next` (gewünschter Zielzustand) gegen `prev` (aktueller
// React-State) anhand der id und schreibt nur die Differenz.
export async function syncTours(prev, next) {
  const prevIds = new Set(prev.map((t) => t.id));
  const nextIds = new Set(next.map((t) => t.id));

  const toDelete = prev.filter((t) => !nextIds.has(t.id)).map((t) => t.id);
  const toUpsert = next.filter((t) => {
    const old = prev.find((p) => p.id === t.id);
    return !old || JSON.stringify(old) !== JSON.stringify(t);
  });

  if (toDelete.length > 0) {
    const { error } = await supabase.from("tours").delete().in("id", toDelete);
    if (error) throw error;
  }
  if (toUpsert.length > 0) {
    const { error } = await supabase.from("tours").upsert(toUpsert.map(tourToDb));
    if (error) throw error;
  }
  return fetchTours();
}

// Effizienter Bulk-Insert für den Import (viele neue Touren auf einmal).
export async function insertTours(newTours) {
  if (newTours.length === 0) return fetchTours();
  const { error } = await supabase.from("tours").insert(newTours.map(tourToDb));
  if (error) throw error;
  return fetchTours();
}

// ---------------------------------------------------------------- Fuhrpark --
const fleetToDb = (f) => ({
  plate: f.plate,
  driver: emptyToNull(f.driver) || "",
  start_km: emptyToNull(f.startKm),
  start_km_datum: emptyToNull(f.startKmDatum),
  note: f.note || "",
  start_km_history: f.startKmHistory || [],
});

const fleetFromDb = (r) => ({
  plate: r.plate,
  driver: nullToEmpty(r.driver),
  startKm: nullToEmpty(r.start_km),
  startKmDatum: nullToEmpty(r.start_km_datum),
  note: nullToEmpty(r.note),
  startKmHistory: r.start_km_history || [],
});

export async function fetchFleet() {
  const { data, error } = await supabase.from("fleet").select("*").order("plate");
  if (error) throw error;
  return data.map(fleetFromDb);
}

export async function seedFleet(seedRows) {
  const { error } = await supabase.from("fleet").insert(seedRows.map(fleetToDb));
  if (error) throw error;
  return fetchFleet();
}

export async function syncFleet(prev, next) {
  const nextPlates = new Set(next.map((f) => f.plate));
  const toDelete = prev.filter((f) => !nextPlates.has(f.plate)).map((f) => f.plate);
  const toUpsert = next.filter((f) => {
    const old = prev.find((p) => p.plate === f.plate);
    return !old || JSON.stringify(old) !== JSON.stringify(f);
  });

  if (toDelete.length > 0) {
    const { error } = await supabase.from("fleet").delete().in("plate", toDelete);
    if (error) throw error;
  }
  if (toUpsert.length > 0) {
    const { error } = await supabase.from("fleet").upsert(toUpsert.map(fleetToDb));
    if (error) throw error;
  }
  return fetchFleet();
}

// ------------------------------------------------------------------ Fahrer --
const driverFromDb = (r) => ({ id: r.id, name: r.name });

export async function fetchDrivers() {
  const { data, error } = await supabase.from("drivers").select("*").order("name");
  if (error) throw error;
  return data.map(driverFromDb);
}

export async function seedDrivers(names) {
  const { error } = await supabase.from("drivers").insert(names.map((name) => ({ name })));
  if (error) throw error;
  return fetchDrivers();
}

export async function syncDrivers(prev, next) {
  const nextIds = new Set(next.map((d) => d.id));
  const toDelete = prev.filter((d) => !nextIds.has(d.id)).map((d) => d.id);
  const toInsert = next.filter((d) => !prev.some((p) => p.id === d.id));

  if (toDelete.length > 0) {
    const { error } = await supabase.from("drivers").delete().in("id", toDelete);
    if (error) throw error;
  }
  if (toInsert.length > 0) {
    const { error } = await supabase.from("drivers").insert(toInsert.map((d) => ({ id: d.id, name: d.name })));
    if (error) throw error;
  }
  return fetchDrivers();
}

// -------------------------------------------------------------- Einsatzplan --
const einsatzToDb = (e) => ({
  jahr: e.jahr,
  kw: e.kw,
  lkw: e.lkw,
  fahrer: e.fahrer || "",
  status: e.status || "Aktiv",
  end_km: emptyToNull(e.endKm),
});

const einsatzFromDb = (r) => ({
  jahr: r.jahr,
  kw: r.kw,
  lkw: r.lkw,
  fahrer: nullToEmpty(r.fahrer),
  status: r.status || "Aktiv",
  endKm: nullToEmpty(r.end_km),
});

export async function fetchEinsatzplan() {
  const { data, error } = await supabase.from("einsatzplan").select("*");
  if (error) throw error;
  return data.map(einsatzFromDb);
}

// Einsatzplan-Zeilen haben keine eigene id im React-State (sie werden über
// jahr+kw+lkw identifiziert - passend zum unique-Constraint in der DB), daher
// reicht hier ein einfacher upsert auf diesen Schlüssel.
export async function syncEinsatzplan(next) {
  if (next.length > 0) {
    const { error } = await supabase
      .from("einsatzplan")
      .upsert(next.map(einsatzToDb), { onConflict: "jahr,kw,lkw" });
    if (error) throw error;
  }
  return fetchEinsatzplan();
}

// ------------------------------------------------------------ Diesel-Index --
// createdAt wird für die automatische Diesel-Berechnung in App.jsx gebraucht:
// bei mehreren Einträgen für denselben Monat zählt der zuletzt erfasste.
const dieselFromDb = (r) => ({ id: r.id, jahr: r.jahr, monat: r.monat, betrag: r.betrag, createdAt: r.created_at });

export async function fetchDieselIndex() {
  const { data, error } = await supabase.from("diesel_index").select("*");
  if (error) throw error;
  return data.map(dieselFromDb);
}

// Diesel-Index wird laut Vorgabe nie überschrieben: syncDieselIndex fügt nur
// neue Einträge hinzu bzw. löscht genau die, die der Nutzer explizit bestätigt
// entfernt hat - nie ein "Update" eines bestehenden Werts.
export async function syncDieselIndex(prev, next) {
  const nextIds = new Set(next.map((d) => d.id));
  const toDelete = prev.filter((d) => !nextIds.has(d.id)).map((d) => d.id);
  const toInsert = next.filter((d) => !prev.some((p) => p.id === d.id));

  if (toDelete.length > 0) {
    const { error } = await supabase.from("diesel_index").delete().in("id", toDelete);
    if (error) throw error;
  }
  if (toInsert.length > 0) {
    const { error } = await supabase
      .from("diesel_index")
      .insert(toInsert.map((d) => ({ id: d.id, jahr: d.jahr, monat: d.monat, betrag: d.betrag })));
    if (error) throw error;
  }
  return fetchDieselIndex();
}
