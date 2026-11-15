// ============================================================================
// Werkstatt & Teile: Rechnungen/Gutschriften von Heinrich Göbel GmbH
// (Mercedes-Benz-Partner, Händlersystem "alfa transform"). Wie Winkler:
// PDF.js + geometrische Zeilen, KEIN KI/OCR.
//
// Aufbau (an RE 32017698 und 32017876 geprüft):
//   Kopf:  "Kennzeichen OF-RY800 ... Rechnung Datum 23.01.2026"
//          "Fahrg.-Nr. WDF9634031B995000", "KM-Stand ..."
//          "Thekenverkauf   32017876 / 21855200"  (Beleg-Nr / Kundenkonto)
//   Abschnitte (gesperrt gedruckt): "E r s a t z t e i l e", Arbeit, Sonstiges
//   Position: "1,00  A9608303363  ROHRLEITUNG   10,00  1  123,75  111,38"
//             Menge, Nummer, Bezeichnung, [Anteil/Rabatt %], USt-Kz,
//             Einzelpreis netto, Gesamtpreis netto
//   Ende:  "Summe Teile / Summe Arbeit / Summe Sonstiges", "S u m m e EUR x",
//          "T O T A L EUR y"
// Ein Göbel-Beleg gehört zu genau einem Fahrzeug (Kopf). Eigenkontrolle:
// Summe der Positionen = "Summe" netto, sonst kein Import.
// ============================================================================
import { kategorieVorschlag, ordneFahrzeugZu } from "./winklerParser";

export const LIEFERANT_GOEBEL = "Heinrich Göbel";

