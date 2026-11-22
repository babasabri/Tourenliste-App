// Liest die PDFs von nordwest Factoring direkt im Browser (echter Text, kein
// Scan - wie die Contargo-Gutschriften, ohne KI/OCR):
//  - wöchentliche "Factoringabrechnung / Rechnung: <Nr>" (Seite 1 Zusammenfassung,
//    danach Rechnungsjournal mit den angekauften Rechnungen/Gutschriften)
//  - monatliche "Zinsabrechnung per <Datum>"
// Beide Parser arbeiten auf Layout-Zeilen (wie "pdftotext -layout") und prüfen
// sich selbst gegen die Summen im Beleg.
import { loadPdfjs } from "./gutschriftParser";

// Wie extractLayoutLines im Gutschriften-Parser, aber drehungssicher: die
// Anlagen (Rechnungs-/Buchungsjournal) sind Querformat-Seiten mit gedrehtem
// Text. Koordinaten werden deshalb erst über die Viewport-Matrix in
// Bildschirm-Koordinaten umgerechnet (oben links = 0/0), dann nach Zeilen
// gruppiert.
export async function extractLinesRotiert(pdf, pdfjs) {
  const lines = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((it) => it.str && it.str.trim()).map((it) => {
      const m = pdfjs.Util.transform(vp.transform, it.transform);
      const fs = Math.hypot(m[2], m[3]) || 6;
      return { str: it.str, x: m[4], y: m[5], w: it.width, fs };
    });
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const it of items) {
      let row = null, best = Infinity;
      for (const r of rows) { const d = Math.abs(r.y - it.y); if (d <= 2 && d < best) { row = r; best = d; } }
      if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
      row.items.push(it);
    }
    rows.sort((a, b) => a.y - b.y);
    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      let out = "", last = null;
      for (const it of row.items) {
        if (last) {
          const gap = it.x - (last.x + last.w);
          const sw = Math.max(it.fs, 4) * 0.28;
          const k = gap > sw * 1.3 ? Math.max(2, Math.round(gap / sw)) : gap > sw * 0.3 ? 1 : 0;
          out += " ".repeat(k);
        }
        out += it.str;
        last = it;
      }
      lines.push(out);
    }
  }
  return lines;
}

