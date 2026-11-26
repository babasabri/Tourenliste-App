// Gutschriften-Nacherfassung: alte Contargo-Gutschriften (vor dem laufenden
// Abgleich) gesammelt hochladen, damit bereits abgerechnete Touren ihre
// Gutschrift-Nr. bekommen.
//
// Ablauf: mehrere PDFs wählen -> jede wird im Browser gelesen (gleicher Parser
// wie beim laufenden Abgleich) und per RPC gutschrift_nacherfassung_pruefen
// OHNE Schreiben vorgeprüft -> Übersicht -> "Übernehmen" bucht per
// gutschrift_nacherfassung_import nur EXAKTE Treffer (Tour bleibt Abgerechnet,
// bekommt GS-Nr., ist danach gesperrt). Alles andere landet offen in der
// Nacherfassungs-Liste. Jeder Import ist komplett zurücknehmbar.

import { useEffect, useRef, useState } from "react";
import { Upload, Loader2, CheckCircle2, AlertTriangle, Undo2, History } from "lucide-react";
import { parseGutschriftPdf } from "./gutschriftParser";
import * as db from "./db";

const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS = "#2F8F6B";
const AMBER_DARK = "#8A5A10";
const MARINE = "#0F2A43";

const euro = (n) => (Number(n) || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const dmy = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join(".") : "");

const payload = (positionen) => positionen.map((p) => ({
  orderNr: p.orderNr, kunde: p.kunde || "", betrag: p.betrag, zeilen: p.zeilen || [],
  gestellungsdatum: p.gestellungsdatum || "",
}));

