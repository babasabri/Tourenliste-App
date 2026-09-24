// Export-Funktionen für die Wochen-Kontrolle: PDF (jsPDF + autoTable) und
// Excel (ExcelJS). Bewusst als eigenes Modul statt in App.jsx, damit die
// Export-Bibliotheken sauber getrennt bleiben. Ein paar kleine Formatierungs-
// Helfer sind hier absichtlich dupliziert (statt aus App.jsx importiert),
// damit dieses Modul unabhängig bleibt.

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import ExcelJS from "exceljs";

const COSTFIELDS = ["fracht", "fd", "adr", "multistop", "wartezeit", "maut", "diesel"];
const COSTFIELD_LABELS = {
  fracht: "Fracht", fd: "FD", adr: "ADR", multistop: "Multistop",
  wartezeit: "Wartezeit", maut: "Maut", diesel: "Diesel",
};

function formatDateDMY(iso) {
  if (!iso) return "";
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${d}.${m}.${y}`;
}

function euro(n) {
  const v = Number(n) || 0;
  return v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function gesamt(t) {
  return COSTFIELDS.reduce((sum, k) => sum + (Number(t[k]) || 0), 0);
}

// Gleiche Statusfarben wie in der App-Oberfläche (statusColors in App.jsx),
// hier als reine Hex-Werte ohne "#" für ExcelJS-Zellfüllungen.
function statusColorsHex(status) {
  if (status === "Reklamiert") return { bg: "FF9966", text: "7A2E00" };
  if (status === "Abgerechnet") return { bg: "99FF99", text: "1B5E20" };
  return { bg: "FFFF99", text: "6B5900" };
}

// Gleiche LKW-Blockfarben wie lkwBlockColor in App.jsx.
const LKW_BLOCK_COLORS_HEX = {
  "OF RY 500": "B8CCE4",
  "OF RY 700": "C6D6BE",
  "OF RY 750": "E0D3B8",
  "OF RY 800": "CFC6DA",
  "OF RY 850": "B7D6D3",
  "B-CY 3552": "D2D2D2",
};
function lkwBlockColorHex(plate) {
  return LKW_BLOCK_COLORS_HEX[plate] || "E4E7EB";
}

function hexToRgbArray(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const PDF_HEAD = ["Datum", "Fahrer", "Kunde", "Auftrags-Nr.", "Ankunft", "Abfahrt",
  ...COSTFIELDS.map((k) => COSTFIELD_LABELS[k]), "Gesamt", "Status"];

/**
 * Exportiert die Wochen-Kontrolle der übergebenen Woche als PDF.
 * @param {{ jahr: number, kw: number, vonLabel: string, bisLabel: string, bloecke: Array }} params
 *   bloecke = wochenBloecke aus App.jsx (ein Eintrag je LKW mit touren/summe/etc.)
 */
export function exportWochenkontrollePdf({ jahr, kw, vonLabel, bisLabel, bloecke }) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 10;

  doc.setFontSize(14);
  doc.setTextColor(15, 42, 67); // MARINE
  doc.text(`Wochen-Kontrolle KW ${kw}/${jahr}`, marginX, 14);
  doc.setFontSize(9);
  doc.setTextColor(100, 112, 124); // TEXT_MUTED
  doc.text(`${vonLabel} – ${bisLabel}`, marginX, 20);

  let cursorY = 27;

  bloecke.forEach((b) => {
    // Platz für Blockkopf + mind. eine Tabellenzeile prüfen, sonst neue Seite.
    if (cursorY > doc.internal.pageSize.getHeight() - 30) {
      doc.addPage();
      cursorY = 15;
    }

    const [r, g, bch] = hexToRgbArray(lkwBlockColorHex(b.plate));
    doc.setFillColor(r, g, bch);
    doc.rect(marginX, cursorY, pageWidth - marginX * 2, 8, "F");
    doc.setFontSize(10);
    doc.setTextColor(22, 35, 46); // TEXT
    doc.setFont(undefined, "bold");
    doc.text(`${b.plate}  ·  ${b.fahrer || "– kein Fahrer –"}  ·  ${b.status}`, marginX + 2, cursorY + 5.5);
    doc.setFont(undefined, "normal");
    doc.setFontSize(8);
    const kmInfo = `Start-KM ${b.startKm !== null ? b.startKm.toLocaleString("de-DE") : "–"}   ` +
      `Ende-KM ${b.endKm !== null ? b.endKm.toLocaleString("de-DE") : "–"}   ` +
      `KM-Woche ${b.wochenKm !== null ? b.wochenKm.toLocaleString("de-DE") + " km" : "–"}   ` +
      `Einsatztage ${b.einsatztage}   Ø/Tag ${euro(b.proTag)}`;
    doc.text(kmInfo, pageWidth - marginX - 2, cursorY + 5.5, { align: "right" });
    cursorY += 11;

    if (b.touren.length === 0) {
      doc.setFontSize(8.5);
      doc.setTextColor(100, 112, 124);
      doc.text(b.status !== "Aktiv" ? `Status: ${b.status}` : "Keine Touren erfasst.", marginX + 2, cursorY);
      cursorY += 8;
      return;
    }

    const body = b.touren.map((t) => [
      formatDateDMY(t.datum), t.fahrer || "", t.kunde || "", t.auftragsNr || "",
      t.ankunft || "", t.abfahrt || "",
      ...COSTFIELDS.map((k) => euro(t[k])),
      euro(gesamt(t)), t.status || "",
    ]);
    body.push(["", "", "", "", "", "", "", "", "", "", "", "", "Summe", euro(b.summe), ""]);

    autoTable(doc, {
      head: [PDF_HEAD],
      body,
      startY: cursorY,
      margin: { left: marginX, right: marginX },
      styles: { fontSize: 6.8, cellPadding: 1.3, textColor: [22, 35, 46] },
      headStyles: { fillColor: [15, 42, 67], textColor: [242, 166, 60], fontStyle: "bold" },
      columnStyles: {
        6: { halign: "right" }, 7: { halign: "right" }, 8: { halign: "right" },
        9: { halign: "right" }, 10: { halign: "right" }, 11: { halign: "right" },
        12: { halign: "right" }, 13: { halign: "right", fontStyle: "bold" },
      },
      didParseCell: (data) => {
        // Summenzeile fett hervorheben (letzte Zeile im Body).
        if (data.section === "body" && data.row.index === body.length - 1) {
          data.cell.styles.fontStyle = "bold";
        }
      },
    });
    cursorY = doc.lastAutoTable.finalY + 8;
  });

  doc.save(`Wochenkontrolle_KW${String(kw).padStart(2, "0")}_${jahr}.pdf`);
}

/**
 * Exportiert die Wochen-Kontrolle der übergebenen Woche als Excel-Datei
 * (ein Arbeitsblatt, LKW-Blöcke untereinander - angelehnt an die alten
 * KW-Wochenblätter).
 */
export async function exportWochenkontrolleExcel({ jahr, kw, vonLabel, bisLabel, bloecke }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Tourenliste-App";
  wb.created = new Date();
  const ws = wb.addWorksheet(`KW${String(kw).padStart(2, "0")}-${jahr}`, {
    views: [{ state: "frozen", ySplit: 0 }],
  });

  const headLabels = PDF_HEAD; // gleiche Spaltenüberschriften wie im PDF
  ws.columns = [
    { width: 11 }, { width: 16 }, { width: 22 }, { width: 16 }, { width: 9 }, { width: 9 },
    { width: 11 }, { width: 9 }, { width: 9 }, { width: 11 }, { width: 11 }, { width: 9 },
    { width: 10 }, { width: 12 }, { width: 13 },
  ];

  ws.mergeCells(1, 1, 1, headLabels.length);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `Wochen-Kontrolle KW ${kw}/${jahr}  (${vonLabel} – ${bisLabel})`;
  titleCell.font = { bold: true, size: 13, color: { argb: "FF0F2A43" } };
  ws.getRow(1).height = 22;

  let rowIdx = 3;

  bloecke.forEach((b) => {
    ws.mergeCells(rowIdx, 1, rowIdx, headLabels.length);
    const headRow = ws.getRow(rowIdx);
    headRow.getCell(1).value =
      `${b.plate}   ·   ${b.fahrer || "– kein Fahrer –"}   ·   ${b.status}   ·   ` +
      `Start-KM ${b.startKm !== null ? b.startKm.toLocaleString("de-DE") : "–"}   ` +
      `Ende-KM ${b.endKm !== null ? b.endKm.toLocaleString("de-DE") : "–"}   ` +
      `KM-Woche ${b.wochenKm !== null ? b.wochenKm.toLocaleString("de-DE") + " km" : "–"}   ` +
      `Einsatztage ${b.einsatztage}   Ø/Tag ${euro(b.proTag)}`;
    headRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + lkwBlockColorHex(b.plate) } };
      cell.font = { bold: true, size: 10, color: { argb: "FF16232E" } };
    });
    headRow.height = 18;
    rowIdx += 1;

    if (b.touren.length === 0) {
      ws.getCell(rowIdx, 1).value = b.status !== "Aktiv" ? `Status: ${b.status}` : "Keine Touren erfasst.";
      ws.getCell(rowIdx, 1).font = { italic: true, color: { argb: "FF64707C" } };
      rowIdx += 2;
      return;
    }

    const tableHeadRow = ws.getRow(rowIdx);
    headLabels.forEach((label, i) => { tableHeadRow.getCell(i + 1).value = label; });
    tableHeadRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFF2A63C" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F2A43" } };
    });
    rowIdx += 1;

    b.touren.forEach((t) => {
      const row = ws.getRow(rowIdx);
      row.getCell(1).value = formatDateDMY(t.datum);
      row.getCell(2).value = t.fahrer || "";
      row.getCell(3).value = t.kunde || "";
      row.getCell(4).value = t.auftragsNr || "";
      row.getCell(5).value = t.ankunft || "";
      row.getCell(6).value = t.abfahrt || "";
      COSTFIELDS.forEach((k, i) => {
        const cell = row.getCell(7 + i);
        cell.value = Number(t[k]) || 0;
        cell.numFmt = '#,##0.00 "€"';
      });
      const gesamtCell = row.getCell(14);
      gesamtCell.value = gesamt(t);
      gesamtCell.numFmt = '#,##0.00 "€"';
      gesamtCell.font = { bold: true };
      const statusCell = row.getCell(15);
      statusCell.value = t.status || "";
      const sc = statusColorsHex(t.status);
      statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + sc.bg } };
      statusCell.font = { color: { argb: "FF" + sc.text }, bold: true };
      rowIdx += 1;
    });

    const sumRow = ws.getRow(rowIdx);
    sumRow.getCell(13).value = "Summe";
    sumRow.getCell(13).font = { bold: true };
    sumRow.getCell(13).alignment = { horizontal: "right" };
    const sumCell = sumRow.getCell(14);
    sumCell.value = b.summe;
    sumCell.numFmt = '#,##0.00 "€"';
    sumCell.font = { bold: true };
    rowIdx += 2;
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  downloadBlob(blob, `Wochenkontrolle_KW${String(kw).padStart(2, "0")}_${jahr}.xlsx`);
}
