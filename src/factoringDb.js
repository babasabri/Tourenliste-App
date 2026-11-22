// Datenzugriff + Kostenverteilung für den Fuhrpark-Reiter "Factoring" (nordwest).
// factoring_abrechnungen: wöchentliche Abrechnung (Gebühren, Sperrkonto, Auszahlung)
// factoring_zinsen: monatliche Zinsabrechnung
//
// Kosten = Gebühren netto (Monat des Abrechnungsdatums) + Zinsen netto (Monat
// "per"-Datum). Verteilung auf die LKW nach dem Contargo-Umsatz des Monats
// (Touren ohne "Anderer Auftraggeber"), weil nur Contargo über Factoring läuft.
// Monat ohne Contargo-Umsatz: wie die übrigen Gemeinkosten (eigene LKW gleich,
// Miet-SZM nach Mietzeitraum).
import { supabase } from "./supabaseClient";
import * as gdb from "./gemeinkostenDb";

const n = (x) => (x === null || x === undefined ? null : Number(x));

export async function fetchAbrechnungen() {
  const { data, error } = await supabase.from("factoring_abrechnungen").select("*").order("datum", { ascending: false }).order("nr", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    nr: r.nr, datum: r.datum, mandant: r.mandant || "", uebertrag: n(r.uebertrag), eingereicht: n(r.eingereicht), nichtAngekauft: n(r.nicht_angekauft),
    sperrEinbehalt: n(r.sperr_einbehalt), sperrFreigabe: n(r.sperr_freigabe), gebuehrenNetto: n(r.gebuehren_netto), ust: n(r.ust), auszahlung: n(r.auszahlung),
    endsaldo: n(r.endsaldo), zeilen: r.zeilen || [], positionen: r.positionen || [], warnungen: r.warnungen || [], dateiname: r.dateiname || "",
  }));
}

export async function fetchZinsen() {
  const { data, error } = await supabase.from("factoring_zinsen").select("*").order("per_datum", { ascending: false });
  if (error) throw error;
  return data.map((r) => ({
    rechnungsnr: r.rechnungsnr, perDatum: r.per_datum, rechnungsdatum: r.rechnungsdatum, netto: n(r.netto), mwst: n(r.mwst), brutto: n(r.brutto),
    korrektur: n(r.korrektur), durchschnittSaldo: n(r.durchschnitt_saldo), zeilen: r.zeilen || [], warnungen: r.warnungen || [], dateiname: r.dateiname || "",
  }));
}

// Speichert einen geparsten Beleg. ersetzen=false -> bei Dublette Fehler "schon importiert"
export async function speichern(beleg, ersetzen = false) {
  if (beleg.typ === "abrechnung") {
    const row = {
      nr: beleg.nr, datum: beleg.datum, mandant: beleg.mandant || null, uebertrag: beleg.uebertrag, eingereicht: beleg.eingereicht, nicht_angekauft: beleg.nichtAngekauft,
      sperr_einbehalt: beleg.sperrEinbehalt, sperr_freigabe: beleg.sperrFreigabe, gebuehren_netto: beleg.gebuehrenNetto, ust: beleg.ust, auszahlung: beleg.auszahlung,
      endsaldo: beleg.endsaldo, zeilen: beleg.zeilen, positionen: beleg.positionen, warnungen: beleg.warnungen, dateiname: beleg.dateiname || null, importiert_am: new Date().toISOString(),
    };
    const q = ersetzen ? supabase.from("factoring_abrechnungen").upsert(row, { onConflict: "nr" }) : supabase.from("factoring_abrechnungen").insert(row);
    const { error } = await q;
    if (error) throw new Error(error.code === "23505" ? `Abrechnung ${beleg.nr} ist schon importiert` : error.message);
    return;
  }
  const row = {
    rechnungsnr: beleg.rechnungsnr, per_datum: beleg.perDatum, rechnungsdatum: beleg.rechnungsdatum, netto: beleg.netto, mwst: beleg.mwst, brutto: beleg.brutto,
    korrektur: beleg.korrektur, durchschnitt_saldo: beleg.durchschnittSaldo === null ? null : Math.round(beleg.durchschnittSaldo * 100) / 100,
    zeilen: beleg.zeilen, warnungen: beleg.warnungen, dateiname: beleg.dateiname || null, importiert_am: new Date().toISOString(),
  };
  const q = ersetzen ? supabase.from("factoring_zinsen").upsert(row, { onConflict: "rechnungsnr" }) : supabase.from("factoring_zinsen").insert(row);
  const { error } = await q;
  if (error) throw new Error(error.code === "23505" ? `Zinsabrechnung ${beleg.rechnungsnr} ist schon importiert` : error.message);
}

