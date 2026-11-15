// Für Rechnungen OHNE eigenen PDF-Leser: allgemeine Angaben aus dem Text
// herausziehen, um das Formular "Beleg manuell erfassen" vorzufüllen.
// Bewusst vorsichtig - was nicht sicher erkennbar ist, bleibt leer. Der
// Nutzer prüft und ergänzt (Positionen trägt er selbst ein).
import { ordneFahrzeugZu } from "./winklerParser";

const AMT = "-?[\\d.]*\\d,\\d{2}";
const zahl = (s) => { const n = parseFloat(String(s).trim().replace(/\./g, "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
const isoDatum = (s) => { const m = String(s || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/); if (!m) return null; const j = m[3].length === 2 ? "20" + m[3] : m[3]; return `${j}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; };
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, "");

// Erste Zahl hinter einem Stichwort (gleiche Zeile, sonst nächste Zeile)
function betragNach(lines, re) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const rest = lines[i].slice(m.index + m[0].length);
    const z = rest.match(new RegExp(AMT));
    if (z) return zahl(z[0]);
    const n = (lines[i + 1] || "").match(new RegExp(AMT, "g"));
    if (n) return zahl(n[n.length - 1]);
  }
  return null;
}

export function belegVorschlag(lines, fleetPlates, finMap, lieferanten) {
  const text = lines.join("\n");
  const v = {};

  // Lieferant: bekannter Name aus der Lieferantenliste im Text (nicht wir selbst)
  const textNorm = norm(text);
  const treffer = (lieferanten || [])
    .map((l) => l.name)
    .filter((n) => n && norm(n).length >= 3 && textNorm.includes(norm(n)))
    .sort((a, b) => b.length - a.length);
  if (treffer.length) v.lieferant = treffer[0];
  else {
    // sonst die Firmenzeile oben (GmbH/AG/KG …), die nicht Royal Logistik ist
    const firma = lines.slice(0, 25).map((l) => l.trim()).find((l) => /\b(GmbH|AG|KG|e\.K\.|OHG|UG)\b/.test(l) && !/royal/i.test(l) && !/^(im Namen|USt|Sitz|Geschäftsf|Registerger|Bankverb)/i.test(l));
    if (firma) {
      const teil = firma.split(/\s{2,}|[|,]/).find((t) => /\b(GmbH|AG|KG|e\.K\.|OHG|UG)\b/.test(t)) || firma;
      v.lieferant = teil.replace(/\s+/g, " ").trim().slice(0, 60);
    }
  }

  if (/^\s*(Gutschrift|Rechnungskorrektur|Storno)/im.test(lines.slice(0, 40).join("\n"))) v.belegart = "gutschrift";

  let m;
  m = text.match(/(?:Rechnungs?[- ]?(?:Nr|Nummer)|Re\.-?Nr|Beleg-?(?:Nr|Nummer)|Gutschrifts?-?Nr|Invoice\s*(?:No|Nr))\.?\s*:?\s*([A-Z0-9][A-Z0-9\-\/]{3,24})/i);
  if (m) v.belegNr = m[1];

  m = text.match(/(?:Rechnungs?-?datum|Rechn\.-Datum|Belegdatum|Ausstellungsdatum|Datum)\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{2,4})/i)
    || text.match(/(\d{2}\.\d{2}\.20\d{2})/);
  if (m) v.datum = isoDatum(m[1]);

  // Fahrzeug: FIN aus dem Stamm, sonst Kennzeichen aus dem Fuhrpark
  const fins = text.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || [];
  let fin = fins.find((f) => Object.keys(finMap || {}).some((k) => norm(k) === f)) || "";
  // mehrere Fahrzeuge auf einer Rechnung -> kein Vorschlag (je Position wählen)
  const platten = (fleetPlates || []).filter((p) => textNorm.includes(norm(p)));
  const finsBekannt = new Set(fins.filter((f) => Object.keys(finMap || {}).some((k) => norm(k) === f)));
  const platte = platten.length === 1 ? platten[0] : "";
  if (platten.length > 1 || finsBekannt.size > 1) fin = "";
  else if (fin || platte) {
    const z = ordneFahrzeugZu(platte || "", fin, fleetPlates, finMap);
    if (z.lkw) v.lkw = z.lkw;
  }

  m = text.match(/(?:km-?Stand|Kilometer(?:stand)?|Laufleistung)\s*:?\s*([\d.]{3,9})\b/i);
  if (m) { const km = parseInt(m[1].replace(/\./g, ""), 10); if (km > 100) v.kmStand = km; }

  v.netto = betragNach(lines, /(Summe netto|Nettobetrag|Netto-?Betrag|Summe ohne MwSt|Summe EUR ohne MwSt|Waren- und Leistungswert|Gesamt netto|Netto gesamt|Summe Artikel)\b/i);
  v.brutto = betragNach(lines, /(Endbetrag|Gesamtbetrag|Rechnungsendbetrag|Rechnungsbetrag|Bruttobetrag|Zahlbetrag|Gesamt brutto|Total\b)/i);
  return v;
}
