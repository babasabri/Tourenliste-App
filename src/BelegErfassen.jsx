// "Werkstatt & Teile": Beleg manuell erfassen oder bearbeiten.
// Für alle Rechnungen außer Winkler-PDF (Werkstätten, andere Teilehändler,
// TÜV/AU) und für Käufe ohne Beleg. Kopf (Lieferant, Art, Nr., Datum, LKW,
// Anlass, km) + beliebig viele Positionen; PDF/Foto kann angehängt werden.
// Gutschriften werden negativ gespeichert (wie beim Winkler-Import).

import { useMemo, useState } from "react";
import { X, Plus, Trash2, Loader2, Paperclip, Save, Wrench, Package } from "lucide-react";
import * as edb from "./ersatzteilDb";
import { KATEGORIEN } from "./winklerParser";

const MARINE = "#0F2A43";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT = "#16232E";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const AMBER_DARK = "#8A5A10";
const WARN_BG = "#FDF1DD";

const heute = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const euro = (n) => (Number.isFinite(n) ? n.toLocaleString("de-DE", { style: "currency", currency: "EUR" }) : "–");
const fmt = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
function parseBetrag(s) {
  const t = String(s ?? "").trim().replace(/€/g, "").replace(/\s/g, "");
  if (!t) return null;
  let n;
  if (t.includes(",")) n = Number(t.replace(/\./g, "").replace(",", "."));
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) n = Number(t.replace(/\./g, ""));
  else n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
// Vorgabe-Kategorie je Lieferant (änderbar)
const standardKategorie = (lieferant) => (/^EGS\b/i.test(lieferant || "") ? "Prüfung (HU/SP/AU)" : "Ersatzteil");

