// Gutschriften-Abgleich: Dialog zum manuellen Zuweisen einer Gutschrift-Position
// zu einer oder mehreren Touren. Gebraucht, wenn eine Position nicht gefunden
// wurde (z. B. Tippfehler in der Auftrags-Nr.), mehrdeutig ist (mehrere Touren
// mit derselben Auftrags-Nr., die Contargo als EINE Position abrechnet) oder
// eine Differenz hat (z. B. FD fehlt -> Teilgutschrift).
// Wird sowohl in der Vorschau (vor "Übernehmen") als auch in der Prüfliste
// (nach dem Import) verwendet - was beim Bestätigen passiert, entscheidet der
// Aufrufer über onConfirm({ tourIds, zuordnung, teil, betragTour }).

import { useMemo, useState } from "react";
import { X, Search as SearchIcon, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  r2, offenBetrag, offenFelder, felderAusZeilen, felderSumme, feldVergleich,
  fehlendeFelder, formatFelder, tourGesamt, istTeil,
} from "./gutschriftLogik";

const MARINE = "#0F2A43";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS = "#2F8F6B";
const AMBER_DARK = "#8A5A10";
const WARN_BG = "#FDF1DD";

const dmy = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join(".") : "");
const euro = (n) => (Number(n) || 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

const STATUS_FARBE = {
  Offen: { bg: "#FFFF99", text: "#6B5900" },
  Reklamiert: { bg: "#FF9966", text: "#7A2E00" },
  Teilabgerechnet: { bg: "#B3D9FF", text: "#0B3D6B" },
  Abgerechnet: { bg: "#99FF99", text: "#1B5E20" },
};

export default function GutschriftZuweisen({ position, tours, vorbelegt = [], belegtIds = [], onClose, onConfirm }) {
  const [query, setQuery] = useState(position.orderNr || "");
  const [auchAbgerechnet, setAuchAbgerechnet] = useState(false);
  const [selected, setSelected] = useState(() => new Set(vorbelegt));
  const [modus, setModus] = useState("teil"); // "teil" | "voll" (nur relevant, wenn Gutschrift zu wenig zahlt)
  const [restTourWahl, setRestTourWahl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const belegt = useMemo(() => new Set(belegtIds), [belegtIds]);
  const orderNorm = norm(position.orderNr);
  const betragGs = r2(position.betrag);

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
  const summeGewaehlt = r2(gewaehlt.reduce((s, t) => s + offenBetrag(t), 0));
  const differenz = r2(betragGs - summeGewaehlt); // < 0: Gutschrift zahlt weniger
  const passt = gewaehlt.length > 0 && Math.abs(differenz) <= 0.01;
  const zuWenig = gewaehlt.length > 0 && differenz < -0.01;
  const zuViel = gewaehlt.length > 0 && differenz > 0.01;
  const totalOffen = zuWenig ? -differenz : 0;

  const vergleich = useMemo(
    () => feldVergleich(felderSumme(gewaehlt.map(offenFelder)), felderAusZeilen(position.zeilen)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gewaehlt.map((t) => t.id).join(","), position.zeilen, tours]
  );
  const fehlend = zuWenig ? fehlendeFelder(vergleich, totalOffen) : {};

  // Welche Tour behält den offenen Rest? Vorschlag: die Tour mit dem größten
  // Betrag in den fehlenden Kostenarten, sonst die erste.
  const restVorschlag = useMemo(() => {
    if (gewaehlt.length === 0) return null;
    const felder = Object.keys(fehlend);
    let best = gewaehlt[0], bestWert = -1;
    for (const t of gewaehlt) {
      const of = offenFelder(t);
      const w = felder.reduce((s, k) => s + (of[k] || 0), 0);
      if (w > bestWert) { best = t; bestWert = w; }
    }
    return best.id;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gewaehlt.map((t) => t.id).join(","), JSON.stringify(fehlend)]);
  const restTourId = restTourWahl && selected.has(restTourWahl) ? restTourWahl : restVorschlag;
  const restTour = gewaehlt.find((t) => t.id === restTourId);
  const restBuchung = restTour ? r2(offenBetrag(restTour) - totalOffen) : 0;
  const teilMoeglich = zuWenig && restTour && restBuchung >= -0.01;
  const teilAktiv = zuWenig && modus === "teil";

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function buildZuordnung() {
    if (teilAktiv) {
      return gewaehlt.map((t) => (t.id === restTourId
        ? { tourId: t.id, betrag: Math.max(0, restBuchung), betragTour: offenBetrag(t), teil: true, offenFelder: fehlend }
        : { tourId: t.id, betrag: offenBetrag(t), betragTour: offenBetrag(t), teil: false }));
    }
    // Voll abrechnen: jede Tour bekommt ihren offenen Betrag, eine eventuelle
    // Abweichung wird bei der ersten Tour verrechnet (Summe = Gutschrift).
    const z = gewaehlt.map((t) => ({ tourId: t.id, betrag: offenBetrag(t), betragTour: offenBetrag(t), teil: false }));
    if (z.length) z[0].betrag = r2(z[0].betrag + differenz);
    return z;
  }

  async function bestaetigen() {
    if (gewaehlt.length === 0) return;
    if (teilAktiv && !teilMoeglich) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm({
        tourIds: gewaehlt.map((t) => t.id),
        zuordnung: buildZuordnung(),
        teil: teilAktiv,
        betragTour: summeGewaehlt,
        offen: teilAktiv ? { betrag: totalOffen, felder: fehlend } : null,
      });
    } catch (err) {
      setError(err.message || "Zuweisen fehlgeschlagen.");
      setBusy(false);
    }
  }

  const btnLabel = teilAktiv
    ? "Teilgutschrift übernehmen"
    : gewaehlt.length > 1 ? `${gewaehlt.length} Touren zuweisen` : "Tour zuweisen";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,42,67,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: 12 }}>
      <div style={{ background: CARD, borderRadius: 12, padding: 22, width: 920, maxWidth: "100%", maxHeight: "92vh", display: "flex", flexDirection: "column", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Touren zuweisen</div>
            <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginTop: 4 }}>
              Position <span className="mono" style={{ fontWeight: 700, color: MARINE }}>{position.orderNr}</span>
              {position.kunde ? ` · ${position.kunde}` : ""}
              {position.gestellungsdatum ? ` · ${dmy(position.gestellungsdatum)}` : ""}
              {" · "}Betrag Gutschrift <span className="mono" style={{ fontWeight: 700, color: MARINE }}>{euro(betragGs)}</span>
              {position.belegNr ? ` · Gutschrift-Nr. ${position.belegNr}` : ""}
            </div>
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

        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "auto", maxHeight: 300, minHeight: 140 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 34 }}></th><th>Datum</th><th>LKW</th><th>Fahrer</th><th>Auftrags-Nr.</th>
                <th>Container-Nr.</th><th>Kunde</th><th>Ort</th>
                <th style={{ textAlign: "right" }}>Offen</th><th>Status</th>
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
                    <td className="mono" style={{ textAlign: "right" }}>
                      {euro(offenBetrag(t))}
                      {istTeil(t) && <div style={{ fontSize: 10.5, color: TEXT_MUTED }}>von {euro(tourGesamt(t))}</div>}
                    </td>
                    <td>
                      <span style={{ fontSize: 11, fontWeight: 700, background: sf.bg, color: sf.text, borderRadius: 6, padding: "2px 7px" }}>{t.status || "Offen"}</span>
                      {t.gutschriftNr && <div style={{ fontSize: 10.5, color: AMBER_DARK, marginTop: 2 }}>GS {t.gutschriftNr}</div>}
                      {belegt.has(t.id) && <div style={{ fontSize: 10.5, color: AMBER_DARK, marginTop: 2 }}>schon andere Position</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Vergleich je Kostenart, sobald Touren gewählt sind und die Summe abweicht */}
        {gewaehlt.length > 0 && !passt && vergleich.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Vergleich je Kostenart</div>
            <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th></th>
                    {vergleich.map((v) => <th key={v.feld} style={{ textAlign: "right" }}>{v.label}</th>)}
                    <th style={{ textAlign: "right" }}>Summe</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Tour(en) offen</td>
                    {vergleich.map((v) => <td key={v.feld} className="mono" style={{ textAlign: "right" }}>{euro(v.tour)}</td>)}
                    <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{euro(summeGewaehlt)}</td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Gutschrift</td>
                    {vergleich.map((v) => <td key={v.feld} className="mono" style={{ textAlign: "right" }}>{euro(v.gs)}</td>)}
                    <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{euro(betragGs)}</td>
                  </tr>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Differenz</td>
                    {vergleich.map((v) => (
                      <td key={v.feld} className="mono" style={{ textAlign: "right", fontWeight: Math.abs(v.diff) > 0.01 ? 700 : 400, color: v.diff > 0.01 ? DANGER : v.diff < -0.01 ? AMBER_DARK : SUCCESS }}>
                        {Math.abs(v.diff) > 0.01 ? (v.diff > 0 ? `fehlt ${euro(v.diff)}` : `+${euro(-v.diff)}`) : "✓"}
                      </td>
                    ))}
                    <td className="mono" style={{ textAlign: "right", fontWeight: 700, color: zuWenig ? DANGER : AMBER_DARK }}>{euro(-differenz)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Auswahl bei zu wenig bezahlt: Teilgutschrift oder voll abrechnen */}
        {zuWenig && (
          <div style={{ marginTop: 12, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "12px 14px", fontSize: 13 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", marginBottom: 8 }}>
              <input type="radio" checked={modus === "teil"} onChange={() => setModus("teil")} style={{ marginTop: 3 }} />
              <span>
                <b>Teilgutschrift</b> - erhaltene {euro(betragGs)} verbuchen, Tour wird <b>Teilabgerechnet</b>.
                Offen bleibt <b className="mono">{euro(totalOffen)}</b>{formatFelder(fehlend) ? ` (${formatFelder(fehlend)})` : ""} und
                erscheint unter Reklamationen. Kommt der Rest später mit derselben Auftrags-Nr., wird er automatisch zugeordnet.
              </span>
            </label>
            {modus === "teil" && gewaehlt.length > 1 && (
              <div style={{ margin: "0 0 10px 26px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>Offener Betrag bleibt bei Tour:</span>
                <select value={restTourId || ""} onChange={(e) => setRestTourWahl(e.target.value)} style={{ width: "auto" }}>
                  {gewaehlt.map((t) => (
                    <option key={t.id} value={t.id}>{dmy(t.datum)} · {t.lkw} · {t.containerNr || t.auftragsNr} · {euro(offenBetrag(t))}</option>
                  ))}
                </select>
                <span style={{ fontSize: 12, color: TEXT_MUTED }}>die anderen werden voll abgerechnet</span>
              </div>
            )}
            {modus === "teil" && !teilMoeglich && (
              <div style={{ margin: "0 0 10px 26px", color: DANGER, fontSize: 12.5 }}>
                Der offene Betrag ({euro(totalOffen)}) ist größer als der Betrag der gewählten Tour - bitte andere Tour wählen oder Auswahl prüfen.
              </div>
            )}
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
              <input type="radio" checked={modus === "voll"} onChange={() => setModus("voll")} style={{ marginTop: 3 }} />
              <span><b>Voll abrechnen</b> - Differenz von {euro(totalOffen)} wird nicht weiter verfolgt, Tour(en) werden <b>Abgerechnet</b>.</span>
            </label>
          </div>
        )}

        {!zuWenig && (
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
            ) : zuViel ? (
              <><AlertTriangle size={15} /> Gutschrift zahlt {euro(differenz)} mehr als die Tour(en) - evtl. fehlt ein Kostenfeld in der Tour (z. B. Wartezeit). Zuweisen ist trotzdem möglich, ggf. Tour danach anpassen.</>
            ) : null}
          </div>
        )}

        {error && (
          <div style={{ marginTop: 10, fontSize: 12.5, color: DANGER, background: DANGER_BG, borderRadius: 8, padding: "10px 14px" }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 14 }}>
          <button className="ghost" onClick={onClose} disabled={busy}>Abbrechen</button>
          {(() => {
            const disabled = busy || gewaehlt.length === 0 || (teilAktiv && !teilMoeglich);
            return (
              <button className="primary" onClick={bestaetigen} disabled={disabled} style={disabled ? { opacity: 0.6, cursor: "default" } : undefined}>
                {busy ? <Loader2 size={15} /> : <CheckCircle2 size={15} />} {btnLabel}
              </button>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
