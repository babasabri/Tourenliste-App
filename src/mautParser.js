// Toll Collect "Einzelfahrtennachweis" als CSV (Export aus dem Kundenportal)
// einlesen. Aufbau (Semikolon-getrennt):
//   Kopfzeile:  <Mautaufstellung-Nr.>;Kfz-Kennz.;Datum;Start;Buchungsnummer;Art;
//               Auffahrt;über;Abfahrt;Kostenstelle;Tarifmodell;Achsklasse;
//               Gewichtsklasse;Schadstoffklasse;K/E¹;CO2 Emissionsklasse;
//               Verfahren²;km;EUR;Stornierungsgebühr in EUR
//   Daten:      ;OF RY 500;07.09.2026;16:53;100006050661921;Maut;...;125,2;43,58;0,00
//   Fußzeilen:  ";" und Erklärungen (¹, ²) - werden ignoriert.
// Spalten werden über die Kopfzeile gesucht (nicht über feste Positionen),
// damit eine geänderte Spaltenreihenfolge nicht zu falschen Werten führt.

const norm = (s) => String(s || "").replace(/[¹²³]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const platKey = (s) => String(s || "").toUpperCase().replace(/[\s-]/g, "");

function zahl(s) {
  const t = String(s || "").trim();
  if (!t) return 0;
  const n = Number(t.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function splitZeile(line) {
  if (!line.includes('"')) return line.split(";");
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ";") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function dekodieren(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

const SPALTEN = {
  lkw: ["kfz-kennz.", "kfz-kennzeichen", "kennzeichen"],
  datum: ["datum"],
  zeit: ["start", "uhrzeit"],
  buchungsnr: ["buchungsnummer"],
  art: ["art"],
  auffahrt: ["auffahrt"],
  ueber: ["über", "ueber"],
  abfahrt: ["abfahrt"],
  kostenstelle: ["kostenstelle"],
  tarifmodell: ["tarifmodell"],
  achsklasse: ["achsklasse"],
  gewichtsklasse: ["gewichtsklasse"],
  schadstoffklasse: ["schadstoffklasse"],
  co2_klasse: ["co2 emissionsklasse", "co2-emissionsklasse"],
  verfahren: ["verfahren"],
  km: ["km"],
  betrag: ["eur", "betrag"],
  storno: ["stornierungsgebühr in eur", "stornierungsgebühr"],
};

// fleetPlates: Kennzeichen aus den Stammdaten - Schreibweise wird daran angeglichen.
export async function parseMautCsv(file, fleetPlates = []) {
  const text = dekodieren(await file.arrayBuffer()).replace(/^﻿/, "");
  const zeilen = text.split(/\r?\n/);
  const kopf = splitZeile(zeilen[0] || "").map(norm);
  const idx = {};
  for (const [feld, namen] of Object.entries(SPALTEN)) {
    idx[feld] = kopf.findIndex((h, i) => i > 0 && namen.includes(h));
  }
  if (idx.lkw < 0 || idx.datum < 0 || idx.buchungsnr < 0 || idx.betrag < 0) {
    throw new Error("Keine Toll-Collect-Einzelfahrtennachweis-CSV (Spalten Kfz-Kennz./Datum/Buchungsnummer/EUR fehlen)");
  }
  let nr = String(splitZeile(zeilen[0])[0] || "").replace(/\D/g, "");
  const fleetMap = new Map(fleetPlates.map((p) => [platKey(p), p]));

  const positionen = [];
  const fehlerZeilen = [];
  for (let i = 1; i < zeilen.length; i++) {
    const z = splitZeile(zeilen[i]);
    const get = (f) => (idx[f] >= 0 ? String(z[idx[f]] ?? "").trim() : "");
    const bnr = get("buchungsnr");
    if (!/^\d{6,}$/.test(bnr)) continue; // Fuß-/Leerzeilen
    const dm = get("datum").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const betrag = zahl(get("betrag"));
    const storno = zahl(get("storno"));
    const km = get("km") === "" ? null : zahl(get("km"));
    if (!dm || !Number.isFinite(betrag) || !Number.isFinite(storno) || (km !== null && !Number.isFinite(km))) {
      fehlerZeilen.push(i + 1);
      continue;
    }
    const roh = get("lkw");
    positionen.push({
      buchungsnr: bnr,
      kennzeichenBeleg: roh,
      lkw: fleetMap.get(platKey(roh)) || roh,
      datum: `${dm[3]}-${dm[2]}-${dm[1]}`,
      zeit: /^\d{1,2}:\d{2}/.test(get("zeit")) ? get("zeit").slice(0, 5) : "",
      art: get("art"),
      auffahrt: get("auffahrt"),
      ueber: get("ueber"),
      abfahrt: get("abfahrt"),
      kostenstelle: get("kostenstelle"),
      tarifmodell: get("tarifmodell"),
      achsklasse: get("achsklasse"),
      gewichtsklasse: get("gewichtsklasse"),
      schadstoffklasse: get("schadstoffklasse"),
      co2_klasse: get("co2_klasse"),
      verfahren: get("verfahren"),
      km,
      betrag: Math.round(betrag * 100) / 100,
      storno: Math.round(storno * 100) / 100,
    });
  }
  if (positionen.length === 0) throw new Error("Keine Mautfahrten in der Datei gefunden");

  // Mautaufstellung-Nr. steht in der ersten Kopfzelle; ersatzweise im Dateinamen
  const fn = file.name || "";
  if (!nr) nr = (fn.match(/(\d{10})/) || [])[1] || "";
  if (!nr) throw new Error("Mautaufstellung-Nr. nicht gefunden");
  // Datum der Mautaufstellung aus dem Dateinamen (..._6101626312_081026_0030.csv)
  const dn = fn.match(/_(\d{2})(\d{2})(\d{2})_\d{4}/);
  const datum = dn ? `20${dn[3]}-${dn[2]}-${dn[1]}` : "";

  const daten = positionen.map((p) => p.datum).sort();
  const doppelteBnr = positionen.length - new Set(positionen.map((p) => p.buchungsnr)).size;
  const summe = Math.round(positionen.reduce((s, p) => s + p.betrag + p.storno, 0) * 100) / 100;
  const fremd = Array.from(new Set(positionen.map((p) => p.lkw))).filter((p) => !fleetMap.has(platKey(p)));
  return {
    nr,
    datum,
    fahrtenVon: daten[0],
    fahrtenBis: daten[daten.length - 1],
    anzahl: positionen.length,
    summe,
    km: Math.round(positionen.reduce((s, p) => s + (p.km || 0), 0) * 10) / 10,
    lkwAnzahl: new Set(positionen.map((p) => p.lkw)).size,
    fremd,
    doppelteBnr,
    fehlerZeilen,
    dateiname: fn,
    positionen,
  };
}
