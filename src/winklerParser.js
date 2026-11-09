// ============================================================================
// Ersatzteile: liest Rechnungen und Gutschriften von Winkler Fahrzeugteile
// direkt im Browser aus (wie Gutschriften/Tankpool: PDF.js + geometrische
// Zeilen, KEIN KI/OCR - es geht um Geldbeträge).
//
// Aufbau eines Winkler-Belegs (an allen 34 Belegen Jan-Okt 2026 geprüft):
//   Kopf:  "Rechnungs-Nr.: 33778619" / "Gutschrifts-Nr.: 66112860", Datum
//   je Lieferschein: "Lieferschein 8049514783 , Lieferdatum 20.08.2026",
//                    "Bestell-Daten: OF RY 500" (was bei der Bestellung
//                    angegeben wurde - meist das Kennzeichen, mal die FIN,
//                    mal "Lager", mal nichts), optional
//                    "KFZ-Kennz.: ... Fahrgestell-Nr. XLRTEH4300G135039"
//   je Position:     "10  1 ST  327 929 087 01  85,00  1", darunter die
//                    Bezeichnung, Zusatzzeilen, "Positionsnetto ... 85,00",
//                    optional "Altteilpfand ... 400,00" und bei Gutschriften
//                    "GS zu Rechnungs-Nr.: 32741903 10, 13.02.2026"
//   Ende:  "Summe Positionen 585,80", "Endbetrag EUR 697,10"
// Ein Beleg kann mehrere Lieferscheine für verschiedene LKW enthalten - das
// Fahrzeug gehört deshalb zur Position, nicht zum Beleg.
// Eigenkontrolle: Summe aller Positionen (Netto + Pfand) muss "Summe
// Positionen" entsprechen, sonst wird nicht importiert.
// Gutschriften werden mit negativen Beträgen gespeichert (Summen stimmen so
// direkt).
// ============================================================================

import { loadPdfjs, extractLayoutLines } from "./gutschriftParser";

export const LIEFERANT_WINKLER = "Winkler";
export const KATEGORIEN = ["Ersatzteil", "Ausrüstung", "Werkstattbedarf", "Betriebsstoff"];

