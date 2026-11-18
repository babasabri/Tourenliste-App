// Gemeinsame Rechenlogik für den Gutschriften-Abgleich (Teilgutschriften).
// Funktioniert sowohl mit App-Touren (camelCase, s. tourFromDb) als auch mit
// rohen DB-Zeilen (snake_case) - die Kostenfelder heißen in beiden gleich.

export const GS_FELDER = ["fracht", "fd", "adr", "multistop", "wartezeit", "maut", "diesel"];
export const FELD_LABEL = {
  fracht: "Fracht", fd: "FD", adr: "ADR", multistop: "Multistop",
  wartezeit: "Wartezeit", maut: "Maut", diesel: "Diesel", sonstige: "Sonstige",
};

export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function tourGesamt(t) {
  return r2(GS_FELDER.reduce((s, k) => s + (Number(t[k]) || 0), 0));
}

export const istTeil = (t) => t.status === "Teilabgerechnet";

const gutgeschrieben = (t) => Number(t.betragGutgeschrieben ?? t.betrag_gutgeschrieben) || 0;
const gespeicherteOffenFelder = (t) => t.offenFelder ?? t.offen_felder ?? null;

// Noch offener Betrag einer Tour: bei Teilabgerechnet = Gesamt minus bereits
// gutgeschrieben, sonst der volle Tourbetrag.
export function offenBetrag(t) {
  return istTeil(t) ? r2(tourGesamt(t) - gutgeschrieben(t)) : tourGesamt(t);
}

// Offene Beträge je Kostenart: bei Teilabgerechnet die beim Teil-Abrechnen
// gespeicherten fehlenden Felder, sonst die Kostenfelder der Tour.
export function offenFelder(t) {
  const gespeichert = gespeicherteOffenFelder(t);
  if (istTeil(t) && gespeichert && typeof gespeichert === "object") {
    const out = {};
    for (const [k, v] of Object.entries(gespeichert)) if (r2(v)) out[k] = r2(v);
    return out;
  }
  const out = {};
  for (const k of GS_FELDER) if (r2(t[k])) out[k] = r2(t[k]);
  return out;
}

export function felderAusZeilen(zeilen) {
  const out = {};
  for (const z of zeilen || []) {
    const k = z.feld || "sonstige";
    out[k] = r2((out[k] || 0) + (Number(z.betrag) || 0));
  }
  return out;
}

export function felderSumme(maps) {
  const out = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = r2((out[k] || 0) + v);
  return out;
}

// Vergleich je Kostenart: tour = offen laut Tour(en), gs = laut Gutschrift,
// diff = tour - gs (positiv = fehlt in der Gutschrift).
export function feldVergleich(tourFelder, gsFelder) {
  const keys = [...GS_FELDER, "sonstige"].filter((k) => r2(tourFelder[k]) || r2(gsFelder[k]));
  return keys.map((k) => {
    const tour = r2(tourFelder[k]), gs = r2(gsFelder[k]);
    return { feld: k, label: FELD_LABEL[k] || k, tour, gs, diff: r2(tour - gs) };
  });
}

// Fehlende Beträge je Kostenart, passend skaliert auf den tatsächlich offenen
// Gesamtbetrag (Rest/Abweichung landet unter "sonstige").
export function fehlendeFelder(vergleich, totalOffen) {
  const out = {};
  let sum = 0;
  for (const v of vergleich) if (v.diff > 0.01) { out[v.feld] = v.diff; sum += v.diff; }
  const rest = r2(totalOffen - sum);
  if (Math.abs(rest) > 0.01) out.sonstige = r2((out.sonstige || 0) + rest);
  for (const k of Object.keys(out)) if (Math.abs(out[k]) <= 0.01) delete out[k];
  return out;
}

export function formatFelder(obj) {
  if (!obj) return "";
  return Object.entries(obj)
    .filter(([, v]) => Math.abs(Number(v) || 0) > 0.01)
    .map(([k, v]) => `${FELD_LABEL[k] || k} ${(Number(v) || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" })}`)
    .join(", ");
}
