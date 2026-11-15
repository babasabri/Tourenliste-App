// ============================================================================
// Werkstatt & Teile: E-Rechnungen (ZUGFeRD 2.x / Factur-X / XRechnung-CII).
// Im PDF steckt eine XML-Datei (z. B. "factur-x.xml") mit allen Positionen
// und Beträgen - die wird gelesen, nicht der gedruckte Text. Funktioniert
// damit für JEDEN Lieferanten, der E-Rechnungen schickt.
//
// Eigenkontrolle: Summe der Positionen + Zuschläge - Abschläge muss die
// Steuer-Bemessungsgrundlage (TaxBasisTotalAmount) ergeben.
// Gutschriften: TypeCode 381 bzw. "Gutschriftsbetrag"/"Gutschrift" im
// gedruckten Text (manche Systeme markieren Korrekturen fälschlich als 380).
// ============================================================================
import { kategorieVorschlag, ordneFahrzeugZu } from "./winklerParser";

const XML_NAMEN = /^(factur-x|zugferd-invoice|zugferd|xrechnung|ZUGFeRD-invoice)\.xml$/i;
const r2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, "");

// XML-Anhang aus einem geöffneten PDF.js-Dokument holen (oder null)
export async function zugferdXmlAusPdf(pdf) {
  let att = null;
  try { att = await pdf.getAttachments(); } catch { return null; }
  if (!att) return null;
  // PDF.js 6: Map id -> {filename, content?}; ältere Versionen: Objekt
  const eintraege = att instanceof Map ? [...att.entries()] : Object.entries(att);
  const treffer = eintraege.find(([, a]) => XML_NAMEN.test(a.filename || "")) || eintraege.find(([, a]) => /\.xml$/i.test(a.filename || ""));
  if (!treffer) return null;
  const [id, a] = treffer;
  let inhalt = a.content || null;
  if (!inhalt && typeof pdf.getAttachmentContent === "function") {
    try { inhalt = await pdf.getAttachmentContent(id); } catch { inhalt = null; }
  }
  if (!inhalt) return null;
  const text = new TextDecoder("utf-8").decode(inhalt);
  return /CrossIndustryInvoice/.test(text) ? text : null;
}

