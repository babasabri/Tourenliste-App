// Zeigt ein PDF aus dem Bucket "frachtbriefe" als Bilder (PDF.js, gleiche
// Bibliothek wie der Gutschriften-Parser). Funktioniert in jedem Browser -
// auch dort, wo kein eingebauter PDF-Viewer vorhanden ist - und lässt sich
// zoomen, um Handschrift (Kennzeichen, Uhrzeiten) zu prüfen.

import { useEffect, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2, RotateCw } from "lucide-react";
import { supabase } from "./supabaseClient";
import { loadPdfjs } from "./gutschriftParser";

const cache = new Map(); // datei_pfad -> Blob (bereits geladene Dateien)
const istBild = (p) => /\.(jpe?g|png|webp)$/i.test(p || "");
const istHeic = (p) => /\.hei[cf]$/i.test(p || "");

export default function PdfVorschau({ pfad }) {
  const boxRef = useRef(null);
  const [pdf, setPdf] = useState(null);
  const [bildUrl, setBildUrl] = useState(null); // bei Fotos statt PDF
  const [fehler, setFehler] = useState("");
  const [zoom, setZoom] = useState(1); // 1 = Seitenbreite
  const [drehung, setDrehung] = useState(0);
  const [breite, setBreite] = useState(0);

  // PDF laden
  useEffect(() => {
    let aktiv = true;
    let objUrl = null;
    setPdf(null);
    setBildUrl(null);
    setFehler("");
    setZoom(1);
    setDrehung(0);
    (async () => {
      try {
        if (istHeic(pfad)) throw new Error("HEIC-Fotos kann der Browser nicht anzeigen - bitte mit „Groß“ öffnen.");
        let blob = cache.get(pfad);
        if (!blob) {
          const { data, error } = await supabase.storage.from("frachtbriefe").download(pfad);
          if (error) throw error;
          blob = data;
          cache.set(pfad, blob);
        }
        if (istBild(pfad)) {
          objUrl = URL.createObjectURL(blob);
          if (aktiv) setBildUrl(objUrl);
          return;
        }
        const buf = await blob.arrayBuffer();
        const pdfjs = await loadPdfjs();
        const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
        if (aktiv) setPdf(doc);
      } catch (err) {
        if (aktiv) setFehler(err.message || "Frachtbrief konnte nicht geladen werden.");
      }
    })();
    return () => { aktiv = false; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [pfad]);

  // Breite des Bereichs beobachten (Seiten passen sich an)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBreite(el.clientWidth));
    ro.observe(el);
    setBreite(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const seiten = pdf ? Array.from({ length: pdf.numPages }, (_, i) => i + 1) : [];
  const knopf = { padding: "4px 7px", fontSize: 12 };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button type="button" className="ghost" style={knopf} title="Verkleinern" aria-label="Verkleinern" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}><ZoomOut size={13} /></button>
        <span style={{ fontSize: 12, color: "#64707C", minWidth: 40, textAlign: "center" }}>{Math.round(zoom * 100)} %</span>
        <button type="button" className="ghost" style={knopf} title="Vergrößern" aria-label="Vergrößern" onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}><ZoomIn size={13} /></button>
        <button type="button" className="ghost" style={knopf} title="Auf Breite" aria-label="Auf Breite" onClick={() => setZoom(1)}><Maximize2 size={13} /></button>
        <button type="button" className="ghost" style={knopf} title="Drehen" aria-label="Drehen" onClick={() => setDrehung((d) => (d + 90) % 360)}><RotateCw size={13} /></button>
        <span style={{ fontSize: 11.5, color: "#64707C", marginLeft: "auto" }}>{pdf ? `${pdf.numPages} Seite${pdf.numPages > 1 ? "n" : ""}` : ""}</span>
      </div>
      <div ref={boxRef} style={{ flex: 1, minHeight: 0, overflow: "auto", background: "#E9EDF1", borderRadius: 8, padding: 8, boxSizing: "border-box" }}>
        {fehler && <div style={{ padding: 20, fontSize: 13, color: "#C4573F" }}>{fehler}</div>}
        {bildUrl && breite > 0 && (
          <div style={{ display: "flex", justifyContent: "center" }}>
            <img src={bildUrl} alt="Frachtbrief" style={{ width: (breite - 16) * zoom, maxWidth: "none", transform: `rotate(${drehung}deg)`, transformOrigin: "center", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.15)", margin: drehung % 180 ? `${((breite - 16) * zoom) * 0.2}px 0` : 0 }} />
          </div>
        )}
        {!fehler && !pdf && !bildUrl && <div style={{ padding: 20, fontSize: 13, color: "#64707C", textAlign: "center" }}>Lade Frachtbrief …</div>}
        {pdf && breite > 0 && seiten.map((n) => (
          <PdfSeite key={`${n}-${drehung}`} pdf={pdf} nr={n} breite={(breite - 16) * zoom} drehung={drehung} />
        ))}
      </div>
    </div>
  );
}

function PdfSeite({ pdf, nr, breite, drehung }) {
  const ref = useRef(null);
  useEffect(() => {
    let task = null;
    let aktiv = true;
    pdf.getPage(nr).then((page) => {
      if (!aktiv || !ref.current) return;
      const basis = page.getViewport({ scale: 1, rotation: drehung });
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: (breite / basis.width) * dpr, rotation: drehung });
      const c = ref.current;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      c.style.width = `${Math.floor(vp.width / dpr)}px`;
      c.style.height = `${Math.floor(vp.height / dpr)}px`;
      task = page.render({ canvasContext: c.getContext("2d"), canvas: c, viewport: vp });
      task.promise.catch(() => {});
    });
    return () => { aktiv = false; if (task) task.cancel(); };
  }, [pdf, nr, breite, drehung]);
  return <canvas ref={ref} style={{ display: "block", margin: "0 auto 8px", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} />;
}
