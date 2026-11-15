// ============================================================================
// Werkstatt & Teile: Werkstattrechnungen von TSB Darmstadt GmbH (Weiterstadt).
// PDF.js + geometrische Zeilen, KEIN KI/OCR.
//
// Aufbau (an RE 202601586, 1648, 1732, 1770, 2669 geprüft):
//   Kopf:  "Kfz-Kennzeichen : OF RY 500", "Fahrgestellnr. : XLRT…",
//          "KM-Stand : 741.254", "Rechnung Nr. 202601586",
//          "Belegdatum : 12.06.2026", "Auftragsnummer : 2601673"
//   Arbeitstext: "KUNDENBEANSTANDUNG:" + Beschreibung (Großbuchstaben)
//   Positionen: "[Artikel]  Bezeichnung  [Menge Einheit]  [Einzel]  Gesamt"
//     z. B. "D4  ARBEITSEINHEIT  1,50 Std  114,50  171,75"
//           "2465356  TEMPERATUR- UND  1,00 St  630,00  630,00"
//           (+ Folgezeile "FÜLLSTANDSENSOR FÜR ADBLUE")
//           "Beschaffung / Handling Teile  25,20"
//   Ende:  "Teile gesamt / Lohn gesamt", "Nettobetrag … 936,75",
//          "Endbetrag : 1.114,73 €"
// Ein TSB-Beleg gehört zu genau einem Fahrzeug (Kopf). Eigenkontrolle:
// Summe der Positionen = Nettobetrag, sonst kein Import.
// ============================================================================
import { kategorieVorschlag, ordneFahrzeugZu } from "./winklerParser";

export const LIEFERANT_TSB = "TSB";

