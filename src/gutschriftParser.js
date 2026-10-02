// ============================================================================
// Gutschriften-Abgleich: liest eine wöchentliche Gutschrift-PDF (z. B. von
// Contargo) direkt im Browser aus und zerlegt sie in einzelne Order-Positionen
// mit Betrag - OHNE KI/OCR. Bei Geldbeträgen ist das bewusst so gewählt: das
// PDF ist ein echter Text-Export (kein Scan), die Beträge lassen sich also
// deterministisch auslesen statt sie von einem Sprachmodell "erraten" zu
// lassen.
//
// Technik: PDF.js (pdfjs-dist) wird dynamisch per CDN-Import geladen (kein
// npm-Dependency nötig). Für jede Seite liefert PDF.js alle Textfragmente mit
// ihrer x/y-Position im Dokument (getTextContent). Diese werden rein
// geometrisch zu Zeilen zusammengesetzt (nach y gruppiert, innerhalb einer
// Zeile nach x sortiert) - NICHT anhand der Reihenfolge im PDF-Content-Stream
// (item.hasEOL), denn bei diesem Oracle-Reports-Export steht der Inhalt im
// Stream spaltenweise, nicht zeilenweise (per Browser-Test an einer echten
// Gutschrift verifiziert). Das Ergebnis entspricht in etwa "pdftotext
// -layout": Spalten bleiben durch mehrere Leerzeichen getrennt, was der
// anschließende Zeilen-Parser (Regex) braucht.
// ============================================================================

