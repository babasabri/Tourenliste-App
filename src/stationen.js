// Korrekturen für Stationsnamen beim Import von Tankrechnungen (Tankpool und Shell).
// Auf den Rechnungen sind Namen teils gekürzt oder mit Zusätzen versehen
// (z. B. "Aschaffenbur", "DIETZENBACH, JU"). Hier auf den gewünschten Namen setzen.
const STATION_KORREKTUR = {
  Aschaffenbur: "Aschaffenburg",
  "DIETZENBACH, JU": "Dietzenbach",
};

export function stationKorrigieren(name) {
  const n = String(name || "").trim();
  return STATION_KORREKTUR[n] || n;
}
