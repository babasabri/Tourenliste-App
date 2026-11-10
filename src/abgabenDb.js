// Datenzugriff für den Fuhrpark-Reiter "Versicherung & Steuer"
// (Tabelle fahrzeug_abgaben: eine Zeile je Zahlung mit Zeitraum von-bis).
import { supabase } from "./supabaseClient";

export const ARTEN = {
  versicherung: { label: "Kfz-Versicherung", monate: 3, zahlweise: "vierteljährlich", gesellschaft: "Versicherer", nr: "Versicherungsschein-Nr." },
  steuer: { label: "Kfz-Steuer", monate: 12, zahlweise: "jährlich", gesellschaft: "Hauptzollamt", nr: "Steuernummer / Aktenzeichen" },
};

const fromDb = (r) => ({
  id: r.id,
  kennzeichen: r.kennzeichen,
  art: r.art,
  von: r.von,
  bis: r.bis,
  betrag: Number(r.betrag),
  anhaengerzuschlag: !!r.anhaengerzuschlag,
  gesellschaft: r.gesellschaft || "",
  vertragNr: r.vertrag_nr || "",
  bemerkung: r.bemerkung || "",
});
const toDb = (x) => {
  const o = {};
  if (x.kennzeichen !== undefined) o.kennzeichen = x.kennzeichen;
  if (x.art !== undefined) o.art = x.art;
  if (x.von !== undefined) o.von = x.von;
  if (x.bis !== undefined) o.bis = x.bis;
  if (x.betrag !== undefined) o.betrag = x.betrag;
  if (x.anhaengerzuschlag !== undefined) o.anhaengerzuschlag = !!x.anhaengerzuschlag;
  if (x.gesellschaft !== undefined) o.gesellschaft = x.gesellschaft || null;
  if (x.vertragNr !== undefined) o.vertrag_nr = x.vertragNr || null;
  if (x.bemerkung !== undefined) o.bemerkung = x.bemerkung || null;
  return o;
};

export async function fetchAbgaben() {
  const { data, error } = await supabase.from("fahrzeug_abgaben").select("*").order("von");
  if (error) throw error;
  return data.map(fromDb);
}
export async function addAbgabe(x) {
  const { data, error } = await supabase.from("fahrzeug_abgaben").insert(toDb(x)).select().single();
  if (error) throw new Error(error.message);
  return fromDb(data);
}
export async function updateAbgabe(id, patch) {
  const { error } = await supabase.from("fahrzeug_abgaben").update({ ...toDb(patch), geaendert_am: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
}
export async function deleteAbgabe(id) {
  const { error } = await supabase.from("fahrzeug_abgaben").delete().eq("id", id);
  if (error) throw error;
}

// ---- Datumshilfen (ISO-Strings, ohne Zeitzonen-Verschiebung)
const pad2 = (n) => String(n).padStart(2, "0");
const toIso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export function plusTage(iso, n) { const d = fromIso(iso); d.setDate(d.getDate() + n); return toIso(d); }
// Ende eines Zeitraums von n Monaten ab "von": 01.01. + 3 Monate -> 31.03.
export function periodenEnde(von, monate) {
  const d = fromIso(von);
  const e = new Date(d.getFullYear(), d.getMonth() + monate, d.getDate());
  e.setDate(e.getDate() - 1);
  return toIso(e);
}
export function tageZwischen(a, b) { return Math.round((fromIso(b) - fromIso(a)) / 86400000) + 1; }

// Betrag tagesgenau auf [start, ende] verteilen -> { kennzeichen: { versicherung, steuer } }
export function abgabenJeLkw(liste, start, ende) {
  const out = {};
  for (const x of liste) {
    const a = start && start > x.von ? start : x.von;
    const e = ende && ende < x.bis ? ende : x.bis;
    if (a > e) continue;
    const anteil = (x.betrag * tageZwischen(a, e)) / tageZwischen(x.von, x.bis);
    out[x.kennzeichen] = out[x.kennzeichen] || { versicherung: 0, steuer: 0 };
    out[x.kennzeichen][x.art] += anteil;
  }
  return out;
}
