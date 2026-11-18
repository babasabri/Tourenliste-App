// Gutschriften-Abgleich: Dialog zum manuellen Zuweisen einer Gutschrift-Position
// zu einer oder mehreren Touren. Gebraucht, wenn eine Position nicht gefunden
// wurde (z. B. Tippfehler in der Auftrags-Nr.) oder mehrdeutig ist (mehrere
// Touren mit derselben Auftrags-Nr., die Contargo als EINE Position abrechnet).
// Wird sowohl in der Vorschau (vor "Übernehmen") als auch in der Prüfliste
// (nach dem Import) verwendet - was beim Bestätigen passiert, entscheidet der
// Aufrufer über onConfirm(tourIds).

import { useMemo, useState } from "react";
import { X, Search as SearchIcon, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";

const MARINE = "#0F2A43";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS = "#2F8F6B";
const AMBER_DARK = "#8A5A10";
const WARN_BG = "#FDF1DD";

const COSTFIELDS = ["fracht", "fd", "adr", "multistop", "wartezeit", "maut", "diesel"];
const summe = (t) => Math.round(COSTFIELDS.reduce((s, k) => s + (Number(t[k]) || 0), 0) * 100) / 100;
const dmy = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "");
const euro = (n) => (Number(n) || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

const STATUS_FARBE = {
  Offen: { bg: "#FFFF99", text: "#6B5900" },
  Reklamiert: { bg: "#FF9966", text: "#7A2E00" },
  Abgerechnet: { bg: "#99FF99", text: "#1B5E20" },
};

export default function GutschriftZuweisen({ position, tours, vorbelegt = [], belegtIds = [], onClose, onConfirm }) {
  const [query, setQuery] = useState(position.orderNr || "");
  const [auchAbgerechnet, setAuchAbgerechnet] = useState(false);
  const [selected, setSelected] = useState(() => new Set(vorbelegt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const belegt = useMemo(() => new Set(belegtIds), [belegtIds]);
  const orderNorm = norm(position.orderNr);

  const liste = useMemo(() => {
    const q = norm(query);
    const treffer = tours.filter((t) => {
      if (selected.has(t.id)) return true;
      if (!auchAbgerechnet && t.status === "Abgerechnet") return false;
      if (!q) return norm(t.auftragsNr) === orderNorm;
      return [t.auftragsNr, t.containerNr, t.kunde, t.ort, t.lkw, t.fahrer, dmy(t.datum)].some((v) => norm(v).includes(q));
    });
    treffer.sort((a, b) => {
      const sa = selected.has(a.id) ? 0 : 1, sb = selected.has(b.id) ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const ea = norm(a.auftragsNr) === orderNorm ? 0 : 1, eb = norm(b.auftragsNr) === orderNorm ? 0 : 1;
      if (ea !== eb) return ea - eb;
      return (b.datum || "").localeCompare(a.datum || "");
    });
    return treffer.slice(0, 150);
  }, [tours, query, auchAbgerechnet, selected, orderNorm]);

  const gewaehlt = tours.filter((t) => selected.has(t.id));
  const summeGewaehlt = Math.round(gewaehlt.reduce((s, t) => s + summe(t), 0) * 100) / 100;
  const differenz = Math.round(((Number(position.betrag) || 0) - summeGewaehlt) * 100) / 100;
  const passt = gewaehlt.length > 0 && Math.abs(differenz) <= 0.01;

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function bestaetigen() {
    if (gewaehlt.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm(gewaehlt.map((t) => t.id));
    } catch (err) {
      setError(err.message || "Zuweisen fehlgeschlagen.");
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,42,67,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 12 }}>
      <div style={{ background: CARD, borderRadius: 12, padding: 22, width: 900, maxWidth: "100%", maxHeight: "90vh", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Touren manuell zuweisen</div>
            <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginTop: 4 }}>
              Position <span className="mono" style={{ fontWeight: 700, color: MARINE }}>{position.orderNr}</span>
              {position.kunde ? ` · ${position.kunde}` : ""}
              {position.gestellungsdatum ? ` · ${dmy(position.gestellungsdatum)}` : ""}
              {" · "}Betrag Gutschrift <span className="mono" style={{ fontWeight: 700, color: MARINE }}>{euro(position.betrag)}</span>
              {position.belegNr ? ` · Gutschrift-Nr. ${position.belegNr}` : ""}
            </div>
            {Array.isArray(position.zeilen) && position.zeilen.length > 0 && (
              <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 4 }}>
                {position.zeilen.map((z, i) => <span key={i}>{i > 0 ? " · " : ""}{z.label} {euro(z.betrag)}</span>)}
              </div>
            )}
          </div>
          <button className="ghost" style={{ padding: 6 }} onClick={onClose} disabled={busy}><X size={15} /></button>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <div style={{ position: "relative", flex: "1 1 320px" }}>
            <SearchIcon size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: TEXT_MUTED }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Auftrags-Nr., Container-Nr., Kunde, Ort, LKW, Fahrer oder Datum (TT.MM.JJJJ)"
              style={{ width: "100%", paddingLeft: 30 }}
              autoFocus
            />
          </div>
          <label style={{ fontSize: 12.5, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={auchAbgerechnet} onChange={(e) => setAuchAbgerechnet(e.target.checked)} />
            auch abgerechnete Touren zeigen
          </label>
        </div>

        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "auto", flex: 1, minHeight: 180 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }}></th><th>Datum</th><th>LKW</th><th>Fahrer</th><th>Auftrags-Nr.</th>
                <th>Container-Nr.</th><th>Kunde</th><th>Ort</th>
                <th style={{ textAlign: "right" }}>Gesamt</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {liste.length === 0 && (
                <tr><td colSpan={10} style={{ textAlign: "center", color: TEXT_MUTED, padding: 22 }}>
                  Keine passende Tour gefunden - Suchbegriff ändern (z. B. Container-Nr. oder Kunde) oder "auch abgerechnete Touren zeigen" aktivieren.
                </td></tr>
              )}
              {liste.map((t) => {
                const sel = selected.has(t.id);
                const sf = STATUS_FARBE[t.status] || STATUS_FARBE.Offen;
                const exakt = norm(t.auftragsNr) === orderNorm;
                return (
                  <tr key={t.id} onClick={() => toggle(t.id)} style={{ cursor: "pointer", background: sel ? "#E7F1FB" : undefined }}>
                    <td><input type="checkbox" checked={sel} onChange={() => toggle(t.id)} onClick={(e) => e.stopPropagation()} /></td>
                    <td className="mono">{dmy(t.datum)}</td>
                    <td className="mono">{t.lkw}</td>
                    <td>{t.fahrer}</td>
                    <td className="mono" style={exakt ? { fontWeight: 700 } : undefined}>{t.auftragsNr}</td>
                    <td className="mono">{t.containerNr}</td>
                    <td>{t.kunde}</td>
                    <td>{t.ort}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{euro(summe(t))}</td>
                    <td>
                      <span style={{ fontSize: 11, fontWeight: 700, background: sf.bg, color: sf.text, borderRadius: 6, padding: "2px 7px" }}>{t.status || "Offen"}</span>
                      {t.gutschriftNr && <div style={{ fontSize: 10.5, color: AMBER_DARK, marginTop: 2 }}>schon GS {t.gutschriftNr}</div>}
                      {belegt.has(t.id) && <div style={{ fontSize: 10.5, color: AMBER_DARK, marginTop: 2 }}>schon andere Position</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{
          marginTop: 12, fontSize: 12.5, borderRadius: 8, padding: "10px 14px",
          background: gewaehlt.length === 0 ? "#F5F6F8" : passt ? "#E7F6EF" : WARN_BG,
          color: gewaehlt.length === 0 ? TEXT_MUTED : passt ? SUCCESS : AMBER_DARK,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          {gewaehlt.length === 0 ? (
            <>Tour(en) anklicken, die zu dieser Position gehören. Bei gleicher Auftrags-Nr. einfach alle zugehörigen Touren auswählen.</>
          ) : passt ? (
            <><CheckCircle2 size={15} /> {gewaehlt.length} Tour(en) ausgewählt · Summe {euro(summeGewaehlt)} = Betrag Gutschrift</>
          ) : (
            <><AlertTriangle size={15} /> {gewaehlt.length} Tour(en) ausgewählt · Summe {euro(summeGewaehlt)} · Differenz {euro(differenz)} zur Gutschrift - Zuweisen ist trotzdem möglich (Touren werden auf "Abgerechnet" gesetzt).</>
          )}
        </div>

        {error && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px" }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14 }}>
          <button className="ghost" onClick={onClose} disabled={busy}>Abbrechen</button>
          <button className="primary" onClick={bestaetigen} disabled={busy || gewaehlt.length === 0}
            style={(busy || gewaehlt.length === 0) ? { opacity: 0.6, cursor: "default" } : undefined}>
            {busy ? <Loader2 size={15} /> : <CheckCircle2 size={15} />} {gewaehlt.length > 1 ? `${gewaehlt.length} Touren zuweisen` : "Tour zuweisen"}
          </button>
        </div>
      </div>
    </div>
  );
}
