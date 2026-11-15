// Erkennt den Lieferanten eines Beleg-PDFs und wählt den passenden Leser.
// Unterstützt: Winkler (Rechnung/Gutschrift), Heinrich Göbel (Mercedes), TSB Darmstadt.
import { loadPdfjs, extractLayoutLines } from "./gutschriftParser";
import { winklerAusZeilen } from "./winklerParser";
import { istGoebel, parseGoebelLines, aufbereitenGoebel } from "./goebelParser";
import { istTsb, parseTsbLines, aufbereitenTsb } from "./tsbParser";
import { istEgs, parseEgsLines, aufbereitenEgs } from "./egsParser";
import { belegVorschlag } from "./belegVorschlag";
import { istFirstStop, parseFirstStopLines, aufbereitenFirstStop } from "./firstStopParser";
import { zugferdXmlAusPdf, parseZugferd } from "./zugferdParser";

export const UNTERSTUETZT = "Winkler, Heinrich Göbel, TSB Darmstadt, EGS/KÜS, First Stop und alle E-Rechnungen (ZUGFeRD/XRechnung)";

export function belegAusZeilen(lines, dateiname, fleetPlates, finMap, lieferanten = [], xml = null) {
  if (istGoebel(lines)) {
    const res = parseGoebelLines(lines);
    if (!res.belegNr || res.positionen.length === 0) throw new Error("Göbel-Beleg ohne Belegnummer oder ohne Positionen - Layout unbekannt.");
    return { dateiname, quelle: "goebel_pdf", ...aufbereitenGoebel(res, fleetPlates, finMap) };
  }
  if (istTsb(lines)) {
    const res = parseTsbLines(lines);
    if (!res.belegNr || res.positionen.length === 0) throw new Error("TSB-Beleg ohne Belegnummer oder ohne Positionen - Layout unbekannt.");
    return { dateiname, quelle: "tsb_pdf", ...aufbereitenTsb(res, fleetPlates, finMap) };
  }
  if (istFirstStop(lines)) {
    const res = parseFirstStopLines(lines);
    if (!res.belegNr || res.positionen.length === 0) throw new Error("First-Stop-Beleg ohne Belegnummer oder ohne Positionen - Layout unbekannt.");
    return { dateiname, quelle: "firststop_pdf", ...aufbereitenFirstStop(res, fleetPlates, finMap) };
  }
  if (istEgs(lines)) {
    const res = parseEgsLines(lines);
    if (!res.belegNr || res.positionen.length === 0) throw new Error("EGS/KÜS-Beleg ohne Belegnummer oder ohne Positionen - Layout unbekannt.");
    return { dateiname, quelle: "egs_pdf", ...aufbereitenEgs(res, fleetPlates, finMap) };
  }
  if (lines.some((l) => /Winkler/i.test(l))) return winklerAusZeilen(lines, dateiname, fleetPlates, finMap);
  // E-Rechnung: XML im PDF enthält alle Daten - für jeden Lieferanten
  if (xml) return { dateiname, quelle: "zugferd", ...parseZugferd(xml, lines, fleetPlates, finMap, lieferanten) };

  // Kein eigener Leser: Fehler mit Vorschlag fürs manuelle Formular
  const scan = lines.join("").replace(/\s/g, "").length < 50;
  const err = new Error(scan
    ? "Eingescannt (nur Bild) – nicht automatisch lesbar."
    : "Kein automatischer Leser für diesen Lieferanten.");
  err.vorlage = scan ? { scan: true } : belegVorschlag(lines, fleetPlates, finMap, lieferanten);
  throw err;
}

export async function parseBelegPdf(file, fleetPlates, finMap, lieferanten = []) {
  const pdfjsLib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch {
    throw new Error("PDF konnte nicht geöffnet werden - ist die Datei beschädigt oder passwortgeschützt?");
  }
  const lines = await extractLayoutLines(pdf);
  const xml = await zugferdXmlAusPdf(pdf);
  return belegAusZeilen(lines, file.name, fleetPlates, finMap, lieferanten, xml);
}