const BETRAG = "-?\\d{1,3}(?:\\.\\d{3})*,\\d{2}";
const num = (s) => {
  const n = parseFloat(String(s).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};
const isoDe = (s) => {
  const m = String(s || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
};
const r2 = (n) => Math.round(n * 100) / 100;

export function erkenneTyp(lines) {
  const t = lines.join("\n");
  if (/Factoringabrechnung\s*\/\s*Rechnung/i.test(t)) return "abrechnung";
  if (/Zinsabrechnung\s+per/i.test(t)) return "zinsen";
  return null;
}

// ------------------------------------------------------------ Abrechnung
export function parseAbrechnung(lines) {
  const t = lines.join("\n");
  const nr = (t.match(/Factoringabrechnung\s*\/\s*Rechnung:\s*(\d+)/i) || [])[1];
  const datum = isoDe((t.match(/Datum:\s*(\d{1,2}\.\d{1,2}\.\d{4})/) || [])[1]);
  const mandant = (t.match(/Mandant:?\s*(\d+)/) || [])[1] || "";
  if (!nr || !datum) throw new Error("Abrechnungs-Nr. oder Datum nicht gefunden");

  // Zusammenfassung: "<Text>   [Datum]   S|H   1.234,56 €"
  const zeilen = [];
  let uebertrag = 0, endsaldo = null, auszahlungsbetrag = null;
  const reZeile = new RegExp(`^\\s*(\\S.*?)\\s{2,}([SH])\\s+(${BETRAG})\\s*€`);
  const reUeb = new RegExp(`^\\s*Übertrag:?\\s+(?:\\d{1,2}\\.\\d{1,2}\\.\\d{4})?\\s+(${BETRAG})\\s*€`);
  for (const l of lines) {
    if (/Rechnungsjournal/i.test(l)) break; // ab hier Anlage
    let m;
    if ((m = l.match(reUeb))) { uebertrag = num(m[1]); continue; }
    if ((m = l.match(new RegExp(`Endsaldo[^:]*:\\s+(${BETRAG})\\s*€`)))) { endsaldo = num(m[1]); continue; }
    if ((m = l.match(new RegExp(`^\\s*Auszahlungsbetrag:\\s+(${BETRAG})\\s*€`)))) { auszahlungsbetrag = num(m[1]); continue; }
    if ((m = l.match(reZeile))) zeilen.push({ text: m[1].trim(), sh: m[2], betrag: num(m[3]) });
  }
  if (!zeilen.length) throw new Error("Keine Buchungszeilen in der Abrechnung erkannt");

  const summe = (f, sh) => r2(zeilen.filter((z) => f(z.text) && (!sh || z.sh === sh)).reduce((s, z) => s + z.betrag, 0));
  const eingereicht = summe((x) => /eingereichte Rechnungen|Ankauf/i.test(x), "H");
  const nichtAngekauft = summe((x) => /Nicht angekaufte/i.test(x), "S") - summe((x) => /Nicht angekaufte/i.test(x), "H");
  const sperrEinbehalt = summe((x) => /^Sperrkonto/i.test(x), "S");
  const sperrFreigabe = summe((x) => /^Sperrkonto/i.test(x), "H");
  const gebuehrenZeilen = summe((x) => /geb(ü|ue)hr/i.test(x), "S") - summe((x) => /geb(ü|ue)hr/i.test(x), "H");
  const ust = summe((x) => /Umsatzsteuer|Mehrwertsteuer/i.test(x), "S") - summe((x) => /Umsatzsteuer|Mehrwertsteuer/i.test(x), "H");
  const auszahlung = summe((x) => /^Auszahlung/i.test(x), "S");

  // Rechnung über die Gebühren (netto) - maßgeblich, Zeilen nur zur Kontrolle
  const gNetto = t.match(new RegExp(`Geb(?:ü|ue)hren gesamt netto:\\s+(${BETRAG})\\s*€`));
  const gebuehrenNetto = gNetto ? num(gNetto[1]) : r2(gebuehrenZeilen);

  // Eigenkontrolle: Übertrag + Haben - Soll = Endsaldo
  const saldo = r2(uebertrag + zeilen.reduce((s, z) => s + (z.sh === "H" ? z.betrag : -z.betrag), 0));
  const warnungen = [];
  if (endsaldo !== null && Math.abs(saldo - endsaldo) > 0.01) warnungen.push(`Summenprüfung: errechneter Endsaldo ${saldo.toFixed(2)} € ≠ Beleg ${endsaldo.toFixed(2)} €`);
  if (gNetto && Math.abs(gebuehrenZeilen - gebuehrenNetto) > 0.01) warnungen.push(`Gebühren laut Zeilen ${gebuehrenZeilen.toFixed(2)} € ≠ Gebührenrechnung ${gebuehrenNetto.toFixed(2)} €`);
  if (auszahlungsbetrag !== null && Math.abs(auszahlungsbetrag - auszahlung) > 0.01) warnungen.push(`Auszahlungsbetrag ${auszahlungsbetrag.toFixed(2)} € ≠ Auszahlungszeilen ${auszahlung.toFixed(2)} €`);

  // Rechnungsjournal: angekaufte Rechnungen / Gutschriften
  const positionen = [];
  let debitor = "";
  let imJournal = false;
  const rePos = new RegExp(`^\\s*(\\S+)\\s+(\\d{1,2}\\.\\d{1,2}\\.\\d{4})\\s+(${BETRAG})\\s*€\\s+([\\d,]+)\\s+(\\S+)\\s+(\\S+)\\s+(.*)$`);
  for (const l of lines) {
    if (/Rechnungsjournal/i.test(l)) { imJournal = true; continue; }
    if (!imJournal) continue;
    if (/Buchungsjournal/i.test(l)) break;
    const d = l.match(/Debitorenname:\s*(.+?)\s{2,}/);
    if (d) { debitor = d[1].trim(); continue; }
    const m = l.match(rePos);
    if (!m) continue;
    const b = (m[7].match(new RegExp(BETRAG, "g")) || []).map(num);
    if (b.length < 9) continue;
    positionen.push({
      rechnung: m[1], datum: isoDe(m[2]), betrag: num(m[3]), sperrProzent: num(m[4]), art: m[5], trans: m[6], debitor,
      forderung: b[0], nichtAngekauft: b[1], sperrkonto: b[2], brutto: b[3], gebuehrEf: b[4], gebuehrIk: b[5], ust: b[6], sonstiges: b[7], summe: b[8],
    });
  }

  if (positionen.length) {
    const ps = r2(positionen.reduce((s, p) => s + p.summe, 0));
    const az = auszahlungsbetrag ?? auszahlung;
    if (Math.abs(ps - az) > 0.01 && !sperrFreigabe && !uebertrag) warnungen.push(`Rechnungsjournal ${ps.toFixed(2)} € ≠ Auszahlung ${az.toFixed(2)} €`);
  }

  return {
    typ: "abrechnung", nr: Number(nr), datum, mandant, uebertrag, eingereicht, nichtAngekauft: r2(nichtAngekauft),
    sperrEinbehalt, sperrFreigabe, gebuehrenNetto, ust: r2(ust), auszahlung: auszahlungsbetrag ?? auszahlung,
    endsaldo, zeilen, positionen, warnungen,
  };
}

// ---------------------------------------------------------------- Zinsen
export function parseZinsen(lines) {
  const t = lines.join("\n");
  const perDatum = isoDe((t.match(/Zinsabrechnung\s+per\s+(\d{1,2}\.\d{1,2}\.\d{4})/i) || [])[1]);
  const rechnungsnr = (t.match(/Rechnungsnummer:\s*(\S+)/) || [])[1];
  const rechnungsdatum = isoDe((t.match(/Rechnungsdatum:\s*(\d{1,2}\.\d{1,2}\.\d{4})/) || [])[1]);
  if (!perDatum || !rechnungsnr) throw new Error("Zinsabrechnung: Datum oder Rechnungsnummer nicht gefunden");
  const get = (re) => { const m = t.match(re); return m ? num(m[1]) : null; };
  const netto = get(new RegExp(`Zinsbetrag netto:\\s+(${BETRAG})\\s*€`));
  const mwst = get(new RegExp(`MwSt[^:]*:\\s+(${BETRAG})\\s*€`)) || 0;
  const brutto = get(new RegExp(`Summe brutto:\\s+(${BETRAG})\\s*€`));
  const korrektur = get(new RegExp(`Zinskorrekturbetrag[^:]*:\\s+(${BETRAG})\\s*€`)) || 0;
  if (netto === null) throw new Error("Zinsabrechnung: Zinsbetrag netto nicht gefunden");

  const zeilen = [];
  const reZ = new RegExp(`^\\s*(\\d+)\\s+(\\d{1,2}\\.\\d{1,2}\\.\\d{4})\\s+(\\d{1,2}\\.\\d{1,2}\\.\\d{4})\\s+(\\d+)\\s+(${BETRAG})\\s*€\\s*([SH])\\s+(-?[\\d.]+,\\d+)\\s+(${BETRAG})\\s*€`);
  let satz = null;
  const block = [];
  for (const l of lines) {
    const m = l.match(reZ);
    if (m) { block.push({ konto: m[1], von: isoDe(m[2]), bis: isoDe(m[3]), tage: Number(m[4]), saldo: num(m[5]), sh: m[6], zinsen: Math.abs(num(m[8])) }); continue; }
    const s = l.match(/Zinssatz:\s*([\d,]+)\s*%/);
    if (s) { satz = num(s[1]); for (const z of block.splice(0)) zeilen.push({ ...z, zinssatz: satz }); }
  }
  for (const z of block) zeilen.push({ ...z, zinssatz: satz });

  const warnungen = [];
  const sumZeilen = r2(zeilen.reduce((s, z) => s + z.zinsen, 0));
  if (Math.abs(sumZeilen + Math.abs(korrektur) * Math.sign(korrektur) - netto) > 0.05 && Math.abs(sumZeilen - netto) > 0.05)
    warnungen.push(`Summenprüfung: Zinszeilen ${sumZeilen.toFixed(2)} € ≠ Zinsbetrag netto ${netto.toFixed(2)} €`);
  if (brutto !== null && Math.abs(r2(netto + mwst) - brutto) > 0.01) warnungen.push(`Netto + MwSt ≠ Brutto (${brutto.toFixed(2)} €)`);
  const tageSaldo = zeilen.reduce((s, z) => s + z.tage, 0);
  const ds = tageSaldo ? zeilen.reduce((s, z) => s + z.saldo * z.tage, 0) / tageSaldo : null;

  return { typ: "zinsen", rechnungsnr, perDatum, rechnungsdatum: rechnungsdatum || perDatum, netto, mwst, brutto: brutto ?? r2(netto + mwst), korrektur, durchschnittSaldo: ds, zeilen, warnungen };
}

export function parseFactoringLines(lines) {
  const typ = erkenneTyp(lines);
  if (typ === "abrechnung") return parseAbrechnung(lines);
  if (typ === "zinsen") return parseZinsen(lines);
  throw new Error("Kein nordwest-Beleg erkannt (weder Factoringabrechnung noch Zinsabrechnung)");
}

export async function parseFactoringPdf(file) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = await extractLinesRotiert(pdf, pdfjs);
  return { ...parseFactoringLines(lines), dateiname: file.name };
}
