// Erkennt den Lieferanten eines Beleg-PDFs und wählt den passenden Leser.
// Unterstützt: Winkler (Rechnung/Gutschrift), Heinrich Göbel (Mercedes), TSB Darmstadt.
import { loadPdfjs, extractLayoutLines } from "./gutschriftParser";
import { winklerAusZeilen } from "./winklerParser";
import { istGoebel, parseGoebelLines, aufbereitenGoebel } from "./goebelParser";
import { istTsb, parseTsbLines, aufbereitenTsb } from "./tsbParser";
import { istEgs, parseEgsLines, aufbereitenEgs } from "./egsParser";

export const UNTERSTUETZT = "Winkler, Heinrich Göbel, TSB Darmstadt, EGS/KÜS";

export function belegAusZeilen(lines, dateiname, fleetPlates, finMap) {
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
  if (istEgs(lines)) {
    const res = parseEgsLines(lines);
    if (!res.belegNr || res.positionen.length === 0) throw new Error("EGS/KÜS-Beleg ohne Belegnummer oder ohne Positionen - Layout unbekannt.");
    return { dateiname, quelle: "egs_pdf", ...aufbereitenEgs(res, fleetPlates, finMap) };
  }
  if (lines.some((l) => /Winkler/i.test(l))) return winklerAusZeilen(lines, dateiname, fleetPlates, finMap);
  if (lines.join("").replace(/\s/g, "").length < 50)
    throw new Error("Eingescannte Rechnung (nur Bild, kein Text) – kann nicht automatisch gelesen werden. Bitte über „Beleg manuell erfassen“ eintragen und den Scan anhängen.");
  throw new Error(`Für diesen Lieferanten gibt es noch keinen automatischen PDF-Leser (vorhanden: ${UNTERSTUETZT}). Bitte über „Beleg manuell erfassen“ eintragen – oder Claude eine Beispielrechnung schicken.`);
}

export async function parseBelegPdf(file, fleetPlates, finMap) {
  const pdfjsLib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch {
    throw new Error("PDF konnte nicht geöffnet werden - ist die Datei beschädigt oder passwortgeschützt?");
  }
  const lines = await extractLayoutLines(pdf);
  return belegAusZeilen(lines, file.name, fleetPlates, finMap);
}
