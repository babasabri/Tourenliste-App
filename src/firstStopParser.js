// ============================================================================
// Werkstatt & Teile: Reifenrechnungen von First Stop Reifen Auto Service
// (SAP-Formular "Z_INVOICE_PRS"). PDF.js + geometrische Zeilen, KEIN KI/OCR.
//
// Aufbau (an RE 1024173877, 1024232664, 1024232665 geprüft):
//   "Belegnummer: 1024173877", "Belegdatum: 23.09.2026"
//   "KFZ-Kennzeichen: OF-RY 750   Kilometerstand: 562652"
//   Position: "10  473136  2,00 ST  19 %  574,00  1.148,00"
//             darunter Bezeichnung ("385/65R 22.5 160K TL ECOPIA STEER"),
//             Hersteller, EU-Reifenlabel …
//   Ende: "Summe Positionen 1.326,60", "Endbetrag EUR 1.578,65"
// Reifen -> Kategorie "Reifen", Montage/Wuchten/Radwechsel -> Werkstatt (Lohn),
// Entsorgung/Montagehilfsstoffe -> Werkstattbedarf.
// ============================================================================
import { ordneFahrzeugZu } from "./winklerParser";

export const LIEFERANT_FIRSTSTOP = "First Stop";

const AMT = "-?[\\d.]*\\d,\\d{2}";
const zahl = (s) => { const n = parseFloat(String(s).trim().replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;
const isoDatum = (s) => { const m = String(s || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null; };

export function istFirstStop(lines) {
  return lines.some((l) => /First Stop Reifen Auto Service/i.test(l));
}

const POS_RE = new RegExp(`^(\\d{1,4})\\s+(\\S+)\\s+(\\d+(?:,\\d+)?)\\s+([A-Z]{1,4})\\s+\\d{1,2}\\s*%\\s+(${AMT})\\s+(${AMT})\\s*$`);

export function parseFirstStopLines(lines) {
  let belegNr = null, belegDatum = null, summe = null, brutto = null, kennz = "", km = null, auftrag = "", lsDatum = null, gutschrift = false;
  const hinweise = [];
  const positionen = [];
  let cur = null, inTabelle = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let m;
    if (!belegNr && (m = t.match(/Belegnummer:\s*(\d{6,})/))) { belegNr = m[1]; continue; }
    if (!belegDatum && (m = t.match(/^Belegdatum:\s*(\d{2}\.\d{2}\.\d{4})/))) { belegDatum = isoDatum(m[1]); continue; }
    if (/^(Gutschrift|Rechnungskorrektur|Storno)/i.test(t)) gutschrift = true;
    if ((m = t.match(/^KFZ-Kennzeichen:\s*(\S+(?:\s\S+)?)(?:\s{2,}|$)/))) kennz = m[1].trim();
    if ((m = t.match(/Kilometerstand:\s*([\d.]+)/))) { const n = parseInt(m[1].replace(/\./g, ""), 10); if (n > 0) km = n; }
    if (kennz && /^KFZ-Kennzeichen/.test(t)) continue;
    if ((m = t.match(/^Auftrags-Nr\.\/Datum:\s*(\S+)/))) { auftrag = m[1]; continue; }
    if ((m = t.match(/Lieferdatum:\s*(\d{2}\.\d{2}\.\d{4})/))) { lsDatum = isoDatum(m[1]); continue; }
    if (/^Pos\s+Bezeichnung/.test(t)) { inTabelle = true; continue; }
    if ((m = t.match(new RegExp(`^Summe Positionen\\s+(${AMT})`)))) { summe = zahl(m[1]); inTabelle = false; cur = null; continue; }
    if ((m = t.match(new RegExp(`^Endbetrag EUR\\s+(${AMT})`)))) { brutto = zahl(m[1]); continue; }
    // freie Hinweiszeile vor der Tabelle (z. B. "2x Eigentum Reifen sind …")
    if (!inTabelle && /^\d+x\s/i.test(t)) { hinweise.push(t.replace(/\s+/g, " ")); continue; }
    if (!inTabelle) continue;
    if (/^_{5,}/.test(t)) continue;
    if ((m = t.match(POS_RE))) {
      cur = { pos: parseInt(m[1], 10), artikel: m[2], menge: zahl(m[3]), einheit: m[4], gesamt: zahl(m[6]), text: [] };
      positionen.push(cur);
      continue;
    }
    if (cur) cur.text.push(t.replace(/\s+/g, " "));
  }
  return { belegNr, belegDatum, summe, brutto, kennz, km, auftrag, lsDatum, gutschrift, hinweise, positionen };
}

function kategorie(bez) {
  const b = bez.toLowerCase();
  if (/montage ab|wuchten|radwechsel|ventil|reifendruck|achsvermessung|arbeitszeit|pannen|einsatz|anfahrt/.test(b)) return "Werkstatt (Lohn)";
  if (/entsorgung|montagehilfs|altreifen/.test(b)) return "Werkstattbedarf";
  return "Reifen";
}

export function aufbereitenFirstStop(res, fleetPlates, finMap) {
  const z = ordneFahrzeugZu(res.kennz, "", fleetPlates, finMap);
  const vz = res.gutschrift && (res.summe ?? 0) > 0 ? -1 : 1;
  const positionen = res.positionen.filter((p) => p.gesamt !== 0).map((p, i) => {
    const bez = p.text[0] || p.artikel;
    // Reifen: Hersteller + EU-Label als Zusatz
    const label = p.text.find((s) => /Kraftstoffeffizienz/i.test(s));
    const zusatz = [p.text[1] && !/EU-Reifenlabel/.test(p.text[1]) ? p.text[1] : "", p.text[2] && /M\+S|VA|HA|Trailer|Antrieb/i.test(p.text[2]) ? p.text[2] : "", label || ""].filter(Boolean).join(" · ") || null;
    return {
      pos: p.pos || (i + 1) * 10, teil: 1, lieferschein: null, lieferdatum: res.lsDatum, bestelldaten: res.kennz || null, fin: null,
      lkw: z.lkw, lkw_quelle: z.quelle, kategorie: kategorie(bez), artikel_nr: p.artikel, bezeichnung: bez, zusatz,
      menge: p.menge, einheit: p.einheit === "ST" ? "ST" : p.einheit, netto: r2(vz * p.gesamt), pfand: 0,
      bezug_beleg_nr: null, bezug_pos: null, gutschrift_grund: res.gutschrift ? "Rückgabe/Reklamation" : null,
      hinweis: z.hinweis || null, anlass: res.hinweise[0] || null, km_stand: res.km,
    };
  });
  const parsedSumme = r2(res.positionen.reduce((s, p) => s + p.gesamt, 0));
  return {
    lieferant: LIEFERANT_FIRSTSTOP,
    belegNr: res.belegNr,
    belegart: res.gutschrift ? "gutschrift" : "rechnung",
    belegDatum: res.belegDatum,
    dokumentSumme: res.summe,
    parsedSumme,
    summenAbweichung: res.summe === null || Math.abs(parsedSumme - res.summe) > 0.005,
    netto: r2(vz * (res.summe ?? parsedSumme)),
    brutto: res.brutto === null ? null : r2(vz * res.brutto),
    bemerkung: ["First Stop Reifen Auto Service, Neu-Isenburg", res.auftrag ? `Auftrag ${res.auftrag}` : "", ...res.hinweise].filter(Boolean).join(" · "),
    positionen,
  };
}