// --- kleine DOM-Helfer (namespace-unabhängig über localName) -------------
const kinder = (el, name) => (el ? Array.from(el.childNodes || []).filter((n) => n.nodeType === 1 && n.localName === name) : []);
function pfad(el, p) {
  let cur = el;
  for (const teil of p.split("/")) { cur = kinder(cur, teil)[0]; if (!cur) return null; }
  return cur;
}
const txt = (el, p) => { const n = p ? pfad(el, p) : el; return n ? String(n.textContent || "").trim() : ""; };
const num = (el, p) => { const t = txt(el, p); if (t === "") return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const alle = (el, name) => Array.from(el.getElementsByTagNameNS ? el.getElementsByTagNameNS("*", name) : []);

const EINHEIT = { C62: "ST", H87: "ST", XPP: "ST", HUR: "Std", LTR: "L", KGM: "kg", MTR: "m", SET: "Set", PR: "Paar" };

function kategorie(name) {
  const b = String(name || "").toLowerCase();
  if (/arbeitslohn|arbeitszeit|\blohn\b|montage|einbau|ausbau|parametrierung|programmierung|diagnose|prüfung|instandsetzung|reparatur/.test(b)) return "Werkstatt (Lohn)";
  if (/hauptuntersuchung|abgasuntersuchung|sicherheitsprüfung/.test(b)) return "Prüfung (HU/SP/AU)";
  if (/reifen/.test(b)) return "Reifen";
  return kategorieVorschlag(name);
}

export function parseZugferd(xmlText, textLines, fleetPlates, finMap, lieferanten = []) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const root = doc.documentElement;
  const ed = pfad(root, "ExchangedDocument");
  const tx = pfad(root, "SupplyChainTradeTransaction");
  if (!ed || !tx) throw new Error("E-Rechnung (XML) mit unbekanntem Aufbau.");

  const belegNr = txt(ed, "ID");
  const typ = txt(ed, "TypeCode");
  const d = txt(ed, "IssueDateTime/DateTimeString");
  const belegDatum = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
  const notizen = kinder(ed, "IncludedNote")
    .filter((n) => !/^(REG|ABL|TXD|SUR)$/.test(txt(n, "SubjectCode")))
    .map((n) => txt(n, "Content").replace(/\s+/g, " "))
    .filter(Boolean);

  const agreement = pfad(tx, "ApplicableHeaderTradeAgreement");
  const verkaeufer = txt(agreement, "SellerTradeParty/Name").replace(/^Firma\s+/i, "");
  const settlement = pfad(tx, "ApplicableHeaderTradeSettlement");
  const summen = pfad(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
  const basis = num(summen, "TaxBasisTotalAmount");
  const brutto = num(summen, "GrandTotalAmount");
  const bezug = txt(settlement, "InvoiceReferencedDocument/IssuerAssignedID") || (notizen.join(" ").match(/zu Rechnung\s+(\S+)/i) || [])[1] || null;

  // Positionen
  const zeilen = kinder(tx, "IncludedSupplyChainTradeLineItem").map((li) => {
    const prod = pfad(li, "SpecifiedTradeProduct");
    const name = txt(prod, "Name") || txt(prod, "Description") || "(ohne Bezeichnung)";
    const mengeEl = pfad(li, "SpecifiedLineTradeDelivery/BilledQuantity");
    return {
      artikel: txt(prod, "SellerAssignedID") || txt(prod, "GlobalID") || null,
      name: name.replace(/\s+/g, " "),
      zusatz: [txt(prod, "Description"), ...kinder(pfad(li, "AssociatedDocumentLineDocument"), "IncludedNote").map((n) => txt(n, "Content"))].filter((s) => s && s !== name).join("; ") || null,
      menge: mengeEl ? Number(mengeEl.textContent) || 1 : 1,
      einheit: EINHEIT[mengeEl?.getAttribute("unitCode")] || mengeEl?.getAttribute("unitCode") || "ST",
      betrag: num(li, "SpecifiedLineTradeSettlement/SpecifiedTradeSettlementLineMonetarySummation/LineTotalAmount") ?? 0,
    };
  });
  // Zu-/Abschläge auf Belegebene (z. B. Fracht, Mindermengenzuschlag, Rabatt)
  for (const ac of kinder(settlement, "SpecifiedTradeAllowanceCharge")) {
    const zuschlag = /true/i.test(txt(ac, "ChargeIndicator/Indicator"));
    const betrag = num(ac, "ActualAmount") ?? 0;
    if (!betrag) continue;
    zeilen.push({ artikel: null, name: txt(ac, "Reason") || (zuschlag ? "Zuschlag" : "Abschlag"), zusatz: null, menge: 1, einheit: "ST", betrag: zuschlag ? betrag : -betrag });
  }
  if (!belegNr || zeilen.length === 0) throw new Error("E-Rechnung ohne Belegnummer oder ohne Positionen.");

  // Gutschrift?
  const druck = (textLines || []).join("\n");
  const gutschrift = typ === "381" || /Gutschriftsbetrag|Gutschrift\s*(Nr|Nummer)/i.test(druck) || ((basis ?? 0) < 0);
  const vz = gutschrift && (basis ?? 0) > 0 ? -1 : 1;

  // Lieferant: vorhandenen Namen aus der Liste verwenden, sonst Firmenname ohne Rechtsform
  const vn = norm(verkaeufer);
  const bekannt = lieferanten.map((l) => l.name).filter((n) => {
    if (!n || norm(n).length < 3) return false;
    if (norm(n).length <= 4) return new RegExp(`(^|[^A-Za-zÄÖÜäöü])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-zÄÖÜäöü]|$)`, "i").test(verkaeufer);
    return vn.includes(norm(n)) || norm(n).includes(vn);
  }).sort((a, b) => b.length - a.length)[0];
  const lieferant = bekannt || verkaeufer.replace(/\s+(GmbH(\s*&\s*Co\.?\s*KG)?|AG|KG|e\.K\.|OHG|UG.*)$/i, "").trim() || "E-Rechnung";

  // Fahrzeug aus Notizen, Positionstexten und gedrucktem Text
  const korpus = [...notizen, ...zeilen.map((z) => z.name + " " + (z.zusatz || "")), druck].join("\n");
  const kn = norm(korpus);
  const platten = (fleetPlates || []).filter((p) => kn.includes(norm(p)));
  const fins = new Set((korpus.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || []).filter((f) => Object.keys(finMap || {}).some((k) => norm(k) === f)));
  let lkw = null, quelle = null, hinweis = null;
  if (platten.length <= 1 && fins.size <= 1 && (platten.length || fins.size)) {
    const z = ordneFahrzeugZu(platten[0] || "", [...fins][0] || "", fleetPlates, finMap);
    lkw = z.lkw; quelle = z.quelle; hinweis = z.hinweis || null;
  } else if (platten.length > 1 || fins.size > 1) hinweis = "Mehrere Fahrzeuge auf dem Beleg – bitte je Position zuordnen";
  else hinweis = "Kein Fahrzeug auf dem Beleg";
  const kmM = druck.match(/km-?Stand\s*:?\s*([\d.]{3,9})\b/i);
  const km = kmM ? parseInt(kmM[1].replace(/\./g, ""), 10) || null : null;

  const anlass = notizen[0] ? notizen[0].replace(/^[A-Z]{1,3}[- ]?[A-Z]{1,2}[- ]?\d{1,4}\s*:\s*/, "").slice(0, 90) : null;

  const positionen = zeilen.map((z, i) => {
    const pfand = /pfand/i.test(z.name);
    return {
      pos: (i + 1) * 10, teil: 1, lieferschein: null, lieferdatum: null, bestelldaten: null, fin: [...fins][0] || null,
      lkw, lkw_quelle: quelle, kategorie: pfand ? "Ersatzteil" : kategorie(z.name),
      artikel_nr: z.artikel, bezeichnung: z.name, zusatz: z.zusatz, menge: z.menge, einheit: z.einheit,
      netto: pfand ? 0 : r2(vz * z.betrag), pfand: pfand ? r2(vz * z.betrag) : 0,
      bezug_beleg_nr: gutschrift ? bezug : null, bezug_pos: null,
      gutschrift_grund: gutschrift ? (pfand ? "Altteilpfand zurück" : "Rückgabe/Reklamation") : null,
      hinweis, anlass, km_stand: km,
    };
  });
  const parsedSumme = r2(zeilen.reduce((s, z) => s + z.betrag, 0));
  return {
    lieferant,
    belegNr,
    belegart: gutschrift ? "gutschrift" : "rechnung",
    belegDatum,
    dokumentSumme: basis,
    parsedSumme,
    summenAbweichung: basis === null || Math.abs(parsedSumme - basis) > 0.005,
    netto: r2(vz * (basis ?? parsedSumme)),
    brutto: brutto === null ? null : r2(vz * brutto),
    bemerkung: ["E-Rechnung (ZUGFeRD)", verkaeufer, ...notizen, gutschrift && bezug ? `zu Rechnung ${bezug}` : ""].filter(Boolean).join(" · ").slice(0, 1000),
    positionen,
  };
}
