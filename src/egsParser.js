// ============================================================================
// Werkstatt & Teile: Prüfrechnungen vom Kfz-Ingenieurbüro EGS (Rodgau),
// ausgestellt "im Namen und für Rechnung des KÜS e.V.". "EGS" steht nur im
// Briefkopf-Bild, im Text steht KÜS - daran wird der Beleg erkannt.
//
// Aufbau (an R014-01530 geprüft):
//   "Re.-Nr.: R014-01530", "Rechn.-Datum : 03.01.2026"
//   je Fahrzeug zwei Zeilen:
//     "03.01.2026  OF-RY750  WDF9634031B990767"
//     "1.  X183362039  HU+AU  ROYAL Logistik GmbH  F1118001  271,00 EUR"
//   Ende: "Summe netto 455,46 EUR", "Endbetrag Brutto 542,00 EUR"
// Die Einzelpreise sind BRUTTO; netto je Position wird anteilig aus
// Summe netto / Endbetrag berechnet (Rundungscent auf die letzte Position),
// sodass die Positionen genau "Summe netto" ergeben.
// ============================================================================
import { ordneFahrzeugZu } from "./winklerParser";

export const LIEFERANT_EGS = "EGS";

const AMT = "[\\d.]*\\d,\\d{2}";
const zahl = (s) => { const n = parseFloat(String(s).trim().replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const isoDatum = (s) => { const m = String(s || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };

export function istEgs(lines) {
  return lines.some((l) => /KÜS e\.\s?V\./.test(l) || /KÜS Nr\.:/.test(l) || /kues-egs/i.test(l));
}

const KOPF_RE = /^(\d{2}\.\d{2}\.\d{4})\s+(\S+)\s+([A-HJ-NPR-Z0-9]{11,17})\b/;
const POS_RE = new RegExp(`^(\\d+)\\.\\s+(\\S+)\\s{2,}(.+?)\\s{2,}.*?(${AMT})\\s*EUR\\s*$`);

export function parseEgsLines(lines) {
  let belegNr = null, belegDatum = null, netto = null, brutto = null, gutschrift = false;
  const positionen = [];
  let kopf = null;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let m;
    if (!belegNr && (m = t.match(/Re\.-Nr\.:\s*(\S+)/))) { belegNr = m[1]; }
    if (!belegDatum && (m = t.match(/Rechn\.-Datum\s*:\s*(\d{2}\.\d{2}\.\d{4})/))) { belegDatum = isoDatum(m[1]); }
    if (/^Gutschrift\b|Stornorechnung/i.test(t)) gutschrift = true;
    if ((m = t.match(new RegExp(`Summe netto\\s+(-?${AMT})\\s*EUR`)))) { netto = zahl(m[1]); continue; }
    if ((m = t.match(new RegExp(`Endbetrag Brutto\\s+(-?${AMT})\\s*EUR`)))) { brutto = zahl(m[1]); continue; }
    if ((m = t.match(KOPF_RE))) { kopf = { datum: isoDatum(m[1]), kennz: m[2], fin: m[3].toUpperCase() }; continue; }
    if ((m = t.match(POS_RE))) {
      positionen.push({ nr: parseInt(m[1], 10), bericht: m[2], art: m[3].replace(/\s+/g, " ").trim(), brutto: zahl(m[4]), ...(kopf || {}) });
      kopf = null;
    }
  }
  return { belegNr, belegDatum, netto, brutto, gutschrift, positionen };
}

export function aufbereitenEgs(res, fleetPlates, finMap) {
  const vz = res.gutschrift ? -1 : 1;
  const summeBrutto = res.positionen.reduce((s, p) => s + p.brutto, 0);
  const quote = res.netto && res.brutto ? res.netto / res.brutto : 1 / 1.19;
  let rest = res.netto ?? r2(summeBrutto * quote);
  const positionen = res.positionen.map((p, i) => {
    const z = ordneFahrzeugZu(p.kennz, p.fin, fleetPlates, finMap);
    const n = i === res.positionen.length - 1 ? r2(rest) : r2(p.brutto * quote);
    rest -= n;
    return {
      pos: (i + 1) * 10, teil: 1, lieferschein: p.bericht || null, lieferdatum: p.datum || null,
      bestelldaten: p.kennz || null, fin: p.fin || null, lkw: z.lkw, lkw_quelle: z.quelle,
      kategorie: "Prüfung (HU/SP/AU)", artikel_nr: p.bericht || null,
      bezeichnung: `${p.art} (KÜS)`, zusatz: `Bericht ${p.bericht} · ${p.brutto.toFixed(2).replace(".", ",")} € brutto`,
      menge: 1, einheit: "ST", netto: r2(vz * n), pfand: 0, bezug_beleg_nr: null, bezug_pos: null,
      gutschrift_grund: res.gutschrift ? "Rückgabe/Reklamation" : null, hinweis: z.hinweis || null,
      anlass: p.art, km_stand: null,
    };
  });
  const parsedSumme = r2(positionen.reduce((s, p) => s + vz * p.netto, 0));
  // Kontrolle: Brutto-Einzelpreise müssen den Endbetrag ergeben
  const bruttoOk = res.brutto !== null && Math.abs(r2(summeBrutto) - res.brutto) <= 0.005;
  return {
    lieferant: LIEFERANT_EGS,
    belegNr: res.belegNr,
    belegart: res.gutschrift ? "gutschrift" : "rechnung",
    belegDatum: res.belegDatum,
    dokumentSumme: bruttoOk ? res.netto : res.brutto,
    parsedSumme: bruttoOk ? parsedSumme : r2(summeBrutto),
    summenAbweichung: res.netto === null || !bruttoOk,
    netto: r2(vz * (res.netto ?? parsedSumme)),
    brutto: res.brutto === null ? null : r2(vz * res.brutto),
    bemerkung: "Prüfstelle EGS Rodgau, im Namen des KÜS e.V.",
    positionen,
  };
}