export async function loeschenAbrechnung(nr) {
  const { error } = await supabase.from("factoring_abrechnungen").delete().eq("nr", nr);
  if (error) throw error;
}
export async function loeschenZinsen(rechnungsnr) {
  const { error } = await supabase.from("factoring_zinsen").delete().eq("rechnungsnr", rechnungsnr);
  if (error) throw error;
}

// { "YYYY-MM": { gebuehren, zinsen, summe } }
export function kostenProMonat(abrechnungen, zinsen) {
  const out = {};
  const m = (k) => (out[k] = out[k] || { gebuehren: 0, zinsen: 0, summe: 0 });
  for (const a of abrechnungen || []) { const r = m(a.datum.slice(0, 7)); r.gebuehren += a.gebuehrenNetto || 0; r.summe += a.gebuehrenNetto || 0; }
  for (const z of zinsen || []) { const r = m(z.perDatum.slice(0, 7)); r.zinsen += z.netto || 0; r.summe += z.netto || 0; }
  return out;
}

const pad2 = (x) => String(x).padStart(2, "0");

// -> [{ monat, lkw, betrag }]; start/ende (ISO, optional) schneiden den Monat
// tagesanteilig an. opt: { tours, umsatzVon, fleet, vertraege }
export function verteilen(abrechnungen, zinsen, start, ende, opt) {
  const { tours, umsatzVon, fleet, vertraege } = opt || {};
  // Contargo-Umsatz je Monat und LKW
  const ums = {};
  for (const t of tours || []) {
    if (!t.datum || !t.lkw || t.andererAuftraggeber) continue;
    const k = t.datum.slice(0, 7);
    const u = umsatzVon ? umsatzVon(t) : 0;
    if (!u) continue;
    (ums[k] = ums[k] || {})[t.lkw] = (ums[k][t.lkw] || 0) + u;
  }
  const out = [];
  for (const [monat, k] of Object.entries(kostenProMonat(abrechnungen, zinsen))) {
    if (!k.summe) continue;
    const [j, m] = monat.split("-").map(Number);
    const tage = new Date(j, m, 0).getDate();
    const ms = `${monat}-01`, me = `${monat}-${pad2(tage)}`;
    const a = start && start > ms ? start : ms;
    const e = ende && ende < me ? ende : me;
    if (a > e) continue;
    const anteil = (Number(e.slice(8, 10)) - Number(a.slice(8, 10)) + 1) / tage;
    const u = ums[monat];
    const gesamt = u ? Object.values(u).reduce((s, x) => s + x, 0) : 0;
    if (gesamt > 0) {
      for (const [lkw, x] of Object.entries(u)) out.push({ monat, lkw, betrag: (k.summe * x / gesamt) * anteil, schluessel: "umsatz" });
    } else {
      for (const v of gdb.verteilen([{ posten: "Factoring", monat, betrag: k.summe }], fleet, vertraege, a, e)) out.push({ monat, lkw: v.lkw, betrag: v.betrag, schluessel: "gleich" });
    }
  }
  return out;
}

export function jeLkw(abrechnungen, zinsen, start, ende, opt) {
  const out = {};
  for (const v of verteilen(abrechnungen, zinsen, start, ende, opt)) out[v.lkw] = (out[v.lkw] || 0) + v.betrag;
  return out;
}