function zahl(s) {
  const n = parseFloat(String(s).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
const r2 = (n) => Math.round(n * 100) / 100;
function isoDatum(s) {
  const m = String(s || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const letzteZahl = (t) => {
  const m = t.match(/(-?[\d.]*\d,\d{2})\s*$/);
  return m ? zahl(m[1]) : 0;
};

// Vorschlag für die Kategorie aus der Bezeichnung (lässt sich in der App ändern).
export function kategorieVorschlag(bez) {
  const b = String(bez || "").toLowerCase();
  if (/notfallkoffer|feuerlöscher|prüfaufkleber|gerätebatterie|handschuh|warnweste|warndreieck|warnleuchte|unterlegkeil/.test(b)) return "Ausrüstung";
  if (/^fett\b|polbürste|messersatz|reiniger|bremsenreiniger|kabelbinder|klebeband|lappen|putztuch/.test(b)) return "Werkstattbedarf";
  if (/kühlerschutz|frostschutz|motoröl|öl,|getriebeöl|adblue,|scheibenreiniger|scheibenwasch/.test(b)) return "Betriebsstoff";
  return "Ersatzteil";
}

// Kennzeichen aus den Bestell-Daten / der Fahrgestellnummer bestimmen.
// fleetPlates: Fuhrpark-Schreibweise ("OF RY 500"), finMap: { FIN: Kennzeichen }.
// Toleriert Bindestriche/Leerzeichen und genau einen Tippfehler im
// Buchstabenteil (z. B. "OF-LY 500" -> OF RY 500), wenn das eindeutig ist.
export function ordneFahrzeugZu(bestelldaten, fin, fleetPlates, finMap) {
  const bd = String(bestelldaten || "").trim();
  const plates = fleetPlates || [];
  const fm = {};
  for (const [k, v] of Object.entries(finMap || {})) fm[norm(k)] = v;

  if (fin && fm[norm(fin)]) {
    // FIN ist eindeutiger als ein getipptes Kennzeichen
    const viaFin = fm[norm(fin)];
    return { lkw: viaFin, quelle: "fin", hinweis: "" };
  }
  if (!bd) return { lkw: null, quelle: null, hinweis: "Kein Fahrzeug auf dem Beleg" };
  if (/^lager$/i.test(bd)) return { lkw: null, quelle: null, hinweis: 'Bestellt als "Lager"' };
  if (fm[norm(bd)]) return { lkw: fm[norm(bd)], quelle: "fin", hinweis: "über Fahrgestellnr. zugeordnet" };

  const nb = norm(bd);
  const exakt = plates.find((p) => nb === norm(p) || nb.endsWith(norm(p)) || nb.includes(norm(p)));
  if (exakt) return { lkw: exakt, quelle: "beleg", hinweis: "" };

  // ein Zeichen Abweichung (gleiche Länge), nur bei eindeutigem Treffer
  const kandidaten = plates.filter((p) => {
    const a = norm(p);
    if (a.length !== nb.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== nb[i]) diff++;
    return diff === 1;
  });
  if (kandidaten.length === 1) return { lkw: kandidaten[0], quelle: "beleg", hinweis: `Bestellt als "${bd}" (Tippfehler korrigiert)` };
  return { lkw: null, quelle: null, hinweis: `Bestell-Daten "${bd}" keinem Fahrzeug zuzuordnen` };
}

const NOISE = [
  /^winkler\b/i, /^Unternehmensgruppe/, /^64546 /, /^Royal Logistik GmbH/, /^Alfred-Nobel/, /^Kunden-Nr/, /^63128 /,
  /^DEUTSCHLAND/, /^(Rechnungs|Gutschrifts)-Datum/, /^_{5,}/, /^Pos\. Menge/, /^Artikelbezeichnung/, /^Verkäufer/,
  /^Auftrags-Nr/, /^Warenempfänger/, /^Lieferanten-Nr/, /^Ihre ID/, /^Unsere ID/, /^Für Rückfragen/, /^Für den Vorgang/,
  /^Angegebene Hersteller/, /^Christian Winkler/, /^(Rechnung|Gutschrift)$/, /Blatt \d+ von/,
  /^Diese Position ist ein Tauschteil/, /^Berechnete Pfandwerte/, /^Altteils auf Wiederverw/, /^Tauschteil-Rückgabe/,
  /^Achtung vor Auspacken/, /^eingebauten Teil/, /^Einbauinformationen/, /^gründlich reinigen/,
  /^Rabatt\b/, /^Staffel-Rabatt/, /^Kulanzgutschrift/,
];
const POS_RE = /^(\d{1,3})\s+(\d+(?:,\d+)?)\s*([A-ZÄÖÜ]{1,4})\s*(\d{3} \d{3} \d{3} \d{2})(?:\s|$)/;

export function parseWinklerLines(lines) {
  let belegNr = null, belegart = null, belegDatum = null, summe = null, brutto = null;
  let ls = null, lsDatum = null, bestell = "", fin = "";
  const positionen = [];
  let cur = null;
  let istGutschriftsKulanz = false;

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let m;
    if (!belegNr && (m = t.match(/(Rechnungs|Gutschrifts)-Nr\.:\s*(\d+)/))) {
      belegNr = m[2];
      belegart = m[1] === "Gutschrifts" ? "gutschrift" : "rechnung";
      continue;
    }
    if (!belegDatum && (m = t.match(/^(?:Rechnungs|Gutschrifts)-Datum:\s*(\d{2}\.\d{2}\.\d{4})/))) { belegDatum = isoDatum(m[1]); continue; }
    if ((m = t.match(/^Summe Positionen\s+(-?[\d.]*\d,\d{2})/))) { summe = zahl(m[1]); cur = null; continue; }
    if ((m = t.match(/^Endbetrag EUR\s+(-?[\d.]*\d,\d{2})/))) { brutto = zahl(m[1]); continue; }
    if ((m = t.match(/^Lieferschein\s+(\d+)\s*,\s*Lieferdatum\s+(\d{2}\.\d{2}\.\d{4})/))) {
      ls = m[1]; lsDatum = isoDatum(m[2]); bestell = ""; fin = ""; cur = null; continue;
    }
    if ((m = t.match(/^Bestell-Daten:\s*(.*)$/))) { bestell = m[1].trim(); continue; }
    if ((m = t.match(/Fahrgestell-Nr\.\s*([A-Z0-9]{11,17})/i))) { fin = m[1].toUpperCase(); continue; }
    if (/^KFZ-Kennz/.test(t)) continue;

    if ((m = t.match(POS_RE))) {
      cur = {
        pos: parseInt(m[1], 10), menge: zahl(m[2]), einheit: m[3], artikel_nr: m[4],
        lieferschein: ls, lieferdatum: lsDatum, bestelldaten: bestell, fin,
        bezeichnung: "", zusatz: [], netto: 0, pfand: 0, bezug_beleg_nr: null, bezug_pos: null, kulanz: false,
      };
      positionen.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^Positionsnetto/.test(t)) { cur.netto = letzteZahl(t); continue; }
    if (/^Altteilpfand/.test(t)) { cur.pfand = letzteZahl(t); continue; }
    if ((m = t.match(/GS zu Rechnungs-Nr\.:\s*(\d+)\s+(\d+)/))) { cur.bezug_beleg_nr = m[1]; cur.bezug_pos = parseInt(m[2], 10); continue; }
    if (/Kulanz/i.test(t) || /Ihre Artikelnummer KULANZ/i.test(t)) { cur.kulanz = true; continue; }
    if (NOISE.some((re) => re.test(t))) continue;
    if (!cur.bezeichnung) cur.bezeichnung = t.replace(/\s{2,}/g, " ");
    else cur.zusatz.push(t.replace(/\s{2,}/g, " "));
  }
  return { belegNr, belegart, belegDatum, summe, brutto, positionen };
}

export function aufbereiten(res, fleetPlates, finMap) {
  const vz = res.belegart === "gutschrift" ? -1 : 1;
  const positionen = res.positionen.map((p) => {
    const z = ordneFahrzeugZu(p.bestelldaten, p.fin, fleetPlates, finMap);
    let grund = null;
    if (res.belegart === "gutschrift") {
      if (p.pfand && !p.netto) grund = "Altteilpfand zurück";
      else if (p.kulanz) grund = "Kulanz";
      else grund = "Rückgabe/Reklamation";
    }
    return {
      pos: p.pos, teil: 1, lieferschein: p.lieferschein, lieferdatum: p.lieferdatum, bestelldaten: p.bestelldaten, fin: p.fin,
      lkw: z.lkw, lkw_quelle: z.quelle, kategorie: kategorieVorschlag(p.bezeichnung), artikel_nr: p.artikel_nr,
      bezeichnung: p.bezeichnung || "(ohne Bezeichnung)", zusatz: p.zusatz.join("; ") || null, menge: p.menge, einheit: p.einheit,
      netto: r2(vz * p.netto), pfand: r2(vz * p.pfand), bezug_beleg_nr: p.bezug_beleg_nr, bezug_pos: p.bezug_pos,
      gutschrift_grund: grund, hinweis: z.hinweis || null,
    };
  });
  const parsedSumme = r2(res.positionen.reduce((s, p) => s + p.netto + p.pfand, 0));
  return {
    lieferant: LIEFERANT_WINKLER,
    belegNr: res.belegNr,
    belegart: res.belegart,
    belegDatum: res.belegDatum,
    dokumentSumme: res.summe,
    parsedSumme,
    summenAbweichung: res.summe === null || Math.abs(parsedSumme - res.summe) > 0.005,
    netto: r2(vz * (res.summe ?? parsedSumme)),
    brutto: res.brutto === null ? null : r2(vz * res.brutto),
    positionen,
  };
}

export async function parseWinklerPdf(file, fleetPlates, finMap) {
  const pdfjsLib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch {
    throw new Error("PDF konnte nicht geöffnet werden - ist die Datei beschädigt oder passwortgeschützt?");
  }
  const lines = await extractLayoutLines(pdf);
  if (!lines.some((l) => /Winkler/i.test(l))) throw new Error("Kein Winkler-Beleg erkannt (bisher werden nur Winkler-Rechnungen/-Gutschriften unterstützt).");
  const res = parseWinklerLines(lines);
  if (!res.belegNr || res.positionen.length === 0) throw new Error("Winkler-Beleg ohne Belegnummer oder ohne Positionen - Layout unbekannt.");
  return { dateiname: file.name, ...aufbereiten(res, fleetPlates, finMap) };
}
