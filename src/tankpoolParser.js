// ============================================================================
// Tankpool-Rechnungen: liest die PDF-Rechnungen von Tankpool direkt im Browser
// aus (wie der Gutschriften-Abgleich: PDF.js + geometrische Zeilen, KEIN
// KI/OCR - es geht um Geldbeträge).
//
// Zwei Layouts sind bekannt (an allen Rechnungen Jan-Okt 2026 geprüft):
//  1. Sammelrechnung (zweimal im Monat, Nr. "DE-152442"): je Tankkarte ein
//     Block "Karte 10308943 OF-RY 850", darin je Sorte (Diesel, Adblue, ...)
//     die einzelnen Tankvorgänge mit Datum, Zeit, Station, Menge, Preis, Wert.
//     Die Spalten km/Verbrauch/Pers-Nr. werden bewusst ignoriert - nur ein
//     manchmal an der Säule eingegebener KM-Stand (Zahl >= 1000) wird gemerkt.
//  2. Einzelrechnung (z. B. LKW-Wäsche, Nr. "354088"): Artikelzeile, darunter
//     Bezeichnung, Tankkarte und Datum/Station.
// Eigenkontrolle: Summe der Positionen muss der Netto-Gesamtsumme der
// Rechnung entsprechen, sonst wird nicht importiert.
// ============================================================================

import { loadPdfjs, extractLayoutLines } from "./gutschriftParser";
import { istShellBeleg, parseShellLines } from "./shellParser";

// Die Tankkarte des Miet-LKW steht auf der Rechnung nur als "Mietfahrzeug".
// Vorgabe: bis 26.07.2026 war das der frühere Miet-LKW KO-OF 213, ab
// 27.07.2026 (KW30) B-CY 3552.
const MIETFAHRZEUG_WECHSEL = "2026-07-27";
function mietfahrzeugLkw(isoDatum) {
  return isoDatum < MIETFAHRZEUG_WECHSEL ? "KO-OF 213" : "B-CY 3552";
}

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Kennzeichen von der Rechnung ("OF-RY 700") auf die Fuhrpark-Schreibweise
// ("OF RY 700") bringen.
export function ordneLkwZu(kennzeichenBeleg, isoDatum, fleetPlates) {
  const kz = String(kennzeichenBeleg || "").trim();
  if (/^mietfahrzeug/i.test(kz)) return mietfahrzeugLkw(isoDatum);
  const treffer = (fleetPlates || []).find((p) => norm(p) === norm(kz));
  return treffer || kz || null;
}

export function kategorieVonSorte(sorte) {
  if (/^diesel/i.test(sorte)) return "diesel";
  if (/ad\s*blue/i.test(sorte)) return "adblue";
  return "neben";
}

