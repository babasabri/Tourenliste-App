// ============================================================================
// Shell-Tankkarte (SVG / euroShell): liest die PDF-Belege der SVG direkt im
// Browser aus (gleiche Zeilen-Rekonstruktion wie Tankpool/Gutschriften, ohne KI).
//
// Belegarten (an allen Belegen Jan-Okt 2026 geprüft):
//  - Rechnung "2026 01 …"  Tankungen/Wäschen in Deutschland      -> importieren
//  - Rechnung "2026 29 …"  Service-Gebühren (z. B. Truckwash)     -> importieren
//  - "Abrechnung / Zusammenstellung" (Dateiname …_0)               -> keine Positionen
//  - Auslandsrechnungen (AT/HR/RS, andere Spalten)                 -> nur relevant,
//    wenn darin ein LKW aus dem Fuhrpark vorkommt (bisher nie)
// Je Karte steht ein Kennzeichen. Übernommen werden NUR Karten, deren
// Kennzeichen im Fuhrpark steht (Vorgabe) - Ersatzkarten, PKW usw. werden
// ignoriert. Shell-Belege haben keine Uhrzeit und es wird bewusst kein
// KM-Stand aus routecontrol geholt.
// Eigenkontrolle: Summe ALLER Positionen (inkl. ignorierter Karten und
// kartenloser Gebühren) muss dem Netto-Gesamtbetrag entsprechen.
// ============================================================================

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const zahl = (s) => {
  const n = parseFloat(String(s).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round(n * 100) / 100;
function isoDatum(s) {
  const m = String(s || "").match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (!m) return null;
  return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

const NUM = String.raw`-?[\d.]*\d,\d+`;
// Datum Trans Stationscode Station+Produkt km Menge [L] Preis-netto Preis-brutto … Netto USt-Satz USt Brutto
const ROW_RE = new RegExp(
  String.raw`^(\d{2}\.\d{2}\.\d{2})\s+(\d+)\s+(\S{4})\s+(.+?)\s+(-?\d+)\s+(${NUM})(\s+L)?\s+(${NUM})\s+(${NUM})\s+.*?(${NUM})\s+(\d{1,2},\d)\s+(${NUM})\s+(${NUM})$`
);
// Zeile ohne Karte/Station, z. B. "30.06.26  Systembeitrag Auslandstransaktionen 139,97 € 2,50 % 2,94 19,0 0,56 3,50"
const GEBUEHR_RE = new RegExp(String.raw`^(\d{2}\.\d{2}\.\d{2})\s+(\D.*?)\s+.*?(${NUM})\s+(\d{1,2},\d)\s+(${NUM})\s+(${NUM})$`);

// Produktbezeichnung am Ende von "Station Produkt" abtrennen (Station ist auf
// max. 15 Zeichen gekürzt und steht ohne festen Trenner davor).
const PRODUKT_RE = /\s((?:V-Power\s)?Diesel(?:\sAGO)?|AdBlue(?:\sGebinde)?|Manual\sCarwash|Service-Gebühren|Frostschutzmittel|Autowäsche|\S*\s?Super\S*)$/i;
function stationUndProdukt(s) {
  const t = s.replace(/\s+/g, " ").trim();
  const m = t.match(PRODUKT_RE);
  if (m) return { station: t.slice(0, m.index).trim(), produkt: m[1] };
  return { station: t.slice(0, 15).trim(), produkt: t.slice(15).trim() || t };
}

function kategorie(produkt, liter) {
  if (/diesel/i.test(produkt) && liter) return "diesel";
  if (/ad\s*blue/i.test(produkt) && liter) return "adblue";
  return "neben";
}

export function istShellBeleg(lines) {
  return lines.some((l) => /euroShell|SVG-Kunden-Nr|SVG \/ euroShell/i.test(l));
}

// Die SVG-PDFs nutzen eine verschobene Zeichentabelle: PDF.js liefert für
// Umlaute andere Zeichen (z. B. "Geb¸hren", "SCHL‹CHTERN"). Rückübersetzung,
// an allen Belegen 2026 geprüft. Bei korrekt gelieferten Zeichen ändert sich nichts.
const ZEICHEN = { "¸": "ü", "‰": "ä", "ˆ": "ö", "‹": "Ü", "ƒ": "Ä", "÷": "Ö" };
const zeichenFix = (s) => s.replace(/[¸‰ˆ‹ƒ÷]/g, (c) => ZEICHEN[c]);

export function parseShellLines(rohLines, fleetPlates) {
  const lines = rohLines.map(zeichenFix);
  const plates = new Map((fleetPlates || []).map((p) => [norm(p), p]));
  const text = lines.join("\n");
  const res = {
    quelle: "shell", typ: "sammel", rechnungNr: null, rechnungDatum: null,
    dokumentSumme: null, parsedSumme: 0, positionen: [], ignoriert: { anzahl: 0, summe: 0, kennzeichen: [] },
    ueberspringen: null, fehler: null,
  };

  if (/Abrechnung\s*\/\s*Zusammenstellung/i.test(text)) {
    const nr = text.match(/Beleg-Nr\.:\s*(\d+)/);
    res.typ = "zusammenstellung";
    res.rechnungNr = nr ? `SVG-${nr[1]}` : null;
    res.ueberspringen = "Lastschrift-Zusammenstellung ohne Positionen";
    return res;
  }

  const nr = text.match(/Rechnungs-Nr\.:\s*(\d+)/);
  const dat = text.match(/Datum:\s*(\d{2}\.\d{2}\.\d{4})/);
  res.rechnungNr = nr ? `SVG-${nr[1]}` : null;
  res.rechnungDatum = dat ? isoDatum(dat[1]) : null;
  if (nr && /^\d{4}29/.test(nr[1])) res.typ = "gebuehren";

  let karte = null, kz = null, lkw = null;
  let summeAlle = 0;
  const unbekannteZeilen = [];
  for (const raw of lines) {
    const t = raw.replace(/\s+$/, "").trim();
    if (!t) continue;
    const k = t.match(/^Karte:\s*(\d+)\s+Kennzeichen:\s*(.+?)(?:\s{2,}|\s+ROYAL|$)/i);
    if (k) {
      karte = k[1]; kz = k[2].trim(); lkw = plates.get(norm(kz)) || null;
      continue;
    }
    if (/^Kartentotal/i.test(t)) { karte = kz = lkw = null; continue; }
    const g = t.match(/^Gesamtbetrag Kunde:\s*(.*)$/i);
    if (g) {
      const zahlen = g[1].match(new RegExp(NUM, "g")) || [];
      if (zahlen.length >= 3) res.dokumentSumme = zahl(zahlen[zahlen.length - 3]);
      continue;
    }
    if (!/^\d{2}\.\d{2}\.\d{2}\s/.test(t)) continue;

    const m = t.match(ROW_RE);
    if (m) {
      const [, d, , , statProd, , menge, istL, preisNetto, , netto, ust] = m;
      const wert = zahl(netto);
      summeAlle += wert;
      if (!lkw) {
        res.ignoriert.anzahl++; res.ignoriert.summe += wert;
        if (kz && !res.ignoriert.kennzeichen.includes(kz)) res.ignoriert.kennzeichen.push(kz);
        continue;
      }
      const { station, produkt } = stationUndProdukt(statProd);
      const liter = !!istL;
      const mg = zahl(menge);
      res.positionen.push({
        karte, kennzeichen_beleg: kz, lkw, datum: isoDatum(d), zeit: null, station,
        sorte: produkt, kategorie: kategorie(produkt, liter),
        menge: liter ? mg : (/Service-Gebühren/i.test(produkt) ? 1 : mg),
        einheit: liter ? "L" : "Stk",
        preis_netto: liter && mg ? Math.round((wert / mg) * 10000) / 10000 : wert,
        wert_netto: wert, mwst_satz: zahl(ust), km_beleg: null,
      });
      continue;
    }
    const gb = t.match(GEBUEHR_RE);
    if (gb && !karte) {
      // Gebühr ohne Karte (gehört keinem LKW) - zählt nur zur Summenkontrolle
      const wert = zahl(gb[3]);
      summeAlle += wert;
      res.ignoriert.anzahl++; res.ignoriert.summe += wert;
      continue;
    }
    if (lkw) unbekannteZeilen.push(t);
    else res.ignoriert.anzahl++;
  }

  res.parsedSumme = r2(summeAlle);
  res.ignoriert.summe = r2(res.ignoriert.summe);
  res.importSumme = r2(res.positionen.reduce((s, p) => s + p.wert_netto, 0));
  if (unbekannteZeilen.length) {
    res.fehler = `${unbekannteZeilen.length} LKW-Zeile(n) nicht lesbar (unbekanntes Layout): ${unbekannteZeilen[0].slice(0, 80)}`;
  }
  if (res.positionen.length === 0 && !res.fehler) res.ueberspringen = "keine Positionen von LKW aus dem Fuhrpark";
  res.summenAbweichung = !res.ueberspringen && (res.dokumentSumme === null || Math.abs(res.dokumentSumme - res.parsedSumme) > 0.005);
  return res;
}