export default function BelegErfassen({ lkwOptionen, lieferanten, beleg, vorlage, onClose, onSaved }) {
  const bearbeiten = !!beleg;
  const vz = beleg?.belegart === "gutschrift" ? -1 : 1;
  const [k, setK] = useState(() => ({
    lieferant: beleg?.lieferant || vorlage?.lieferant || "",
    belegart: beleg?.belegart || vorlage?.belegart || "rechnung",
    belegNr: beleg?.belegart === "ohne_beleg" ? "" : beleg?.belegNr || vorlage?.belegNr || "",
    datum: beleg?.datum || vorlage?.datum || heute(),
    lkw: beleg?.positionen?.[0]?.lkw || vorlage?.lkw || "",
    anlass: beleg?.positionen?.[0]?.anlass || "",
    kmStand: beleg?.positionen?.[0]?.kmStand ?? vorlage?.kmStand ?? "",
    bemerkung: beleg?.bemerkung || "",
    summeBeleg: vorlage?.netto != null ? fmt(Math.abs(vorlage.netto)) : "",
  }));
  const [pos, setPos] = useState(() =>
    beleg?.positionen?.length
      ? beleg.positionen.map((p) => ({ lkw: p.lkw || "", kategorie: p.kategorie, bezeichnung: p.bezeichnung, artikelNr: p.artikelNr || "", menge: p.menge ?? 1, betrag: fmt(vz * (p.netto + p.pfand)) }))
      : [{ lkw: "", kategorie: standardKategorie(vorlage?.lieferant), bezeichnung: "", artikelNr: "", menge: 1, betrag: "" }]
  );
  const [datei, setDatei] = useState(vorlage?.file || null);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState("");

  const setP = (i, patch) => setPos(pos.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const summe = useMemo(() => pos.reduce((s, p) => s + (parseBetrag(p.betrag) || 0), 0), [pos]);
  const kontrolle = parseBetrag(k.summeBeleg);
  const abweichung = kontrolle !== null && !Number.isNaN(kontrolle) && Math.abs(kontrolle - summe) > 0.005;

  function neuePosition(kategorie, bezeichnung = "") {
    setPos([...pos, { lkw: "", kategorie, bezeichnung, artikelNr: "", menge: 1, betrag: "" }]);
  }

  async function speichern() {
    setFehler("");
    const lieferant = k.lieferant.trim();
    if (!lieferant) return setFehler("Bitte Lieferant bzw. Werkstatt angeben.");
    if (!k.datum) return setFehler("Bitte Datum angeben.");
    if (k.belegart !== "ohne_beleg" && !k.belegNr.trim()) return setFehler("Bitte Rechnungs- bzw. Gutschrift-Nr. angeben (oder Art „ohne Beleg“ wählen).");
    const zeilen = pos.filter((p) => p.bezeichnung.trim() || p.betrag);
    if (!zeilen.length) return setFehler("Mindestens eine Position mit Bezeichnung und Betrag eintragen.");
    for (const [i, p] of zeilen.entries()) {
      const b = parseBetrag(p.betrag);
      if (!p.bezeichnung.trim()) return setFehler(`Position ${i + 1}: Bezeichnung fehlt.`);
      if (b === null || Number.isNaN(b)) return setFehler(`Position ${i + 1}: „${p.betrag}“ ist kein Betrag.`);
    }
    if (abweichung && !window.confirm(`Die Positionen ergeben ${euro(summe)}, auf dem Beleg stehen ${euro(kontrolle)} netto. Trotzdem speichern?`)) return;

    setBusy(true);
    try {
      let dateiPfad = beleg?.dateiPfad || "";
      if (datei) dateiPfad = await edb.uploadDatei(datei, lieferant);
      const s = k.belegart === "gutschrift" ? -1 : 1;
      const belegNr = k.belegart === "ohne_beleg"
        ? (beleg?.belegart === "ohne_beleg" ? beleg.belegNr : `OB-${k.datum.replace(/-/g, "")}-${Date.now().toString().slice(-6)}`)
        : k.belegNr.trim();
      const km = k.kmStand === "" ? null : parseInt(String(k.kmStand).replace(/\D/g, ""), 10) || null;
      const positionen = zeilen.map((p, i) => ({
        pos: (i + 1) * 10, teil: 1, lkw: p.lkw || k.lkw || null, lkw_quelle: "manuell",
        kategorie: p.kategorie, artikel_nr: p.artikelNr || null, bezeichnung: p.bezeichnung.trim(),
        menge: Number(String(p.menge).replace(",", ".")) || 1, einheit: "ST",
        netto: Math.round(s * parseBetrag(p.betrag) * 100) / 100, pfand: 0,
        gutschrift_grund: k.belegart === "gutschrift" ? "Rückgabe/Reklamation" : null,
        anlass: k.anlass.trim() || null, km_stand: km,
      }));
      const netto = Math.round(positionen.reduce((a, p) => a + p.netto, 0) * 100) / 100;
      const kopf = {
        lieferant, belegNr, belegart: k.belegart, belegDatum: k.datum, netto, brutto: null,
        dateiname: datei ? datei.name : beleg?.dateiname || null, dateiPfad, bemerkung: k.bemerkung.trim(), quelle: "manuell",
      };
      if (bearbeiten) await edb.ersetzeBeleg(beleg.id, kopf, positionen);
      else await edb.importBeleg({ ...kopf, positionen });
      if (!lieferanten.some((l) => l.name.toLowerCase() === lieferant.toLowerCase())) await edb.addLieferant(lieferant).catch(() => {});
      onSaved();
    } catch (e) {
      setFehler(e.message || String(e));
      setBusy(false);
    }
  }

  const feld = { display: "flex", flexDirection: "column", gap: 2 };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,42,67,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000, padding: "40px 16px", overflowY: "auto" }}>
      <div style={{ background: CARD, borderRadius: 12, padding: 22, width: "100%", maxWidth: 980, border: `1px solid ${BORDER}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: TEXT }}>{bearbeiten ? "Beleg bearbeiten" : "Beleg erfassen"}</div>
          <button className="ghost" onClick={onClose} disabled={busy} style={{ padding: "4px 8px" }}><X size={15} /></button>
        </div>

        {vorlage && (
          <div style={{ background: WARN_BG, color: AMBER_DARK, borderRadius: 8, padding: "9px 12px", fontSize: 12.5, marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ flex: "1 1 300px" }}>
              {vorlage.scan
                ? "Eingescannte Rechnung – bitte Angaben vom Beleg abtippen. Das PDF wird beim Speichern angehängt."
                : "Aus dem PDF vorausgefüllt, soweit erkennbar – bitte prüfen und die Positionen eintragen. Die Netto-Summe steht unten als Kontrolle. Das PDF wird beim Speichern angehängt."}
            </span>
            {datei && <button className="ghost" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => window.open(URL.createObjectURL(datei), "_blank")}><Paperclip size={12} /> PDF ansehen</button>}
          </div>
        )}

        {/* Kopf */}
        <div className="be-kopf" style={{ display: "grid", gridTemplateColumns: "2fr 1.2fr 1.4fr 1fr", gap: 10, marginBottom: 10 }}>
          <div style={feld}>
            <label>Lieferant / Werkstatt *</label>
            <input list="be-lieferanten" value={k.lieferant} placeholder="z. B. Heinrich Göbel"
              onChange={(e) => {
                const v = e.target.value;
                setK({ ...k, lieferant: v });
                // Vorgabe-Kategorie für noch leere Positionen nachziehen
                setPos(pos.map((p) => (!p.bezeichnung && !p.betrag ? { ...p, kategorie: standardKategorie(v) } : p)));
              }} />
            <datalist id="be-lieferanten">
              {lieferanten.map((l) => <option key={l.name} value={l.name}>{[l.ort, l.hinweis].filter(Boolean).join(" · ")}</option>)}
            </datalist>
          </div>
          <div style={feld}>
            <label>Art</label>
            <select value={k.belegart} onChange={(e) => setK({ ...k, belegart: e.target.value })}>
              <option value="rechnung">Rechnung</option>
              <option value="gutschrift">Gutschrift</option>
              <option value="ohne_beleg">ohne Beleg (z. B. Barkauf)</option>
            </select>
          </div>
          <div style={feld}>
            <label>{k.belegart === "gutschrift" ? "Gutschrift-Nr. *" : "Rechnungs-Nr." + (k.belegart === "ohne_beleg" ? "" : " *")}</label>
            <input value={k.belegNr} disabled={k.belegart === "ohne_beleg"} placeholder={k.belegart === "ohne_beleg" ? "wird automatisch vergeben" : ""}
              onChange={(e) => setK({ ...k, belegNr: e.target.value })} />
          </div>
          <div style={feld}>
            <label>Datum *</label>
            <input type="date" value={k.datum} onChange={(e) => setK({ ...k, datum: e.target.value })} />
          </div>
        </div>
        <div className="be-kopf" style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr 1.6fr", gap: 10, marginBottom: 14 }}>
          <div style={feld}>
            <label>LKW (für alle Positionen)</label>
            <select value={k.lkw} onChange={(e) => setK({ ...k, lkw: e.target.value })}>
              <option value="">– je Position –</option>
              {lkwOptionen.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div style={feld}>
            <label>Anlass / Reparatur</label>
            <input value={k.anlass} placeholder="z. B. Bremsen VA, Kupplung, HU" onChange={(e) => setK({ ...k, anlass: e.target.value })} />
          </div>
          <div style={feld}>
            <label>km-Stand</label>
            <input className="mono" inputMode="numeric" value={k.kmStand} placeholder="optional" onChange={(e) => setK({ ...k, kmStand: e.target.value })} />
          </div>
          <div style={feld}>
            <label>Beleg anhängen (PDF/Foto)</label>
            <label className="ghost" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", border: `1px solid ${BORDER}`, borderRadius: 6, padding: "6px 10px", fontSize: 12.5, color: TEXT, margin: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
              <Paperclip size={14} /> {datei ? datei.name : beleg?.dateiPfad ? "Datei vorhanden – ersetzen" : "Datei wählen"}
              <input type="file" accept="application/pdf,image/*" capture="environment" style={{ display: "none" }} onChange={(e) => setDatei(e.target.files?.[0] || null)} />
            </label>
          </div>
        </div>

        {/* Positionen */}
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>LKW</th><th>Kategorie</th><th>Bezeichnung *</th><th>Artikel-Nr.</th>
                <th style={{ textAlign: "right" }}>Menge</th><th style={{ textAlign: "right" }}>Betrag netto *</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pos.map((p, i) => (
                <tr key={i}>
                  <td>
                    <select value={p.lkw} onChange={(e) => setP(i, { lkw: e.target.value })} style={{ width: 118 }}>
                      <option value="">{k.lkw ? `(${k.lkw})` : "– offen –"}</option>
                      {lkwOptionen.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={p.kategorie} onChange={(e) => setP(i, { kategorie: e.target.value })} style={{ width: 160 }}>
                      {KATEGORIEN.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </td>
                  <td><input value={p.bezeichnung} onChange={(e) => setP(i, { bezeichnung: e.target.value })} style={{ minWidth: 220 }} /></td>
                  <td><input value={p.artikelNr} onChange={(e) => setP(i, { artikelNr: e.target.value })} style={{ width: 120 }} /></td>
                  <td><input className="mono" inputMode="decimal" value={p.menge} onChange={(e) => setP(i, { menge: e.target.value })} style={{ width: 64, textAlign: "right" }} /></td>
                  <td>
                    <input className="mono" inputMode="decimal" value={p.betrag} placeholder="0,00"
                      onChange={(e) => setP(i, { betrag: e.target.value })}
                      onBlur={(e) => { const b = parseBetrag(e.target.value); if (b !== null && !Number.isNaN(b)) setP(i, { betrag: fmt(b) }); }}
                      style={{ width: 110, textAlign: "right" }} />
                  </td>
                  <td>{pos.length > 1 && <button className="ghost" style={{ padding: "4px 8px" }} onClick={() => setPos(pos.filter((_, j) => j !== i))}><Trash2 size={13} /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button className="ghost" onClick={() => neuePosition(standardKategorie(k.lieferant))}><Plus size={14} /> Position</button>
          <button className="ghost" onClick={() => neuePosition("Ersatzteil", "Teile")}><Package size={14} /> + Teile</button>
          <button className="ghost" onClick={() => neuePosition("Werkstatt (Lohn)", "Arbeitslohn")}><Wrench size={14} /> + Arbeitslohn</button>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 14, marginTop: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            <div style={feld}>
              <label>Bemerkung</label>
              <input value={k.bemerkung} onChange={(e) => setK({ ...k, bemerkung: e.target.value })} style={{ width: 260 }} />
            </div>
            <div style={feld}>
              <label title="optional: Netto-Summe laut Beleg zur Kontrolle">Kontrolle: netto laut Beleg</label>
              <input className="mono" inputMode="decimal" value={k.summeBeleg} placeholder="optional" onChange={(e) => setK({ ...k, summeBeleg: e.target.value })} style={{ width: 130, textAlign: "right" }} />
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 12, color: TEXT_MUTED }}>Summe netto{k.belegart === "gutschrift" ? " (wird als Gutschrift abgezogen)" : ""}</div>
            <div className="mono" style={{ fontSize: 20, fontWeight: 600, color: MARINE }}>{euro(summe)}</div>
          </div>
        </div>
        {abweichung && (
          <div style={{ fontSize: 12.5, color: AMBER_DARK, background: WARN_BG, borderRadius: 8, padding: "8px 12px", marginTop: 10 }}>
            Positionen {euro(summe)} ≠ Beleg {euro(kontrolle)} – Differenz {euro(kontrolle - summe)}.
          </div>
        )}
        {fehler && <div style={{ fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "8px 12px", marginTop: 10 }}>{fehler}</div>}

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button className="primary" onClick={speichern} disabled={busy}>{busy ? <Loader2 size={15} /> : <Save size={15} />} Speichern</button>
          <button className="ghost" onClick={onClose} disabled={busy}>Abbrechen</button>
        </div>
        <style>{`@media (max-width: 820px) { .be-kopf { grid-template-columns: 1fr 1fr !important; } }`}</style>
      </div>
    </div>
  );
}