function zahl(s) {
  const n = parseFloat(String(s).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}
const r2 = (n) => Math.round(n * 100) / 100;

function isoDatum(s) {
  const m = String(s || "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (!m) return null;
  const jahr = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${jahr}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

// ------------------------------------------------------------ Sammelrechnung
const ROW_RE = /^(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})\s+(.*?)\s+(-?[\d.]*\d,\d{2})\s+(L|Stk\.?)\s+(-?[\d.]*\d,\d+)\s+(-?[\d.]*\d,\d{2})$/;

function parseSammel(lines) {
  let rechnungNr = null, rechnungDatum = null, summe = null;
  let karte = null, kennzeichen = null, sorte = null, mwst = null;
  const positionen = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    const kopf = t.match(/^DE-(\d+)\s+[\d-]+\s+(\d{2}\.\d{2}\.\d{4})/);
    if (kopf) { rechnungNr = rechnungNr || `DE-${kopf[1]}`; rechnungDatum = rechnungDatum || isoDatum(kopf[2]); continue; }
    const g = t.match(/^Gesamt\/Total\s+(-?[\d.]*\d,\d{2})/);
    if (g) { summe = zahl(g[1]); continue; }
    const k = t.match(/^Karte\s+(?:Nr\.:\s*)?(\d+)\s*(.*)$/);
    if (k) { karte = k[1]; kennzeichen = k[2].trim(); sorte = null; continue; }
    const s = t.match(/^Sorte\s+(.+?)\s{2,}([\d,]+)%\s*MwSt/);
    if (s) { sorte = s[1].trim(); mwst = zahl(s[2]); continue; }
    const m = t.match(ROW_RE);
    if (m && sorte) {
      const [, d, zeit, mitte, menge, einheit, preis, wert] = m;
      // Mittelteil: Station (Text) + optionale Zahlen (km, Verbrauch, Pers-Nr.)
      const stationTeile = [];
      let km = null;
      for (const tok of mitte.split(/\s+/)) {
        if (/^[\d.,]+$/.test(tok)) {
          if (/^\d+$/.test(tok) && Number(tok) >= 1000) km = Number(tok);
        } else stationTeile.push(tok);
      }
      positionen.push({
        karte, kennzeichen_beleg: kennzeichen, datum: isoDatum(d), zeit,
        station: stationTeile.join(" ").replace(/\s*\/$/, ""), sorte, kategorie: kategorieVonSorte(sorte),
        menge: zahl(menge), einheit: einheit.startsWith("Stk") ? "Stk" : "L",
        preis_netto: zahl(preis), wert_netto: zahl(wert), mwst_satz: mwst, km_beleg: km,
      });
    }
  }
  return { typ: "sammel", rechnungNr, rechnungDatum, dokumentSumme: summe, positionen };
}

// ------------------------------------------------------------- Einzelrechnung
const ARTIKEL_RE = /^\d{4,}\s+(\d+)\s+\d+\s+\d+\s+(-?[\d.]*\d,\d{2})\s+(\S+)\s+(-?[\d.]*\d,\d{2})\s+(-?[\d.]*\d,\d{2})$/;

function parseEinzel(lines) {
  let rechnungNr = null, rechnungDatum = null, summe = null, geliefert = null;
  const positionen = [];
  let cur = null, warteAufSorte = false;
  const tl = lines.map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < tl.length; i++) {
    const t = tl[i];
    const nr = t.match(/Bei Zahlung angeben:\s*[\d-]+\s+(\d+)/);
    if (nr) { rechnungNr = nr[1]; continue; }
    if (/^KUNDEN-NR/.test(t) && tl[i + 1]) {
      const dm = tl[i + 1].match(/(\d{2}\.\d{2}\.\d{2,4})\s*$/);
      if (dm) rechnungDatum = isoDatum(dm[1]);
      continue;
    }
    const gl = t.match(/^geliefert am:\s*(\d{2}\.\d{2}\.\d{2,4})/);
    if (gl) { geliefert = isoDatum(gl[1]); continue; }
    const ww = t.match(/^WARENWERT\s+EUR\s+(-?[\d.]*\d,\d{2})/);
    if (ww) { summe = zahl(ww[1]); continue; }
    const a = t.match(ARTIKEL_RE);
    if (a) {
      cur = {
        karte: null, kennzeichen_beleg: null, datum: geliefert, zeit: null, station: "",
        sorte: "", kategorie: "neben", menge: zahl(a[2]), einheit: a[3],
        preis_netto: zahl(a[4]), wert_netto: zahl(a[5]), mwst_satz: zahl(a[1]), km_beleg: null,
      };
      positionen.push(cur);
      warteAufSorte = true;
      continue;
    }
    if (!cur) continue;
    if (warteAufSorte) { cur.sorte = t; cur.kategorie = kategorieVonSorte(t); warteAufSorte = false; continue; }
    const k = t.match(/^Karte\s+(?:Nr\.:\s*)?(\d+)\s*(.*)$/);
    if (k) { cur.karte = k[1]; cur.kennzeichen_beleg = k[2].trim(); continue; }
    const d = t.match(/(\d{2}\.\d{2}\.\d{2,4})(?:\s+(\d{2}:\d{2}))?\s+(.+)$/);
    if (d && cur.karte && !cur.station) {
      cur.datum = isoDatum(d[1]) || cur.datum;
      cur.zeit = d[2] || null;
      cur.station = d[3].trim();
    }
  }
  positionen.forEach((p) => { if (!p.datum) p.datum = rechnungDatum; });
  return { typ: "einzel", rechnungNr, rechnungDatum, dokumentSumme: summe, positionen };
}

// Reine Text-Auswertung (auch für Tests ohne Browser nutzbar).
export function parseTankpoolLines(lines, fleetPlates) {
  const text = lines.join("\n");
  const res = /Gesamt\/Total/.test(text) || /^\s*DE-\d+\s/m.test(text)
    ? parseSammel(lines)
    : parseEinzel(lines);
  res.positionen.forEach((p) => { p.lkw = ordneLkwZu(p.kennzeichen_beleg, p.datum, fleetPlates); });
  res.parsedSumme = r2(res.positionen.reduce((s, p) => s + p.wert_netto, 0));
  res.summenAbweichung = res.dokumentSumme === null || Math.abs(res.dokumentSumme - res.parsedSumme) > 0.005;
  res.quelle = "tankpool";
  res.importSumme = res.parsedSumme;
  res.ueberspringen = null;
  return res;
}

// Gemeinsamer Einstieg für alle Tankkarten: erkennt am Inhalt, ob es ein
// Shell-(SVG/euroShell-) oder ein Tankpool-Beleg ist.
export async function parseTankbelegPdf(file, fleetPlates) {
  const pdfjsLib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch {
    throw new Error("PDF konnte nicht geöffnet werden - ist die Datei beschädigt oder passwortgeschützt?");
  }
  const lines = await extractLayoutLines(pdf);
  if (istShellBeleg(lines)) {
    const res = parseShellLines(lines, fleetPlates);
    if (!res.rechnungNr) throw new Error("Shell-Beleg ohne Rechnungsnummer - Layout unbekannt.");
    if (res.fehler) throw new Error(res.fehler);
    return { dateiname: file.name, ...res };
  }
  const res = parseTankpoolLines(lines, fleetPlates);
  if (!res.rechnungNr || res.positionen.length === 0) {
    throw new Error("Weder Tankpool- noch Shell-Rechnung erkannt (keine Rechnungsnummer oder keine Positionen gefunden).");
  }
  return { dateiname: file.name, ...res };
}

export async function parseTankpoolPdf(file, fleetPlates) {
  const pdfjsLib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch {
    throw new Error("PDF konnte nicht geöffnet werden - ist die Datei beschädigt oder passwortgeschützt?");
  }
  const lines = await extractLayoutLines(pdf);
  const res = parseTankpoolLines(lines, fleetPlates);
  if (!res.rechnungNr || res.positionen.length === 0) {
    throw new Error("Das sieht nicht nach einer Tankpool-Rechnung aus (keine Rechnungsnummer oder keine Positionen gefunden).");
  }
  return { dateiname: file.name, ...res };
}