export default function GutschriftNacherfassung({ onChanged }) {
  const [dateien, setDateien] = useState([]); // { key, name, status, parsed, pruefung, ergebnis, fehler }
  const [busy, setBusy] = useState(false);
  const [imports, setImports] = useState([]);
  const [importsError, setImportsError] = useState("");
  const fileRef = useRef(null);

  async function ladeImports() {
    try {
      const alle = await db.fetchGutschriftImports();
      setImports(alle.filter((i) => i.nacherfassung));
    } catch (err) {
      setImportsError(err.message || "Imports konnten nicht geladen werden.");
    }
  }
  useEffect(() => { ladeImports(); }, []);

  function update(key, patch) {
    setDateien((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    const neu = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, name: f.name, file: f, status: "lese" }));
    setDateien((prev) => [...prev.filter((d) => d.status !== "importiert"), ...neu]);
    const gesehen = new Set();
    for (const d of neu) {
      try {
        const parsed = await parseGutschriftPdf(d.file);
        if (parsed.summenAbweichung) {
          update(d.key, { status: "fehler", parsed, fehler: `Summe der Positionen (${euro(parsed.parsedSumme)}) passt nicht zur Endsumme (${euro(parsed.dokumentSumme)}) - Datei bitte zur Prüfung schicken.` });
          continue;
        }
        if (gesehen.has(parsed.belegNr)) {
          update(d.key, { status: "vorhanden", parsed, fehler: "Diese Gutschrift ist doppelt ausgewählt." });
          continue;
        }
        gesehen.add(parsed.belegNr);
        const pruefung = await db.pruefenNacherfassung(parsed.belegNr, payload(parsed.positionen));
        update(d.key, {
          status: pruefung.vorhanden ? "vorhanden" : "bereit",
          parsed, pruefung,
          fehler: pruefung.vorhanden ? "Gutschrift ist bereits in der App - wird übersprungen." : "",
        });
      } catch (err) {
        update(d.key, { status: "fehler", fehler: err.message || "Datei konnte nicht gelesen werden." });
      }
    }
  }

  async function uebernehmen() {
    const bereit = dateien.filter((d) => d.status === "bereit");
    if (bereit.length === 0) return;
    setBusy(true);
    for (const d of bereit) {
      update(d.key, { status: "importiere" });
      try {
        const p = d.parsed;
        const ergebnis = await db.importNacherfassung({
          dateiname: d.name, belegNr: p.belegNr, rgDatum: p.rgDatum, dokumentSumme: p.dokumentSumme,
        }, payload(p.positionen));
        update(d.key, { status: "importiert", ergebnis });
      } catch (err) {
        update(d.key, { status: "fehler", fehler: err.message || "Import fehlgeschlagen." });
      }
    }
    setBusy(false);
    await ladeImports();
    onChanged && onChanged();
  }

  async function zuruecknehmen(imp) {
    if (!window.confirm(`Nacherfassung der Gutschrift ${imp.beleg_nr} komplett zurücknehmen?\n\nAlle Buchungen aus dieser Gutschrift werden entfernt, die Touren stehen wieder genau wie vorher da.`)) return;
    try {
      await db.rueckgaengigImport(imp.id);
      await ladeImports();
      onChanged && onChanged();
    } catch (err) {
      setImportsError(err.message || "Zurücknehmen fehlgeschlagen.");
    }
  }

  const bereit = dateien.filter((d) => d.status === "bereit");
  const summe = (k) => bereit.reduce((s, d) => s + (Number(d.pruefung?.[k]) || 0), 0);
  const leseLaeuft = dateien.some((d) => d.status === "lese");

  return (
    <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 24, marginBottom: 20 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
        <History size={16} /> Nacherfassung alter Gutschriften
      </div>
      <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 14, maxWidth: 760 }}>
        Für Gutschriften von vor dem laufenden Abgleich. Mehrere PDFs auf einmal möglich. Gebucht werden nur
        <b> exakte Treffer</b>: die Tour bleibt "Abgerechnet", bekommt Gutschrift-Nr. und Datum und ist danach gesperrt.
        Abweichungen werden <b>nicht</b> gebucht, sie landen unten in der Nacherfassungs-Liste. Bereits vorhandene
        Gutschriften werden übersprungen. Positionen aus 2025 (Gestellungsdatum vor 2026), zu denen es keine Tour
        in der App gibt, werden automatisch ignoriert und abgehakt. Jeder Import lässt sich komplett zurücknehmen.
      </div>

      <button className="primary" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}
        style={busy ? { opacity: 0.6, cursor: "default" } : undefined}>
        <Upload size={15} /> PDFs auswählen
      </button>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple onChange={handleFiles} style={{ display: "none" }} />

      {dateien.length > 0 && (
        <div style={{ marginTop: 16, border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Datei</th><th>Gutschrift</th><th>Datum</th>
                <th style={{ textAlign: "right" }}>Positionen</th>
                <th style={{ textAlign: "right" }}>Exakt → buchen</th>
                <th style={{ textAlign: "right" }}>Differenz</th>
                <th style={{ textAlign: "right" }}>Mehrdeutig</th>
                <th style={{ textAlign: "right" }}>Nicht gefunden</th>
                <th style={{ textAlign: "right" }}>Schon gebucht</th>
                <th style={{ textAlign: "right" }} title="Touren aus 2025 ohne Eintrag in der App - werden automatisch abgehakt">2025 ignoriert</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {dateien.map((d) => {
                const z = d.ergebnis || d.pruefung || {};
                return (
                  <tr key={d.key}>
                    <td style={{ fontSize: 12 }}>{d.name}</td>
                    <td className="mono">{d.parsed?.belegNr || "–"}</td>
                    <td className="mono">{dmy(d.parsed?.rgDatum)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{d.parsed?.positionen?.length ?? "–"}</td>
                    <td className="mono" style={{ textAlign: "right", color: SUCCESS, fontWeight: 700 }}>{z.abgerechnet ?? "–"}</td>
                    <td className="mono" style={{ textAlign: "right", color: z.differenz ? DANGER : undefined }}>{z.differenz ?? "–"}</td>
                    <td className="mono" style={{ textAlign: "right", color: z.mehrdeutig ? AMBER_DARK : undefined }}>{z.mehrdeutig ?? "–"}</td>
                    <td className="mono" style={{ textAlign: "right", color: z.nicht_gefunden ? AMBER_DARK : undefined }}>{z.nicht_gefunden ?? "–"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{z.bereits_gebucht ?? "–"}</td>
                    <td className="mono" style={{ textAlign: "right", color: TEXT_MUTED }}>{z.ignoriert_2025 ?? "–"}</td>
                    <td style={{ fontSize: 12 }}>
                      {d.status === "lese" && <span style={{ color: TEXT_MUTED, display: "inline-flex", gap: 4, alignItems: "center" }}><Loader2 size={12} /> wird geprüft …</span>}
                      {d.status === "bereit" && <span style={{ color: MARINE, fontWeight: 600 }}>bereit</span>}
                      {d.status === "importiere" && <span style={{ color: TEXT_MUTED, display: "inline-flex", gap: 4, alignItems: "center" }}><Loader2 size={12} /> wird gebucht …</span>}
                      {d.status === "importiert" && <span style={{ color: SUCCESS, fontWeight: 600, display: "inline-flex", gap: 4, alignItems: "center" }}><CheckCircle2 size={12} /> übernommen ({z.touren} Touren)</span>}
                      {d.status === "vorhanden" && <span style={{ color: TEXT_MUTED }}>{d.fehler}</span>}
                      {d.status === "fehler" && <span style={{ color: DANGER, display: "inline-flex", gap: 4, alignItems: "center" }}><AlertTriangle size={12} /> {d.fehler}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {bereit.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <button className="primary" disabled={busy || leseLaeuft} onClick={uebernehmen}
            style={busy || leseLaeuft ? { opacity: 0.6, cursor: "default" } : undefined}>
            <CheckCircle2 size={15} /> {busy ? "Übernehme …" : `${bereit.length} Gutschrift${bereit.length > 1 ? "en" : ""} übernehmen`}
          </button>
          <span style={{ fontSize: 12.5, color: TEXT_MUTED }}>
            {summe("touren")} Touren bekommen ihre Gutschrift-Nr. ({euro(summe("summe_abgerechnet"))}) ·
            {" "}{summe("differenz") + summe("mehrdeutig") + summe("nicht_gefunden")} Positionen zur Prüfung in die Nacherfassungs-Liste
          </span>
        </div>
      )}

      {importsError && (
        <div style={{ marginTop: 12, fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px" }}>{importsError}</div>
      )}

      {imports.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Bisher nacherfasst ({imports.length})</div>
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "auto", maxHeight: 280 }}>
            <table>
              <thead>
                <tr>
                  <th>Gutschrift</th><th>Datum</th>
                  <th style={{ textAlign: "right" }}>Positionen</th>
                  <th style={{ textAlign: "right" }}>Gebucht</th>
                  <th style={{ textAlign: "right" }}>Zur Prüfung</th>
                  <th style={{ textAlign: "right" }}>Endsumme</th>
                  <th>Erfasst am</th><th></th>
                </tr>
              </thead>
              <tbody>
                {[...imports].sort((a, b) => String(a.rg_datum).localeCompare(String(b.rg_datum))).map((i) => (
                  <tr key={i.id}>
                    <td className="mono">{i.beleg_nr}</td>
                    <td className="mono">{dmy(i.rg_datum)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{i.anzahl_positionen}</td>
                    <td className="mono" style={{ textAlign: "right", color: SUCCESS }}>{i.anzahl_abgerechnet}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{(i.anzahl_differenz || 0) + (i.anzahl_mehrdeutig || 0) + (i.anzahl_nicht_gefunden || 0)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{euro(i.dokument_summe)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{dmy(i.created_at)}</td>
                    <td>
                      <button className="ghost" style={{ padding: "3px 8px", fontSize: 12 }} onClick={() => zuruecknehmen(i)} title="Diese Nacherfassung komplett zurücknehmen">
                        <Undo2 size={12} /> Zurücknehmen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