const AMT = "[\\d.]*\\d,\\d{2}";
function zahl(s) {
  const n = parseFloat(String(s).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
const r2 = (n) => Math.round(n * 100) / 100;
function isoDatum(s) {
  const m = String(s || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

export function istTsb(lines) {
  return lines.some((l) => /TSB Darmstadt GmbH/i.test(l));
}

// Kopf (Artikel + Bezeichnung) · optional Menge+Einheit · optional Einzel · Gesamt
const POS_RE = new RegExp(`^(.+?)\\s{2,}(?:(\\d+(?:,\\d+)?)\\s+(Std|St|Stk|kg|g|ml|l|L|m|Satz|Set)\\s+)?(?:(${AMT})\\s+)?(${AMT})$`);
const KEINE_POS = /^(Zwischensumme|Übertrag|Endbetrag|Nettobetrag|Rechnung Nr|Gutschrift Nr|Datum)/i;
const FORTSETZUNG = /(\bUND|\bFÜR|\bMIT|-|,)$/;

export function parseTsbLines(lines) {
  let belegNr = null, belegart = "rechnung", belegDatum = null, netto = null, brutto = null;
  let kennz = "", fin = "", km = null, auftrag = "";
  let teileGesamt = null, lohnGesamt = null;
  const text = [];
  const positionen = [];
  let imTabelle = false, ende = false, cur = null, wartetNetto = false, wartetTeile = false, wartetLohn = false;

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let m;
    if ((m = t.match(/^Kfz-Kennzeichen\s*:\s*(.+)$/))) { kennz = m[1].trim(); continue; }
    if ((m = t.match(/^Fahrgestellnr\.\s*:\s*([A-Z0-9]{11,17})/i))) { fin = m[1].toUpperCase(); continue; }
    if ((m = t.match(/^KM-Stand\s*:\s*([\d.]+)/))) { const n = parseInt(m[1].replace(/\./g, ""), 10); km = n > 0 ? n : null; continue; }
    if (!belegNr && (m = t.match(/^(Rechnung|Gutschrift|Storno\w*)\s+Nr\.\s*(\d+)/i))) {
      belegNr = m[2];
      if (!/^Rechnung/i.test(m[1])) belegart = "gutschrift";
      continue;
    }
    if ((m = t.match(/^Belegdatum\s*:\s*(\d{2}\.\d{2}\.\d{4})/))) { belegDatum = isoDatum(m[1]); continue; }
    if ((m = t.match(/^Auftragsnummer\s*:\s*(\S+)/))) { auftrag = m[1]; continue; }
    if ((m = t.match(new RegExp(`^Endbetrag\\s*:\\s*(-?${AMT})`)))) { brutto = zahl(m[1]); continue; }

    // Summenblock unten (Werte stehen in der Zeile UNTER der Überschrift)
    if (/^Teile voll/.test(t)) { ende = true; wartetTeile = true; continue; }
    if (wartetTeile) { const z = t.match(new RegExp(AMT, "g")); if (z) teileGesamt = zahl(z[z.length - 1]); wartetTeile = false; continue; }
    if (/^Fremdleistung\b.*Lohn gesamt/.test(t)) { wartetLohn = true; continue; }
    if (wartetLohn) { const z = t.match(new RegExp(AMT, "g")); if (z) lohnGesamt = zahl(z[z.length - 1]); wartetLohn = false; continue; }
    if (/Nettobetrag\s*$/.test(t)) { wartetNetto = true; continue; }
    if (wartetNetto) { const z = t.match(new RegExp(`-?${AMT}`, "g")); if (z) netto = zahl(z[z.length - 1]); wartetNetto = false; continue; }

    if (/^Artikelnummer\s+Bezeichnung/.test(t)) { imTabelle = true; cur = null; continue; }
    if (!imTabelle || ende) continue;
    if (/^Wir\s+wünschen/.test(t)) { ende = true; continue; }
    if (KEINE_POS.test(t)) { cur = null; continue; }

    if ((m = t.match(POS_RE))) {
      const kopf = m[1].split(/\s{2,}/);
      const artikel = kopf.length > 1 ? kopf[0] : "";
      const bez = (kopf.length > 1 ? kopf.slice(1).join(" ") : kopf[0]).replace(/\s+/g, " ").trim();
      cur = {
        artikel, bezeichnung: bez, menge: m[2] ? zahl(m[2]) : 1, einheit: m[3] || "",
        einzel: m[4] ? zahl(m[4]) : null, gesamt: zahl(m[5]),
      };
      positionen.push(cur);
      continue;
    }
    // Folgezeile einer umbrochenen Bezeichnung ("TEMPERATUR- UND" / "FÜLLSTANDSENSOR …")
    if (cur && FORTSETZUNG.test(cur.bezeichnung)) {
      cur.bezeichnung = (cur.bezeichnung.endsWith("-") ? cur.bezeichnung : cur.bezeichnung + " ") + t.replace(/\s+/g, " ");
      cur = null;
      continue;
    }
    cur = null;
    if (positionen.length === 0 && t !== ":" && !/^Kunden-Steuer/.test(t)) text.push(t.replace(/\s+/g, " "));
  }
  return { belegNr, belegart, belegDatum, netto, brutto, kennz, fin, km, auftrag, teileGesamt, lohnGesamt, text, positionen };
}

function istLohn(p) {
  if (/^std$/i.test(p.einheit)) return true;
  if (/^(VOR|D\d|AW|AB)$/i.test(p.artikel)) return true;
  return /arbeitseinheit|nachlaufzeit|verwendung|abschleppen|arbeitslohn|probefahrt/i.test(p.bezeichnung);
}
function kategorie(p) {
  if (istLohn(p)) return "Werkstatt (Lohn)";
  const b = p.bezeichnung.toLowerCase();
  if (/kleinteile|kleinmaterial/.test(b)) return "Werkstattbedarf";
  if (/kältemittel|kompressionsöl|motoröl|getriebeöl|frostschutz/.test(b)) return "Betriebsstoff";
  if (/reifen/.test(b)) return "Reifen";
  if (/hauptuntersuchung|abgasuntersuchung|sicherheitsprüfung/.test(b)) return "Prüfung (HU/SP/AU)";
  return kategorieVorschlag(p.bezeichnung);
}

// Anlass = erste Zeile der Kundenbeanstandung bzw. des Arbeitstextes
function anlassAus(text) {
  const i = text.findIndex((l) => /^KUNDENBEANSTANDUNG:?$/i.test(l));
  const zeile = (i >= 0 ? text[i + 1] : text[0]) || "";
  const s = zeile.replace(/\s*>\s*/g, " – ").trim();
  if (!s) return null;
  return s.length > 90 ? s.slice(0, 87) + "…" : s;
}

export function aufbereitenTsb(res, fleetPlates, finMap) {
  const z = ordneFahrzeugZu(res.kennz, res.fin, fleetPlates, finMap);
  const vz = res.belegart === "gutschrift" && (res.netto ?? 0) > 0 ? -1 : 1;
  const anlass = anlassAus(res.text);
  const positionen = res.positionen
    .filter((p) => p.gesamt !== 0)
    .map((p, i) => {
      const pfand = /altteilpfand/i.test(p.bezeichnung);
      return {
        pos: (i + 1) * 10, teil: 1, lieferschein: null, lieferdatum: null,
        bestelldaten: res.kennz || null, fin: res.fin || null,
        lkw: z.lkw, lkw_quelle: z.quelle, kategorie: pfand ? "Ersatzteil" : kategorie(p),
        artikel_nr: p.artikel || null, bezeichnung: p.bezeichnung || "(ohne Bezeichnung)",
        zusatz: pfand ? "Pfand – kommt bei Rückgabe des Altteils als Gutschrift zurück" : null,
        menge: p.menge, einheit: p.einheit || "ST",
        netto: pfand ? 0 : r2(vz * p.gesamt), pfand: pfand ? r2(vz * p.gesamt) : 0,
        bezug_beleg_nr: null, bezug_pos: null,
        gutschrift_grund: res.belegart === "gutschrift" ? "Rückgabe/Reklamation" : null,
        hinweis: z.hinweis || null, anlass, km_stand: res.km,
      };
    });
  const parsedSumme = r2(res.positionen.reduce((s, p) => s + p.gesamt, 0));
  const textKurz = res.text.filter((l) => !/^KUNDENBEANSTANDUNG/i.test(l)).join(" ").replace(/\s+/g, " ");
  return {
    lieferant: LIEFERANT_TSB,
    belegNr: res.belegNr,
    belegart: res.belegart,
    belegDatum: res.belegDatum,
    dokumentSumme: res.netto,
    parsedSumme,
    summenAbweichung: res.netto === null || Math.abs(parsedSumme - res.netto) > 0.005,
    netto: r2(vz * (res.netto ?? parsedSumme)),
    brutto: res.brutto === null ? null : r2(vz * res.brutto),
    bemerkung: [res.auftrag ? `Auftrag ${res.auftrag}` : "", textKurz].filter(Boolean).join(" · ").slice(0, 1000) || null,
    positionen,
  };
}