const PDFJS_VERSION = "6.3.289";
const PDFJS_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/+esm`;
const PDFJS_WORKER_URL = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let pdfjsLibPromise = null;
function loadPdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(/* @vite-ignore */ PDFJS_URL)
      .then((mod) => {
        mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
        return mod;
      })
      .catch((err) => {
        pdfjsLibPromise = null; // nächster Versuch darf es erneut probieren
        throw new Error("PDF-Bibliothek konnte nicht geladen werden (Internetverbindung prüfen).");
      });
  }
  return pdfjsLibPromise;
}

// Ordnet eine Kostenart-Zeile (freier Text aus der PDF) einer unserer
// COSTFIELDS-Spalten zu. Reihenfolge ist wichtig: spezifischere Muster
// (Maut/Wartezeit/Diesel/ADR/FD) MÜSSEN vor dem generischen "Trucking"-Muster
// geprüft werden. Reale, bereits gesehene Label-Varianten (u.a. mit
// angehängtem Freitext wie "Wartezeit Merck 1,5 std" oder "FD , Anlieferung
// durch ..."): per startsWith/Regex-Präfix erkannt, nicht per exaktem String.
const KOSTENART_RULES = [
  { feld: "maut", test: (l) => /^Trucking\s+Maut/i.test(l) },
  { feld: "wartezeit", test: (l) => /^Trucking\s+Wartezeit/i.test(l) || /^Wartezeit/i.test(l) },
  { feld: "diesel", test: (l) => /Dieselzuschlag/i.test(l) },
  { feld: "adr", test: (l) => /Gefahrgut/i.test(l) || /^ADR\b/i.test(l) },
  { feld: "multistop", test: (l) => /^Trucking\s+Multistop/i.test(l) },
  { feld: "fd", test: (l) => /^FD\b/i.test(l) },
  { feld: "fracht", test: (l) => /^Trucking\b/i.test(l) || /^Zusätzliches\s+Trucking/i.test(l) },
];
export function kategorisiereKostenart(label) {
  for (const r of KOSTENART_RULES) {
    if (r.test(label)) return r.feld;
  }
  return null; // "Sonstige" - fließt trotzdem in die Summe ein, erscheint im UI nur unkategorisiert
}

function parseAmount(s) {
  const n = parseFloat(String(s).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

// Wandelt "22.09.2026" in ISO "2026-09-22" um (für Supabase date-Spalten).
function parseGermanDate(s) {
  const m = String(s || "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Geometrische Zeilen-Rekonstruktion einer PDF-Seite: Textfragmente nach
// y-Position gruppieren (eine Gruppe = eine visuelle Zeile, Toleranz 2pt für
// minimale Rundungsunterschiede), innerhalb der Gruppe nach x sortieren, und
// mit einer zur Lücke proportionalen Anzahl Leerzeichen wieder zusammenfügen
// - das reproduziert grob das Verhalten von "pdftotext -layout", das wir an
// der echten Gutschrift als zuverlässig geprüft haben.
async function extractLayoutLines(pdf) {
  const lines = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => it.str !== undefined && it.str.trim() !== "")
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width,
        fs: Math.abs(it.transform[0]) || 6,
      }));

    // Items zuerst von oben nach unten (hoher y-Wert zuerst) sortieren, bevor
    // die Zeilen-Zuordnung läuft: ohne diese Vorsortierung hängt das Ergebnis
    // von der (beliebigen) Reihenfolge im PDF-Content-Stream ab - bei dieser
    // Gutschrift lagen z. B. "Beleg-Nr.:" (y≈689.8) und der danebenstehende
    // Wert (y≈689.6, Differenz 0.2) knapp 2pt auseinander von einer ganz
    // anderen, linksspaltigen Adresszeile (y≈687.7) - wurde der Wert VOR dem
    // Label verarbeitet, griff er fälschlich nach der naheliegenden
    // Adresszeile statt nach "Beleg-Nr.:". Mit Top-nach-unten-Verarbeitung UND
    // "nächstgelegene statt erste passende Zeile" (s.u.) ist das Ergebnis
    // unabhängig von der Stream-Reihenfolge (an genau diesem Fall getestet).
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    const rows = [];
    const Y_TOL = 2.0;
    for (const it of items) {
      let row = null;
      let bestDiff = Infinity;
      for (const r of rows) {
        const diff = Math.abs(r.y - it.y);
        if (diff <= Y_TOL && diff < bestDiff) { row = r; bestDiff = diff; }
      }
      if (!row) {
        row = { y: it.y, items: [] };
        rows.push(row);
      }
      row.items.push(it);
    }
    rows.sort((a, b) => b.y - a.y); // oben zuerst (PDF: hoher y-Wert = oben)

    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      const parts = [];
      let last = null;
      for (const it of row.items) {
        if (last) {
          const gap = it.x - (last.x + last.w);
          const spaceWidth = Math.max(it.fs, 4) * 0.28;
          const n = gap > spaceWidth * 1.3 ? Math.max(1, Math.round(gap / spaceWidth)) : (gap > spaceWidth * 0.3 ? 1 : 0);
          if (n > 0) parts.push(" ".repeat(n));
        }
        parts.push(it.str);
        last = it;
      }
      lines.push(parts.join(""));
    }
  }
  return lines;
}

// Zeilen, die nie eine Order-/Kostenzeile sind (Seitenkopf/-fuß, Summenblock),
// damit sie nicht versehentlich in eine offene Order-Position rutschen.
const SKIP_SUBSTRINGS = [
  "Übertrag", "Seite:", "Rg.-Datum", "Kunden-Nr", "Ihre USt-Nr", "BTW-Nr",
  "Unsere Order-Nr", "Gestellungsdatum", "Bankverbindung", "Wir arbeiten",
  "Auf die in den AGB", "Ausgangssteuer",
];

const ORDER_RE = /^(\d{5,9})\s*\/\s*(\d+)\s+(.*?)\s{2,}(\d+)\s+(\S+)\s+(\S*")\s*$/;
const COST_RE = /^(.*?)\s{2,}EUR\s+([\d.,]+)\s*$/;

// Parst die rekonstruierten Zeilen in Order-Blöcke. Gibt zusätzlich
// belegNr, rgDatum und die vom Dokument selbst ausgewiesene Endsumme
// (Netto) zurück, damit der Aufrufer eine Eigenkontrolle machen kann
// (Summe aller erkannten Positionen muss der Endsumme entsprechen - tut
// sie das nicht, deutet das auf einen Parser-Fehler oder ein unbekanntes
// Layout hin, und es sollte NICHT automatisch weiterverarbeitet werden).
function parseLines(lines) {
  let belegNr = null;
  let rgDatum = null;
  let dokumentSumme = null;
  const positionen = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (line.includes("Beleg-Nr.:")) {
      const m = line.match(/Beleg-Nr\.:\s*(\d+)/);
      if (m) belegNr = m[1];
      continue;
    }
    if (trimmed.startsWith("Endsumme (Netto)")) {
      const m = line.match(/EUR\s+([\d.,]+)/);
      if (m) dokumentSumme = parseAmount(m[1]);
      continue;
    }
    if (trimmed.startsWith("Endsumme (Brutto)") || trimmed.startsWith("a)")) continue;
    if (SKIP_SUBSTRINGS.some((mk) => line.includes(mk))) continue;

    const om = line.match(ORDER_RE);
    if (om) {
      if (current) positionen.push(current);
      current = {
        orderNr: `${om[1]}/${om[2]}`,
        kunde: om[3].replace(/\s+/g, " ").trim(),
        betrag: 0,
        zeilen: [],
      };
      continue;
    }

    const cm = line.match(COST_RE);
    if (cm && current) {
      const label = cm[1].replace(/\s+/g, " ").trim();
      const betrag = parseAmount(cm[2]);
      current.zeilen.push({ label, betrag, feld: kategorisiereKostenart(label) });
      current.betrag = Math.round((current.betrag + betrag) * 100) / 100;
    }
  }
  if (current) positionen.push(current);

  // Rg.-Datum separat suchen (Format TT.MM.JJJJ, steht im Kopf neben
  // "Rg.-Datum:" - je nach Zeilenzusammenfassung in derselben oder der
  // Beleg-Nr.-Zeile).
  for (const raw of lines) {
    const m = raw.match(/Rg\.-Datum:\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
    if (m) { rgDatum = parseGermanDate(m[1]); break; }
  }
  if (!rgDatum) {
    // Fallback: direkt unter der Beleg-Nr. steht oft nur das Datum ohne
    // Label (zweite Zeile desselben Kopf-Blocks).
    const idx = lines.findIndex((l) => l.includes("Beleg-Nr.:"));
    if (idx >= 0) {
      for (let i = idx; i < Math.min(idx + 3, lines.length); i++) {
        const m = lines[i].match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
        if (m) { rgDatum = parseGermanDate(m[1]); break; }
      }
    }
  }

  const parsedSumme = Math.round(positionen.reduce((s, p) => s + p.betrag, 0) * 100) / 100;

  return { belegNr, rgDatum, dokumentSumme, parsedSumme, positionen };
}

// Haupteinstieg: nimmt ein File-Objekt (aus <input type="file">) und liefert
// das vollständige Abgleichs-Rohergebnis. Wirft bei strukturellen Problemen
// eine Error mit verständlicher deutscher Meldung.
export async function parseGutschriftPdf(file) {
  const pdfjsLib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch (err) {
    throw new Error("PDF konnte nicht geöffnet werden - ist die Datei beschädigt oder passwortgeschützt?");
  }

  const lines = await extractLayoutLines(pdf);
  const result = parseLines(lines);

  if (result.positionen.length === 0) {
    throw new Error(
      "Es konnten keine Order-Positionen aus dem PDF gelesen werden. Das Layout weicht vermutlich " +
      "von den bisher bekannten Gutschriften ab - bitte die Datei zur Prüfung schicken."
    );
  }

  const summenAbweichung =
    result.dokumentSumme !== null &&
    Math.abs(result.dokumentSumme - result.parsedSumme) > 0.01;

  return {
    dateiname: file.name,
    belegNr: result.belegNr,
    rgDatum: result.rgDatum,
    dokumentSumme: result.dokumentSumme,
    parsedSumme: result.parsedSumme,
    summenAbweichung,
    positionen: result.positionen,
  };
}