const BETRAG = "-?[\\d.]*\\d,\\d{2}-?";
function zahl(s) {
  let t = String(s).trim();
  const neg = t.endsWith("-") || t.startsWith("-");
  t = t.replace(/-/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(t);
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}
const r2 = (n) => Math.round(n * 100) / 100;
function isoDatum(s) {
  const m = String(s || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}
const kompakt = (t) => t.replace(/\s+/g, "");

export function istGoebel(lines) {
  return lines.some((l) => /Heinrich Göbel GmbH/i.test(l));
}

// Position: Menge, Nummer, Bezeichnung, dann nur noch Zahlen bis zum Ende.
const POS_RE = new RegExp(`^(\\d+,\\d{2})\\s+(\\S+)\\s+(.+?)\\s{2,}((?:${BETRAG}|\\d)(?:\\s+(?:${BETRAG}|\\d))*)\\s*$`);

function abschnitt(t) {
  const k = kompakt(t).toLowerCase();
  if (/^ersatzteile|^teile$|^material$/.test(k)) return "teile";
  if (/^arbeit|^arbeitswerte|^lohn|^arbeitslohn/.test(k)) return "arbeit";
  if (/^sonstiges|^fremdleistung|^nebenkosten/.test(k)) return "sonstiges";
  return null;
}

export function parseGoebelLines(lines) {
  let belegNr = null, belegart = "rechnung", belegDatum = null, summe = null, brutto = null;
  let kennz = "", fin = "", km = null, ls = null, lsDatum = null, auftrag = "";
  const summen = {};
  let sektion = "teile";
  const positionen = [];

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    const k = kompakt(t);
    let m;
    if ((m = t.match(/^Kennzeichen\s+(\S+)/))) kennz = m[1];
    if ((m = t.match(/(Rechnung|Gutschrift|Storno\w*)\s+Datum\s+(\d{2}\.\d{2}\.\d{4})/i))) {
      belegDatum = isoDatum(m[2]);
      if (!/^Rechnung/i.test(m[1])) belegart = "gutschrift";
    }
    if ((m = t.match(/^Fahrg\.-Nr\.\s+([A-Z0-9]{11,17})/i))) { fin = m[1].toUpperCase(); continue; }
    if ((m = t.match(/^KM-Stand\s+([\d.]+)\b/))) { const n = parseInt(m[1].replace(/\./g, ""), 10); if (n > 0) km = n; continue; }
    if ((m = t.match(/Auftrag\s+(\d+\s*\/\s*\d+)\s*$/))) auftrag = m[1].replace(/\s/g, "");
    if (!belegNr && (m = t.match(/(\d{6,10})\s*\/\s*(\d{5,10})\s*$/)) && !/Auftrag/.test(t)) { belegNr = m[1]; continue; }
    if (/^Gutschrift\b/i.test(t) && /Kundenkonto/.test(t)) belegart = "gutschrift";
    if ((m = t.match(/^Lieferschein\s+(\S+)\s+vom\s+(\d{2}\.\d{2}\.\d{4})/))) { ls = m[1]; lsDatum = isoDatum(m[2]); continue; }
    if ((m = t.match(new RegExp(`(?:^|\\s{2,})(?:S u m m e|Summe)\\s+EUR\\s+(${BETRAG})\\s*$`)))) { summe = zahl(m[1]); continue; }
    if ((m = k.match(new RegExp(`TOTALEUR(${BETRAG})$`)))) { brutto = zahl(m[1]); continue; }
    if ((m = t.match(new RegExp(`Summe (Teile|Arbeit|Sonstiges)\\s+EUR\\s+(${BETRAG})`)))) summen[m[1].toLowerCase()] = zahl(m[2]);
    const s = abschnitt(t);
    if (s) { sektion = s; continue; }

    if ((m = t.match(POS_RE))) {
      const zahlen = m[4].trim().split(/\s+/);
      if (zahlen.length < 3) continue; // mind. USt-Kz, Einzel, Gesamt
      const gesamt = zahl(zahlen[zahlen.length - 1]);
      const einzel = zahl(zahlen[zahlen.length - 2]);
      const rabatt = zahlen.length >= 4 ? zahl(zahlen[zahlen.length - 4]) : 0;
      positionen.push({
        menge: zahl(m[1]), nummer: m[2], bezeichnung: m[3].replace(/\s{2,}/g, " ").trim(),
        einzel, gesamt, rabatt, sektion, lieferschein: ls, lieferdatum: lsDatum,
      });
    }
  }
  return { belegNr, belegart, belegDatum, summe, brutto, kennz, fin, km, auftrag, summen, positionen };
}

function kategorie(p) {
  if (p.sektion === "arbeit") return "Werkstatt (Lohn)";
  const b = p.bezeichnung.toLowerCase();
  if (/hauptuntersuchung|\bhu\b|abgasuntersuchung|\bau\b|sicherheitspr|tacho.*prüf|§ ?57b/.test(b)) return "Prüfung (HU/SP/AU)";
  if (/reifen/.test(b)) return "Reifen";
  if (/wartung|inspektion|service/.test(b)) return "Wartung/Service";
  if (p.sektion === "sonstiges") return /altöl|entsorg|kleinmaterial|umwelt/.test(b) ? "Werkstattbedarf" : "Werkstatt (Lohn)";
  return kategorieVorschlag(p.bezeichnung);
}

export function aufbereitenGoebel(res, fleetPlates, finMap) {
  const z = ordneFahrzeugZu(res.kennz, res.fin, fleetPlates, finMap);
  // Gutschriften negativ speichern (falls im PDF positiv gedruckt)
  const vz = res.belegart === "gutschrift" && (res.summe ?? 0) > 0 ? -1 : 1;
  const positionen = res.positionen
    .filter((p) => p.gesamt !== 0)
    .map((p, i) => ({
      pos: (i + 1) * 10, teil: 1, lieferschein: p.lieferschein, lieferdatum: p.lieferdatum,
      bestelldaten: res.kennz || null, fin: res.fin || null,
      lkw: z.lkw, lkw_quelle: z.quelle, kategorie: kategorie(p), artikel_nr: p.nummer,
      bezeichnung: p.bezeichnung || "(ohne Bezeichnung)",
      zusatz: p.rabatt ? `${String(p.rabatt).replace(".", ",")} % Rabatt` : null,
      menge: p.menge, einheit: p.sektion === "arbeit" ? "AW" : "ST",
      netto: r2(vz * p.gesamt), pfand: 0, bezug_beleg_nr: null, bezug_pos: null,
      gutschrift_grund: res.belegart === "gutschrift" ? "Rückgabe/Reklamation" : null,
      hinweis: z.hinweis || null, anlass: null, km_stand: res.km,
    }));
  const parsedSumme = r2(res.positionen.reduce((s, p) => s + p.gesamt, 0));
  return {
    lieferant: LIEFERANT_GOEBEL,
    belegNr: res.belegNr,
    belegart: res.belegart,
    belegDatum: res.belegDatum,
    dokumentSumme: res.summe,
    parsedSumme,
    summenAbweichung: res.summe === null || Math.abs(parsedSumme - res.summe) > 0.005,
    netto: r2(vz * (res.summe ?? parsedSumme)),
    brutto: res.brutto === null ? null : r2(vz * res.brutto),
    bemerkung: res.auftrag ? `Auftrag ${res.auftrag}` : null,
    positionen,
  };
}
