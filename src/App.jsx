import { useState, useEffect, useMemo } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import {
  LayoutDashboard, Truck, PlusCircle, Search as SearchIcon, Users,
  Fuel, X, Save, Trash2, Pencil, AlertTriangle, CalendarClock, Upload, ListChecks, RefreshCw,
  TrendingUp, MapPin,
} from "lucide-react";
import * as db from "./db";

const MARINE = "#0F2A43";
const MARINE_LIGHT = "#1B4467";
const AMBER = "#F2A63C";
const AMBER_DARK = "#8A5A10";
const BG = "#F5F6F8";
const CARD = "#FFFFFF";
const BORDER = "#E1E6EC";
const TEXT = "#16232E";
const TEXT_MUTED = "#64707C";
const DANGER = "#C4573F";
const DANGER_BG = "#FBE9E5";
const SUCCESS = "#2F8F6B";
const WARN_BG = "#FDF1DD";

const MONTHS = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];

// Für Tabellenzellen mit fester Spaltenbreite (table-layout:fixed): lange Werte
// werden mit "…" abgeschnitten statt die Spalte zu sprengen (voller Wert steht
// im title-Tooltip).
const ellipsisCell = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

// Liefert das lokale Datum (Jahr-Monat-Tag) als YYYY-MM-DD, OHNE über UTC zu
// gehen. d.toISOString() rechnet erst in UTC um - für Zeitzonen vor UTC (z. B.
// Deutschland, MEZ/MESZ) kippt das ein lokales Datum auf den Vortag, sobald man
// von einem lokalen Mitternachts-Zeitpunkt ausgeht (z. B. in shiftWeek). Deshalb
// hier bewusst mit den lokalen Date-Komponenten statt mit toISOString() bauen.
function pad2(n) { return String(n).padStart(2, "0"); }
function toLocalISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isoWeek(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const diff = target - firstThursday;
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

function isoWeekYear(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  return target.getFullYear();
}

// Montag der angegebenen ISO-Kalenderwoche als Date-Objekt (gleiche Rechnung
// wie in shiftWeek: der 4. Januar liegt immer in KW1 des Jahres).
function isoWeekMonday(jahr, kw) {
  const d = new Date(jahr, 0, 4);
  const dayNr = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dayNr + (kw - 1) * 7);
  return d;
}
function formatDateShort(d) {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.`;
}

// Wandelt ein ISO-Datum (YYYY-MM-DD, wie es <input type="date"> und Supabase
// liefern) für die Anzeige in das gewünschte deutsche Format DD.MM.YYYY um.
// Die zugrunde liegenden Werte (State, Datenbank, <input type="date">) bleiben
// bewusst im ISO-Format - nur die Darstellung ändert sich.
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

function uid() {
  // Echte UUID statt kurzer Zufalls-Strings - die id-Spalten in Supabase
  // sind vom Typ uuid, das muss also zusammenpassen.
  return crypto.randomUUID();
}

const emptyForm = {
  datum: "", lkw: "", fahrer: "", auftragsNr: "", containerNr: "",
  kunde: "", plz: "", ort: "", ankunft: "", abfahrt: "", km: "",
  fracht: "", fd: "", adr: "", multistop: "", wartezeit: "", maut: "", diesel: "",
  bemerkungen: "", status: "",
};

const COSTFIELDS = ["fracht", "fd", "adr", "multistop", "wartezeit", "maut", "diesel"];
const COSTFIELD_LABELS = {
  fracht: "Fracht", fd: "FD", adr: "ADR", multistop: "Multistop",
  wartezeit: "Wartezeit", maut: "Maut", diesel: "Diesel",
};

// Pflichtfelder: eine Tour darf nur gespeichert werden, wenn all diese Felder
// ausgefüllt sind. Kostenfelder (außer Fracht/Maut/Diesel, s. Vorschlagswerte)
// und Bemerkungen bleiben bewusst optional, da sie nicht bei jeder Tour anfallen.
const REQUIRED_FIELDS = [
  { key: "datum", label: "Datum" },
  { key: "lkw", label: "LKW" },
  { key: "fahrer", label: "Fahrer" },
  { key: "auftragsNr", label: "Auftrags-Nr." },
  { key: "containerNr", label: "Container-Nr." },
  { key: "kunde", label: "Kunde" },
  { key: "plz", label: "PLZ" },
  { key: "ort", label: "Ort" },
  { key: "ankunft", label: "Ankunft" },
  { key: "abfahrt", label: "Abfahrt" },
  { key: "km", label: "Abrechnungs-KM" },
  { key: "status", label: "Status" },
];

function getMissingFields(t) {
  return REQUIRED_FIELDS.filter(({ key }) => {
    const v = t[key];
    return v === undefined || v === null || String(v).trim() === "";
  }).map(({ key }) => key);
}

function missingLabel(keys) {
  return REQUIRED_FIELDS.filter((f) => keys.includes(f.key)).map((f) => f.label).join(", ");
}

function fieldStyle(key, errors) {
  return errors.includes(key) ? { borderColor: DANGER, background: DANGER_BG } : undefined;
}

// Status-Auswahl soll immer farbig erkennbar sein (wie die Status-Badges in
// den Tabellen) - bei fehlendem Wert greift wie gewohnt die Fehler-Markierung.
function statusFieldStyle(status, errors) {
  if (status) {
    const sc = statusColors(status);
    return { background: sc.bg, color: sc.text, fontWeight: 700, borderColor: sc.text };
  }
  return fieldStyle("status", errors);
}

// Preisreferenz für "Neue Tour" (Infobox rechts). Reine Anzeige/Hilfe - wird
// nirgends automatisch verrechnet, damit falsch übertragene Sätze im
// Frachtbrief nicht unbemerkt einfließen.
// Vorbelegung der Stammdaten (nur wirksam, solange noch keine eigenen Daten
// gespeichert sind - siehe Ladelogik in useEffect). Miet-LKW werden über das
// note-Feld gekennzeichnet und in Stammdaten als Badge angezeigt.
const SEED_FLEET = [
  { plate: "OF RY 500", driver: "", startKm: 707322, startKmDatum: "2026-01-01", note: "", startKmHistory: [] },
  { plate: "OF RY 700", driver: "", startKm: 682273, startKmDatum: "2026-01-01", note: "", startKmHistory: [] },
  { plate: "OF RY 750", driver: "", startKm: 497576, startKmDatum: "2026-01-01", note: "", startKmHistory: [] },
  { plate: "OF RY 800", driver: "", startKm: 490037, startKmDatum: "2026-01-01", note: "", startKmHistory: [] },
  { plate: "OF RY 850", driver: "", startKm: 436746, startKmDatum: "2026-01-01", note: "", startKmHistory: [] },
  { plate: "B-CY 3552", driver: "", startKm: 11013, startKmDatum: "2026-07-27", note: "Miet-LKW", startKmHistory: [] },
];

// Feste Blockfarben je LKW für die Wochen-Kontrolle, übernommen aus den
// LKW-Blockköpfen der Original-Excel (KW-Wochenblätter). Miet-LKW (ohne
// eigene Farbe in der Excel, dort gemeinsam als "Miet-LKW" geführt) sowie
// künftig neu angelegte Fahrzeuge bekommen die neutrale Grau-Farbe.
const LKW_BLOCK_COLORS = {
  "OF RY 500": "#B8CCE4",
  "OF RY 700": "#C6D6BE",
  "OF RY 750": "#E0D3B8",
  "OF RY 800": "#CFC6DA",
  "OF RY 850": "#B7D6D3",
  "B-CY 3552": "#D2D2D2",
};
function lkwBlockColor(plate) {
  return LKW_BLOCK_COLORS[plate] || "#E4E7EB";
}

const SEED_DRIVERS = ["Serdar", "Dawid", "Gregor", "Patryk", "Artur", "Sabri", "Hakan", "Özgür", "Ersatzfahrer"];

// range = Anzeige in der Infobox, max/betrag = Grundlage für die automatische
// Fracht-Berechnung aus dem Abrechnungs-KM-Feld (siehe calcFracht).
const STAFFELRATEN = [
  { range: "01 – 20", max: 20, betrag: 122 },
  { range: "21 – 30", max: 30, betrag: 142 },
  { range: "31 – 40", max: 40, betrag: 158 },
  { range: "41 – 50", max: 50, betrag: 173 },
  { range: "51 – 60", max: 60, betrag: 190 },
  { range: "61 – 70", max: 70, betrag: 209 },
  { range: "71 – 80", max: 80, betrag: 220 },
  { range: "81 – 90", max: 90, betrag: 233 },
  { range: "91 – 100", max: 100, betrag: 244 },
  { range: "101 – 110", max: 110, betrag: 255 },
];
// Ab KM 111: Grundbetrag der letzten Staffel (255 €, bis 110 KM) plus die
// restlichen KM mit diesem Satz je KM.
const STAFFEL_KM_PREIS = 2.4;

// Fracht automatisch aus den Staffelraten berechnen, sobald Abrechnungs-KM
// eingetragen wird (siehe "Neue Tour"/"Tour bearbeiten"). Bis 110 KM gilt der
// passende Staffel-Betrag, ab 111 KM der Grundbetrag der letzten Staffel plus
// die darüber hinausgehenden KM à 2,40 €.
function calcFracht(km) {
  const k = Number(km);
  if (!k || k <= 0) return "";
  const letzteStaffel = STAFFELRATEN[STAFFELRATEN.length - 1];
  let betrag;
  if (k <= letzteStaffel.max) {
    const bracket = STAFFELRATEN.find((s) => k <= s.max);
    betrag = bracket ? bracket.betrag : letzteStaffel.betrag;
  } else {
    betrag = letzteStaffel.betrag + (k - letzteStaffel.max) * STAFFEL_KM_PREIS;
  }
  return Math.round(betrag * 100) / 100;
}

const TERMINALRATEN = [
  { terminal: "Frankfurt-Ost (DBI / TFG / Contargo)", betrag: "50,00", note: "inkl. Maut, TFS" },
  { terminal: "Mainz / Gustavsburg", betrag: "65,00", note: "inkl. Maut, TFS" },
  { terminal: "Ludwigshafen / Mannheim", betrag: "240,00", note: "inkl. Maut, TFS" },
  { terminal: "Koblenz", betrag: "250,00", note: "inkl. Maut, TFS" },
  { terminal: "Germersheim", betrag: "260,00", note: "nur bei Fremddepot" },
];

// Farbige Kopfzeile + Icon-Badge für die reinen Info-/Referenzboxen (Staffelraten,
// Terminal-Pauschalen, Diesel-Index) - rein optisch, damit diese von den
// eigentlichen Eingabe-Karten unterscheidbar sind und die Ansicht insgesamt
// weniger eintönig wirkt.
function InfoBoxHeader({ icon: Icon, badgeBg, iconColor, title }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
      <div style={{
        width: 30, height: 30, borderRadius: 8, background: badgeBg, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Icon size={15} color={iconColor} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: MARINE }}>{title}</div>
    </div>
  );
}

function RatesInfoBox() {
  return (
    <>
      <div style={{ flex: "1 1 260px", minWidth: 240, background: CARD, border: `1px solid ${BORDER}`, borderTop: `3px solid ${AMBER}`, borderRadius: 12, padding: 18 }}>
        <InfoBoxHeader icon={TrendingUp} badgeBg={AMBER} iconColor={AMBER_DARK} title="Staffelraten" />
        <div style={{ fontSize: 11, color: TEXT_MUTED, marginBottom: 10 }}>einfache Entfernung gem. Frachtbrief</div>
        <table>
          <thead>
            <tr><th>KM</th><th style={{ textAlign: "right" }}>Betrag</th></tr>
          </thead>
          <tbody>
            {STAFFELRATEN.map((s) => (
              <tr key={s.range}>
                <td className="mono" style={{ fontSize: 12, padding: "6px 4px" }}>{s.range}</td>
                <td className="mono" style={{ fontSize: 12, padding: "6px 4px", textAlign: "right" }}>
                  € {s.betrag.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
            ))}
            <tr>
              <td className="mono" style={{ fontSize: 12, padding: "6px 4px" }}>ab km 111</td>
              <td className="mono" style={{ fontSize: 12, padding: "6px 4px", textAlign: "right" }}>€ 2,40</td>
            </tr>
            <tr>
              <td style={{ fontSize: 12, padding: "6px 4px", border: "none" }}>
                Maut
                <div style={{ fontSize: 10, color: TEXT_MUTED }}>pro Maut-km gem. Frachtbrief</div>
              </td>
              <td className="mono" style={{ fontSize: 12, padding: "6px 4px", textAlign: "right", border: "none" }}>€ 0,35</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style={{ flex: "1 1 260px", minWidth: 240, background: CARD, border: `1px solid ${BORDER}`, borderTop: `3px solid ${MARINE_LIGHT}`, borderRadius: 12, padding: 18 }}>
        <InfoBoxHeader icon={MapPin} badgeBg={MARINE_LIGHT} iconColor="#fff" title="Terminal-Pauschalen" />
        <table>
          <thead>
            <tr><th>Terminal</th><th style={{ textAlign: "right" }}>Betrag</th></tr>
          </thead>
          <tbody>
            {TERMINALRATEN.map((t, i) => (
              <tr key={t.terminal}>
                <td style={{ fontSize: 12, padding: "6px 4px", border: i === TERMINALRATEN.length - 1 ? "none" : undefined }}>
                  {t.terminal}
                  {t.note && <div style={{ fontSize: 10, color: TEXT_MUTED }}>{t.note}</div>}
                </td>
                <td className="mono" style={{ fontSize: 12, padding: "6px 4px", textAlign: "right", border: i === TERMINALRATEN.length - 1 ? "none" : undefined }}>
                  € {t.betrag}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Farbige Seitenüberschrift je Tab (Icon-Badge in Marine + Titel/Subtitel),
// passend zum Farbschema der App (Kopfleiste/Amber-Akzent) statt einer
// reinen Textzeile - macht die einzelnen Ansichten auf den ersten Blick
// unterscheidbar.
function PageHeading({ icon: Icon, title, subtitle }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, background: MARINE, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <Icon size={18} color={AMBER} />
      </div>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: MARINE, letterSpacing: 0.1 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 1 }}>{subtitle}</div>}
      </div>
    </div>
  );
}

function gesamt(t) {
  return COSTFIELDS.reduce((sum, k) => sum + (Number(t[k]) || 0), 0);
}

// Farben 1:1 aus der Original-Excel übernommen (bedingte Formatierung je
// Status-Wert in den KW-Wochenblättern): Offen = Gelb, Reklamiert = Orange,
// Abgerechnet = Grün. Werden sowohl für den Zeilenhintergrund der
// Touren-Tabellen als auch für den Status-Text selbst verwendet.
function statusColors(status) {
  if (status === "Reklamiert") return { bg: "#FF9966", text: "#7A2E00" };
  if (status === "Abgerechnet") return { bg: "#99FF99", text: "#1B5E20" };
  return { bg: "#FFFF99", text: "#6B5900" };
}

export default function TourenApp() {
  const [tours, setTours] = useState([]);
  const [fleet, setFleet] = useState([]);
  const [einsatz, setEinsatz] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [form, setForm] = useState(emptyForm);
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [search, setSearch] = useState({ nr: "", containerNr: "", kunde: "", plz: "", ort: "", lkw: "", status: "" });
  // Suche: id der Tour, deren Status gerade per Schnellauswahl geändert wird
  // (Klick auf "Status ändern" neben "Bearbeiten") - ohne das volle
  // Bearbeiten-Fenster zu öffnen.
  const [quickStatusId, setQuickStatusId] = useState(null);
  // Touren-Tab: Monatsfilter oberhalb der Liste.
  const [tourenMonat, setTourenMonat] = useState("ALLE");
  const [dashFilters, setDashFilters] = useState({
    jahr: "ALLE", lkw: "ALLE", fahrer: "ALLE", monat: "ALLE", kw: "ALLE",
    von: "", bis: "",
  });
  const [saveNote, setSaveNote] = useState("");
  const [dupWarning, setDupWarning] = useState(null);
  const [newPlate, setNewPlate] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const [newDriver, setNewDriver] = useState("");
  const [newStartKm, setNewStartKm] = useState("");
  const [newStartKmDatum, setNewStartKmDatum] = useState("");
  const [editingStartKm, setEditingStartKm] = useState(null);
  const [editKmValue, setEditKmValue] = useState("");
  const [editKmDatum, setEditKmDatum] = useState("");
  const [confirmingKmChange, setConfirmingKmChange] = useState(false);
  const [expandedKmHistory, setExpandedKmHistory] = useState({});
  const [newMiete, setNewMiete] = useState(false);
  const [confirmDeleteFleet, setConfirmDeleteFleet] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [newDriverName, setNewDriverName] = useState("");
  const [confirmDeleteDriver, setConfirmDeleteDriver] = useState(null);
  const [storageError, setStorageError] = useState("");
  const [formErrors, setFormErrors] = useState([]);
  const [editErrors, setEditErrors] = useState([]);
  const [editSaveNote, setEditSaveNote] = useState("");
  const [dieselIndex, setDieselIndex] = useState([]);
  const [diJahr, setDiJahr] = useState(new Date().getFullYear());
  const [diMonat, setDiMonat] = useState(new Date().getMonth() + 1);
  const [diBetrag, setDiBetrag] = useState("");
  const [confirmDeleteDiesel, setConfirmDeleteDiesel] = useState(null);
  const today = toLocalISODate(new Date());
  const [epJahr, setEpJahr] = useState(isoWeekYear(today));
  const [epKw, setEpKw] = useState(isoWeek(today));
  // Lokaler Entwurf der aktuell angezeigten Einsatzplan-Woche: Eingaben landen
  // erst hier (kein Netzwerk-Call pro Tastendruck) und werden erst beim Klick
  // auf "Speichern" tatsächlich in Supabase geschrieben.
  const [epDraft, setEpDraft] = useState({});
  const [epDirty, setEpDirty] = useState(false);
  const [epSaving, setEpSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [t, f, ep, di, dr] = await Promise.all([
          db.fetchTours(),
          db.fetchFleet(),
          db.fetchEinsatzplan(),
          db.fetchDieselIndex(),
          db.fetchDrivers(),
        ]);
        setTours(t);
        setEinsatz(ep);
        setDieselIndex(di);

        // Fuhrpark/Fahrer: wenn in der Datenbank noch nichts steht, mit den
        // vorgegebenen Stammdaten vorbefüllen (statt leer zu starten) - genau
        // wie zuvor im Prototyp, nur dass jetzt echte Zeilen angelegt werden.
        if (f.length > 0) {
          setFleet(f);
        } else {
          setFleet(await db.seedFleet(SEED_FLEET));
        }

        if (dr.length > 0) {
          setDrivers(dr);
        } else {
          setDrivers(await db.seedDrivers(SEED_DRIVERS));
        }
      } catch (e) {
        setStorageError("Daten konnten nicht geladen werden. Bitte Seite neu laden. (" + e.message + ")");
      }
      setLoaded(true);
    })();
  }, []);

  // Entwurf für die Einsatzplan-Woche neu aufbauen, sobald Jahr/KW wechselt
  // oder die Fahrzeugliste sich ändert (neuer LKW in Stammdaten). Bewusst
  // NICHT von `einsatz` abhängig - sonst würde jeder eigene Save mitten in
  // der Bearbeitung den Entwurf zurücksetzen.
  useEffect(() => {
    const initial = {};
    fleet.forEach((f) => {
      const rec = getEinsatz(epJahr, epKw, f.plate);
      initial[f.plate] = {
        fahrer: rec ? rec.fahrer : "",
        status: rec ? rec.status : "Aktiv",
        endKm: rec && rec.endKm !== undefined ? rec.endKm : "",
      };
    });
    setEpDraft(initial);
    setEpDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epJahr, epKw, fleet]);

  function setEpDraftField(plate, field, value) {
    setEpDraft((d) => ({ ...d, [plate]: { ...d[plate], [field]: value } }));
    setEpDirty(true);
  }

  // Schreibt den kompletten Entwurf der angezeigten Woche in einem Rutsch nach
  // Supabase (alle LKW-Zeilen der Woche, nicht nur die geänderten - das ist
  // unkritisch, weil syncEinsatzplan ohnehin ein Upsert macht und der Entwurf
  // für unangetastete Zeilen exakt dem zuletzt gespeicherten Stand entspricht).
  // Alle anderen Wochen im einsatz-Array bleiben unangetastet.
  async function saveEinsatzWeek() {
    setEpSaving(true);
    setStorageError("");
    const rows = fleet.map((f) => {
      const draft = epDraft[f.plate] || {};
      return { jahr: epJahr, kw: epKw, lkw: f.plate, fahrer: draft.fahrer || "", status: draft.status || "Aktiv", endKm: draft.endKm };
    });
    const otherWeeks = einsatz.filter((e) => !(e.jahr === epJahr && e.kw === epKw));
    try {
      setEinsatz(await db.syncEinsatzplan([...otherWeeks, ...rows]));
      setEpDirty(false);
    } catch (e) {
      setStorageError("Speichern fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setEpSaving(false);
    }
  }

  async function persistTours(next) {
    setStorageError("");
    try {
      setTours(await db.syncTours(tours, next));
    } catch (e) {
      setStorageError("Speichern fehlgeschlagen. Bitte Seite neu laden und die letzte Änderung erneut vornehmen.");
    }
  }

  function handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!Array.isArray(parsed)) throw new Error("Keine Liste gefunden");
        setImportPreview(parsed);
        setImportStatus(`${parsed.length} Touren in der Datei gefunden. Prüfen und bestätigen.`);
      } catch (err) {
        setImportStatus("Datei konnte nicht gelesen werden: " + err.message);
        setImportPreview(null);
      }
    };
    reader.readAsText(file);
  }

  async function confirmImport() {
    if (!importPreview) return;
    // Duplikat-Erkennung nur, wenn eine echte Auftrags-Nr. vorhanden ist -
    // sonst wuerden mehrere Touren ohne Nummer am selben Tag/LKW faelschlich
    // als "gleiche Tour" zusammenfallen und verloren gehen.
    // Normalisierung (trim + lowercase) muss zur Prüfung in handleSave passen,
    // sonst würden zwei Schreibweisen derselben Nummer (z.B. "AB-12" vs "ab-12")
    // beim Import nicht als Duplikat erkannt.
    const normKey = (t) => `${t.datum}|${t.lkw}|${(t.auftragsNr || "").trim().toLowerCase()}`;
    const existingKeys = new Set(tours.filter((t) => t.auftragsNr).map(normKey));
    let added = 0, skipped = 0;
    const withIds = [];
    for (const raw of importPreview) {
      if (raw.auftragsNr) {
        const key = normKey(raw);
        if (existingKeys.has(key)) {
          skipped++;
          continue;
        }
        existingKeys.add(key);
      }
      withIds.push({ ...emptyForm, ...raw, id: uid() });
      added++;
    }
    setStorageError("");
    setImportStatus(`Importiere ${added} Touren …`);
    try {
      // Bulk-Insert statt persistTours: bei einem großen Import (hunderte/
      // tausende Zeilen) wäre der zeilenweise Abgleich in persistTours
      // unnötig langsam, da dort ohnehin nur neue Zeilen hinzukommen.
      setTours(await db.insertTours(withIds));
    } catch (e) {
      setImportStatus("Import fehlgeschlagen: " + e.message);
      return;
    }
    setImportStatus(`Import fertig: ${added} neue Touren übernommen, ${skipped} übersprungen (bereits vorhanden - gleiches Datum/LKW/Auftrags-Nr.).`);
    setImportPreview(null);
  }

  async function persistFleet(next) {
    setStorageError("");
    try {
      setFleet(await db.syncFleet(fleet, next));
    } catch (e) {
      setStorageError("Speichern fehlgeschlagen. Bitte Seite neu laden und die letzte Änderung erneut vornehmen.");
    }
  }

  // Start-KM ist eine feste Referenzgröße für die Wochen-KM-Berechnung und soll
  // nicht aus Versehen überschrieben/gelöscht werden können. Deshalb: Anzeige
  // standardmäßig gesperrt (Text), Bearbeiten nur über Stift-Icon, jede
  // tatsächliche Änderung braucht eine explizite Bestätigung und wird mit altem
  // Wert + Datum protokolliert statt still überschrieben zu werden.
  function startEditKm(f) {
    setEditingStartKm(f.plate);
    setEditKmValue(f.startKm === undefined || f.startKm === "" ? "" : f.startKm);
    setEditKmDatum(f.startKmDatum || "");
    setConfirmingKmChange(false);
  }

  function cancelEditKm() {
    setEditingStartKm(null);
    setConfirmingKmChange(false);
  }

  function requestKmSave(f) {
    const changed = String(editKmValue) !== String(f.startKm ?? "") || editKmDatum !== (f.startKmDatum || "");
    if (!changed) {
      cancelEditKm();
      return;
    }
    setConfirmingKmChange(true);
  }

  function confirmKmSave(f) {
    const entry = {
      id: uid(),
      from: f.startKm === undefined ? "" : f.startKm,
      fromDatum: f.startKmDatum || "",
      to: editKmValue,
      toDatum: editKmDatum,
      changedAt: toLocalISODate(new Date()),
    };
    const history = [...(f.startKmHistory || []), entry];
    persistFleet(fleet.map((x) =>
      x.plate === f.plate ? { ...x, startKm: editKmValue, startKmDatum: editKmDatum, startKmHistory: history } : x
    ));
    cancelEditKm();
  }

  async function persistDieselIndex(next) {
    setStorageError("");
    try {
      setDieselIndex(await db.syncDieselIndex(dieselIndex, next));
    } catch (e) {
      setStorageError("Speichern fehlgeschlagen. Bitte Seite neu laden und die letzte Änderung erneut vornehmen.");
    }
  }

  // Jeder Eintrag bleibt erhalten, auch wenn für denselben Monat/Jahr bereits
  // ein Wert existiert - der Nutzer will den Verlauf je Monat lückenlos im
  // Blick behalten, nichts wird beim Speichern stillschweigend überschrieben.
  function addDieselIndex() {
    if (diBetrag === "" || diBetrag === null) return;
    const jahr = Number(diJahr), monat = Number(diMonat);
    persistDieselIndex([...dieselIndex, { id: uid(), jahr, monat, betrag: diBetrag }]);
    setDiBetrag("");
  }

  async function persistDrivers(next) {
    setStorageError("");
    try {
      setDrivers(await db.syncDrivers(drivers, next));
    } catch (e) {
      setStorageError("Speichern fehlgeschlagen. Bitte Seite neu laden und die letzte Änderung erneut vornehmen.");
    }
  }

  function addDriver() {
    const name = newDriverName.trim();
    if (!name) return;
    if (drivers.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
      setNewDriverName("");
      return;
    }
    persistDrivers([...drivers, { id: uid(), name }]);
    setNewDriverName("");
  }

  function getEinsatz(jahr, kw, plate) {
    return einsatz.find((e) => e.jahr === jahr && e.kw === kw && e.lkw === plate);
  }

  function weekKey(jahr, kw) {
    return jahr * 100 + kw;
  }

  // Springt im Einsatzplan um `delta` Wochen (±1) weiter, über ein echtes Datum
  // gerechnet, damit Jahreswechsel und KW52/53 korrekt behandelt werden.
  function shiftWeek(delta) {
    const d = new Date(epJahr, 0, 4); // 4. Januar liegt immer in KW1 des Jahres
    const dayNr = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dayNr + (epKw - 1) * 7 + delta * 7); // Montag der Zielwoche
    const iso = toLocalISODate(d);
    setEpJahr(isoWeekYear(iso));
    setEpKw(isoWeek(iso));
  }

  function computeStartKm(jahr, kw, plate) {
    const key = weekKey(jahr, kw);
    const priorWithEndKm = einsatz
      .filter((e) => e.lkw === plate && e.endKm !== undefined && e.endKm !== "" && weekKey(e.jahr, e.kw) < key)
      .sort((a, b) => weekKey(b.jahr, b.kw) - weekKey(a.jahr, a.kw));
    if (priorWithEndKm.length > 0) return Number(priorWithEndKm[0].endKm);
    const v = fleet.find((f) => f.plate === plate);
    return v && v.startKm !== undefined && v.startKm !== "" ? Number(v.startKm) : null;
  }

  function lastTourFor(kunde) {
    if (!kunde) return null;
    const matches = tours.filter((t) => (t.kunde || "").toLowerCase() === kunde.toLowerCase());
    if (!matches.length) return null;
    return matches.reduce((a, b) => (a.datum > b.datum ? a : b));
  }

  // Diesel-Index-Betrag für einen bestimmten Monat/Jahr - falls für denselben
  // Monat mehrere Einträge erfasst wurden (bewusst nie überschrieben, siehe
  // addDieselIndex), zählt der zuletzt erfasste (jüngstes created_at).
  function dieselIndexFor(jahr, monat) {
    if (!jahr || !monat) return null;
    const matches = dieselIndex.filter((d) => Number(d.jahr) === Number(jahr) && Number(d.monat) === Number(monat));
    if (!matches.length) return null;
    const latest = matches.reduce((a, b) => (new Date(b.createdAt) > new Date(a.createdAt) ? b : a));
    return Number(latest.betrag);
  }

  // Diesel automatisch aus dem Diesel-Index des Monats/Jahres der Tour
  // berechnen, abgerechnet je angefangene 10 KM (aufgerundet).
  function calcDiesel(km, datum) {
    const k = Number(km);
    if (!k || k <= 0 || !datum) return "";
    const rate = dieselIndexFor(Number(datum.slice(0, 4)), Number(datum.slice(5, 7)));
    if (rate === null) return "";
    const einheiten = Math.ceil(k / 10);
    return Math.round(einheiten * rate * 100) / 100;
  }

  function driverForPlate(plate) {
    const v = fleet.find((f) => f.plate === plate);
    return v ? v.driver : "";
  }

  function driverForWeek(plate, datum) {
    if (!plate) return "";
    if (datum) {
      const jahr = isoWeekYear(datum);
      const kw = isoWeek(datum);
      const rec = getEinsatz(jahr, kw, plate);
      if (rec && rec.fahrer) return rec.fahrer;
    }
    return driverForPlate(plate);
  }

  // autoFillFahrer=true (Standard) überschreibt das Fahrer-Feld mit dem Vorschlag - so
  // wie es in "Neue Tour" gewünscht ist. Beim Bearbeiten einer bestehenden Tour (editForm)
  // wird false übergeben, damit ein bereits eingetragener, ggf. abweichender Fahrer nicht
  // versehentlich überschrieben wird, nur weil Datum oder LKW korrigiert werden.
  function handlePlateChange(plate, setter, current, autoFillFahrer = true) {
    setter({ ...current, lkw: plate, fahrer: autoFillFahrer ? driverForWeek(plate, current.datum) : current.fahrer });
  }

  function handleDatumChange(datum, setter, current, autoFillFahrer = true) {
    // Diesel hängt vom Monat der Tour ab (Diesel-Index) - bei bereits
    // eingetragenem KM wird er hier mit dem neuen Datum neu berechnet.
    const diesel = calcDiesel(current.km, datum);
    setter({
      ...current,
      datum,
      fahrer: autoFillFahrer && current.lkw ? driverForWeek(current.lkw, datum) : current.fahrer,
      ...(diesel !== "" ? { diesel } : {}),
    });
  }

  function doSaveTour() {
    // Status kommt jetzt aus dem Formular (Pflichtfeld) statt fest auf "Offen".
    const rec = { ...form, id: uid() };
    persistTours([rec, ...tours]);
    setForm(emptyForm);
    setFormErrors([]);
    setDupWarning(null);
    setSaveNote("Tour gespeichert.");
    setTimeout(() => setSaveNote(""), 2500);
  }

  function handleSave() {
    const missing = getMissingFields(form);
    if (missing.length > 0) {
      setFormErrors(missing);
      setSaveNote(`Bitte noch ausfüllen: ${missingLabel(missing)}`);
      return;
    }
    setFormErrors([]);
    if (form.auftragsNr) {
      const matches = tours.filter(
        (t) => t.auftragsNr && t.auftragsNr.trim().toLowerCase() === form.auftragsNr.trim().toLowerCase()
      );
      if (matches.length > 0) {
        setDupWarning(matches);
        return;
      }
    }
    doSaveTour();
  }

  function openEdit(t) {
    setEditId(t.id);
    setEditForm({ ...t });
    setConfirmDelete(false);
    setEditErrors([]);
    setEditSaveNote("");
  }

  function editFromWarning(t) {
    setDupWarning(null);
    openEdit(t);
  }

  function saveEdit() {
    const missing = getMissingFields(editForm);
    if (missing.length > 0) {
      setEditErrors(missing);
      setEditSaveNote(`Bitte noch ausfüllen: ${missingLabel(missing)}`);
      return;
    }
    setEditErrors([]);
    setEditSaveNote("");
    persistTours(tours.map((t) => (t.id === editId ? { ...editForm } : t)));
    setEditId(null);
    setEditForm(null);
  }

  function deleteTour(id) {
    persistTours(tours.filter((t) => t.id !== id));
    setEditId(null);
    setEditForm(null);
    setConfirmDelete(false);
  }

  // Schnellauswahl "Status ändern" in der Suche: ändert nur den Status,
  // ohne das Bearbeiten-Fenster zu öffnen.
  function quickChangeStatus(id, status) {
    persistTours(tours.map((t) => (t.id === id ? { ...t, status } : t)));
    setQuickStatusId(null);
  }

  const searchResults = useMemo(() => {
    const hasAny = Object.values(search).some(Boolean);
    if (!hasAny) return [];
    return tours.filter((t) => {
      if (search.nr && !(t.auftragsNr || "").toLowerCase().includes(search.nr.toLowerCase())) return false;
      if (search.containerNr && !(t.containerNr || "").toLowerCase().includes(search.containerNr.toLowerCase())) return false;
      if (search.kunde && !(t.kunde || "").toLowerCase().includes(search.kunde.toLowerCase())) return false;
      if (search.plz && !(t.plz || "").includes(search.plz)) return false;
      if (search.ort && !(t.ort || "").toLowerCase().includes(search.ort.toLowerCase())) return false;
      if (search.lkw && t.lkw !== search.lkw) return false;
      if (search.status && t.status !== search.status) return false;
      return true;
    });
  }, [tours, search]);

  // Reklamationen-Seite: alle noch nicht abgerechneten Touren (Offen + Reklamiert),
  // sortiert nach Datum. Sobald der Status auf "Abgerechnet" gesetzt wird (z.B. über
  // Suche -> Bearbeiten), fällt die Tour automatisch aus dieser Liste heraus.
  const reklamationTours = useMemo(() => {
    return tours
      .filter((t) => t.status === "Offen" || t.status === "Reklamiert")
      .slice()
      .sort((a, b) => (a.datum || "").localeCompare(b.datum || ""));
  }, [tours]);

  // Mini-Dashboard oben in Reklamationen: Anzahl + Summe je Status.
  const reklamationStats = useMemo(() => {
    const build = (status) => {
      const matches = tours.filter((t) => t.status === status);
      return { anzahl: matches.length, summe: matches.reduce((s, t) => s + gesamt(t), 0) };
    };
    return { offen: build("Offen"), reklamiert: build("Reklamiert") };
  }, [tours]);

  // Touren-Tab: Liste inkl. Monatsfilter, neueste zuerst.
  const tourenList = useMemo(() => {
    return tours
      .filter((t) => tourenMonat === "ALLE" || Number((t.datum || "").slice(5, 7)) === Number(tourenMonat))
      .slice()
      .sort((a, b) => (b.datum || "").localeCompare(a.datum || ""));
  }, [tours, tourenMonat]);

  const years = useMemo(() => {
    const s = new Set(tours.map((t) => (t.datum || "").slice(0, 4)).filter(Boolean));
    return Array.from(s).sort();
  }, [tours]);


  const allDrivers = useMemo(() => {
    const s = new Set();
    drivers.forEach((d) => d.name && s.add(d.name));
    fleet.forEach((f) => f.driver && s.add(f.driver));
    einsatz.forEach((e) => e.fahrer && s.add(e.fahrer));
    tours.forEach((t) => t.fahrer && s.add(t.fahrer));
    return Array.from(s).sort();
  }, [drivers, fleet, einsatz, tours]);

  // Fahrer-Auswahl in Einsatzplan, Neue Tour und beim Bearbeiten kommt bewusst
  // NUR aus der Stammdaten-Fahrerliste (nicht aus allDrivers) - kein freies
  // Eintippen mehr, damit Namen konsistent bleiben (z.B. für das Fahrer-Ranking).
  const driverOptions = useMemo(() => {
    return drivers.map((d) => d.name).sort((a, b) => a.localeCompare(b));
  }, [drivers]);

  // Einsatzplan frühere Wochen: alle Wochen, für die schon mindestens ein
  // Eintrag existiert (für den Schnellsprung-Dropdown), sowie eine flache
  // Verlaufstabelle aller Einsatzplan-Zeilen (für die Übersicht unter der
  // aktuell angezeigten Woche) - beides neueste zuerst.
  const weeksWithData = useMemo(() => {
    const set = new Set(einsatz.map((e) => `${e.jahr}-${e.kw}`));
    return Array.from(set)
      .map((k) => {
        const [jahr, kw] = k.split("-").map(Number);
        return { jahr, kw };
      })
      .sort((a, b) => (b.jahr * 100 + b.kw) - (a.jahr * 100 + a.kw));
  }, [einsatz]);

  const einsatzHistory = useMemo(() => {
    return einsatz
      .slice()
      .sort((a, b) => (b.jahr * 100 + b.kw) - (a.jahr * 100 + a.kw))
      .map((e) => {
        const startKm = computeStartKm(e.jahr, e.kw, e.lkw);
        const endKm = e.endKm !== undefined && e.endKm !== "" ? Number(e.endKm) : null;
        return { ...e, startKmVal: startKm, endKmVal: endKm, wochenKm: startKm !== null && endKm !== null ? endKm - startKm : null };
      });
  }, [einsatz, fleet]);

  // "Wochen-Kontrolle": Touren der ausgewählten Woche, gruppiert nach LKW - als
  // reine Kontrollansicht (angelehnt an die LKW-Blöcke der alten Excel-
  // Wochenblätter KW01-KW52), damit man auf einen Blick sieht, was pro LKW
  // für die Woche schon erfasst wurde. Nutzt dieselbe Wochenauswahl
  // (epJahr/epKw) wie der Einsatzplan, damit man beim Wechseln der Tabs in
  // derselben Woche bleibt.
  const wochenBloecke = useMemo(() => {
    const weekTours = tours.filter(
      (t) => t.datum && isoWeekYear(t.datum) === epJahr && isoWeek(t.datum) === epKw
    );
    return fleet.map((f) => {
      const rec = getEinsatz(epJahr, epKw, f.plate);
      const status = rec ? rec.status : "Aktiv";
      const fahrer = (rec && rec.fahrer) || f.driver || "";
      const touren = weekTours
        .filter((t) => t.lkw === f.plate)
        .sort((a, b) => (a.datum || "").localeCompare(b.datum || "") || (a.ankunft || "").localeCompare(b.ankunft || ""));
      const summe = touren.reduce((s, t) => s + gesamt(t), 0);
      // Start-/Ende-KM kommen aus dem Einsatzplan derselben Woche (wie in der
      // Wochen-KM-Berechnung dort) - Einsatztage/Ø pro Tag beziehen sich
      // bewusst auf die tatsächlich erfassten Touren dieser Woche (Kalendertage
      // mit mind. einer Tour), nicht auf die Wochen-KM.
      const startKm = computeStartKm(epJahr, epKw, f.plate);
      const endKm = rec && rec.endKm !== undefined && rec.endKm !== "" ? Number(rec.endKm) : null;
      const wochenKm = startKm !== null && endKm !== null ? endKm - startKm : null;
      const tage = new Set();
      touren.forEach((t) => { if (t.datum) tage.add(t.datum); });
      const einsatztage = tage.size;
      const proTag = einsatztage ? summe / einsatztage : 0;
      return { plate: f.plate, fahrer, status, touren, summe, startKm, endKm, wochenKm, einsatztage, proTag };
    });
  }, [tours, fleet, einsatz, epJahr, epKw]);

  const dashTours = useMemo(() => {
    // LKW/Fahrer-Filter gelten immer zuerst - unabhängig davon, ob die Tour ein
    // Datum hat. Vorher wurde bei fehlendem Datum sofort "true" zurückgegeben und
    // damit auch LKW-/Fahrer-Filter übersprungen (Touren tauchten fälschlich unter
    // jedem LKW/Fahrer im Dashboard auf).
    return tours.filter((t) => {
      if (dashFilters.lkw !== "ALLE" && t.lkw !== dashFilters.lkw) return false;
      if (dashFilters.fahrer !== "ALLE" && t.fahrer !== dashFilters.fahrer) return false;
      const hasDatumFilter = dashFilters.jahr !== "ALLE" || dashFilters.monat !== "ALLE" ||
        dashFilters.kw !== "ALLE" || dashFilters.von || dashFilters.bis;
      if (!t.datum) return !hasDatumFilter;
      if (dashFilters.jahr !== "ALLE" && t.datum.slice(0, 4) !== dashFilters.jahr) return false;
      if (dashFilters.monat !== "ALLE" && Number(t.datum.slice(5, 7)) !== Number(dashFilters.monat)) return false;
      if (dashFilters.kw !== "ALLE" && isoWeek(t.datum) !== Number(dashFilters.kw)) return false;
      if (dashFilters.von && t.datum < dashFilters.von) return false;
      if (dashFilters.bis && t.datum > dashFilters.bis) return false;
      return true;
    });
  }, [tours, dashFilters]);

  const kpi = useMemo(() => {
    const umsatz = dashTours.reduce((s, t) => s + gesamt(t), 0);
    const anzahl = dashTours.length;
    const offen = dashTours.filter((t) => t.status === "Offen").length;
    const reklamiert = dashTours.filter((t) => t.status === "Reklamiert").length;
    // Einsatztage = Tage, an denen ein LKW tatsächlich gefahren ist (mehrere Touren
    // am gleichen Tag mit demselben LKW zählen nur einmal). Gruppiert nach LKW+Datum,
    // damit z.B. zwei verschiedene LKWs am selben Kalendertag als 2 Einsatztage zählen.
    const tage = new Set();
    dashTours.forEach((t) => { if (t.lkw && t.datum) tage.add(`${t.lkw}|${t.datum}`); });
    const einsatztage = tage.size;
    return { umsatz, anzahl, offen, reklamiert, einsatztage, avg: einsatztage ? umsatz / einsatztage : 0 };
  }, [dashTours]);

  const perLkw = useMemo(() => {
    const map = {};
    dashTours.forEach((t) => {
      if (!t.lkw) return;
      if (!map[t.lkw]) map[t.lkw] = { umsatz: 0, touren: 0, tage: new Set() };
      map[t.lkw].umsatz += gesamt(t);
      map[t.lkw].touren += 1;
      if (t.datum) map[t.lkw].tage.add(t.datum);
    });
    return Object.entries(map)
      .map(([lkw, v]) => ({
        lkw, umsatz: v.umsatz, touren: v.touren, einsatztage: v.tage.size,
        proTag: v.tage.size ? v.umsatz / v.tage.size : 0,
      }))
      .sort((a, b) => b.umsatz - a.umsatz);
  }, [dashTours]);

  // Prüft, ob eine Einsatzplan-Woche (Jahr/KW) in den aktuell gewählten
  // Dashboard-Zeitraum fällt - analog zur Datumsfilterung von dashTours, nur
  // eben auf Wochenbasis (eine Woche hat kein einzelnes Datum, daher wird der
  // Monatsfilter auf Montag ODER Sonntag der Woche geprüft, falls die Woche
  // über einen Monatswechsel läuft; von/bis werden per Bereichsüberlappung
  // geprüft, damit auch eine Woche zählt, die den Filterzeitraum nur teilweise
  // überdeckt).
  function weekInDashRange(jahr, kw) {
    if (dashFilters.jahr !== "ALLE" && String(jahr) !== dashFilters.jahr) return false;
    if (dashFilters.kw !== "ALLE" && kw !== Number(dashFilters.kw)) return false;
    const monday = isoWeekMonday(jahr, kw);
    const sunday = new Date(monday.getTime() + 6 * 86400000);
    if (dashFilters.monat !== "ALLE") {
      const mMonday = monday.getMonth() + 1;
      const mSunday = sunday.getMonth() + 1;
      if (Number(dashFilters.monat) !== mMonday && Number(dashFilters.monat) !== mSunday) return false;
    }
    if (dashFilters.von && toLocalISODate(sunday) < dashFilters.von) return false;
    if (dashFilters.bis && toLocalISODate(monday) > dashFilters.bis) return false;
    return true;
  }

  // Gefahrene KM je LKW im gewählten Dashboard-Zeitraum (Woche/Monat/Jahr/
  // eigener Zeitraum - je nachdem, was oben gefiltert ist), statt wie zuvor
  // immer die Gesamt-KM seit dem Start-KM. Summiert die Wochen-Deltas
  // (Ende-KM minus Start-KM je Woche, aus computeStartKm) aller Wochen, die
  // in den Filter fallen - respektiert dabei auch LKW-/Fahrer-Filter.
  const periodKmPerLkw = useMemo(() => {
    const map = {};
    einsatz.forEach((e) => {
      if (dashFilters.lkw !== "ALLE" && e.lkw !== dashFilters.lkw) return;
      if (dashFilters.fahrer !== "ALLE" && e.fahrer !== dashFilters.fahrer) return;
      if (!weekInDashRange(e.jahr, e.kw)) return;
      const startKm = computeStartKm(e.jahr, e.kw, e.lkw);
      const endKm = e.endKm !== undefined && e.endKm !== "" && e.endKm !== null ? Number(e.endKm) : null;
      if (startKm === null || endKm === null) return;
      map[e.lkw] = (map[e.lkw] || 0) + (endKm - startKm);
    });
    return map;
  }, [einsatz, fleet, dashFilters]);

  // Beschriftung der KM-Spalte im LKW-Ranking, passend zur gröbsten aktuell
  // gesetzten Zeitfilterung (Woche vor Monat vor Jahr vor eigenem Zeitraum),
  // damit auf einen Blick klar ist, worauf sich die angezeigte KM-Zahl bezieht.
  function kmColumnLabel() {
    if (dashFilters.kw !== "ALLE") return "KM (Woche)";
    if (dashFilters.monat !== "ALLE") return "KM (Monat)";
    if (dashFilters.jahr !== "ALLE") return "KM (Jahr)";
    if (dashFilters.von || dashFilters.bis) return "KM (Zeitraum)";
    return "KM (gesamt)";
  }

  const perFahrer = useMemo(() => {
    const map = {};
    dashTours.forEach((t) => {
      if (!t.fahrer) return;
      if (!map[t.fahrer]) map[t.fahrer] = { umsatz: 0, touren: 0, tage: new Set() };
      map[t.fahrer].umsatz += gesamt(t);
      map[t.fahrer].touren += 1;
      if (t.datum) map[t.fahrer].tage.add(t.datum);
    });
    return Object.entries(map)
      .map(([fahrer, v]) => ({
        fahrer, umsatz: v.umsatz, touren: v.touren, einsatztage: v.tage.size,
        proTag: v.tage.size ? v.umsatz / v.tage.size : 0,
      }))
      .sort((a, b) => b.umsatz - a.umsatz);
  }, [dashTours]);

  const perMonth = useMemo(() => {
    const map = {};
    dashTours.forEach((t) => {
      if (!t.datum) return;
      const m = Number(t.datum.slice(5, 7)) - 1;
      map[m] = (map[m] || 0) + gesamt(t);
    });
    return MONTHS.map((name, i) => ({ name, umsatz: map[i] || 0 }));
  }, [dashTours]);

  const topKunden = useMemo(() => {
    const map = {};
    dashTours.forEach((t) => {
      if (!t.kunde) return;
      map[t.kunde] = (map[t.kunde] || 0) + gesamt(t);
    });
    return Object.entries(map)
      .map(([kunde, umsatz]) => ({ kunde, umsatz }))
      .sort((a, b) => b.umsatz - a.umsatz)
      .slice(0, 8);
  }, [dashTours]);

  const suggestedFahrer = driverForWeek(form.lkw, form.datum);
  // Fracht und Diesel werden automatisch aus Staffelrate/Diesel-Index berechnet
  // (siehe calcFracht/calcDiesel) - nur bei Maut bleibt ein echter Vorschlag
  // nötig, und zwar cent-genau aus der letzten Tour desselben Kunden statt
  // eines Durchschnitts.
  const lastTour = lastTourFor(form.kunde);

  const tabs = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "touren", label: "Touren", icon: Truck },
    { id: "reklamationen", label: "Reklamationen", icon: AlertTriangle },
    { id: "neu", label: "Neue Tour", icon: PlusCircle },
    { id: "suche", label: "Suche", icon: SearchIcon },
    { id: "einsatz", label: "Einsatzplan", icon: CalendarClock },
    { id: "wochenkontrolle", label: "Wochen-Kontrolle", icon: ListChecks },
    { id: "stamm", label: "Stammdaten", icon: Users },
    { id: "import", label: "Import", icon: Upload },
  ];

  if (!loaded) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: TEXT_MUTED, fontFamily: "'Space Grotesk', sans-serif" }}>
        Lade Daten …
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Space Grotesk', sans-serif", background: BG, minHeight: "100vh", color: TEXT, display: "flex" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .mono { font-family: 'IBM Plex Mono', monospace; }
        input, select, textarea {
          font-family: 'Space Grotesk', sans-serif;
          font-size: 13px;
          border: 1px solid ${BORDER};
          border-radius: 6px;
          padding: 7px 10px;
          background: #fff;
          color: ${TEXT};
          width: 100%;
          box-sizing: border-box;
        }
        input:focus, select:focus, textarea:focus {
          outline: none;
          border-color: ${AMBER};
        }
        label { font-size: 11px; color: ${TEXT_MUTED}; display: block; margin-bottom: 4px; font-weight: 500; }
        table { border-collapse: collapse; width: 100%; }
        th { text-align: left; font-size: 11px; color: ${TEXT_MUTED}; font-weight: 500; padding: 8px 10px; border-bottom: 1px solid ${BORDER}; }
        td { padding: 8px 10px; font-size: 13px; border-bottom: 1px solid ${BORDER}; }
        tr:hover td { background: #FAFBFC; }
        button.primary {
          background: ${AMBER}; color: ${AMBER_DARK}; border: none; border-radius: 6px;
          padding: 9px 18px; font-weight: 600; font-size: 13px; cursor: pointer;
          display: inline-flex; align-items: center; gap: 6px;
        }
        button.primary:hover { filter: brightness(0.96); }
        button.ghost {
          background: transparent; border: 1px solid ${BORDER}; color: ${TEXT};
          border-radius: 6px; padding: 7px 12px; font-size: 13px; cursor: pointer;
          display: inline-flex; align-items: center; gap: 6px;
        }
        button.ghost:hover { border-color: ${MARINE}; }
      `}</style>

      {/* Hauptnavigation als linke Seitenleiste (statt oben) - auf Nutzerwunsch,
          moderneres Layout. Bleibt beim Scrollen des Inhalts stehen (sticky). */}
      <div style={{
        width: 226, flexShrink: 0, background: MARINE, display: "flex", flexDirection: "column",
        padding: "22px 0", position: "sticky", top: 0, alignSelf: "flex-start", height: "100vh", overflowY: "auto",
      }}>
        <div style={{ padding: "0 22px", marginBottom: 28 }}>
          <div style={{ color: "#fff", fontSize: 18, fontWeight: 600, letterSpacing: 0.2 }}>Tourenliste</div>
          <div style={{ color: "#9FB3C4", fontSize: 11.5, marginTop: 3, lineHeight: 1.4 }}>Fuhrpark &amp; Touren, geteilt für alle</div>
          <div style={{ height: 3, width: 40, background: AMBER, borderRadius: 2, marginTop: 12 }} />
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {tabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  background: active ? "rgba(255,255,255,0.09)" : "none",
                  border: "none", cursor: "pointer", width: "100%", textAlign: "left",
                  borderLeft: active ? `3px solid ${AMBER}` : "3px solid transparent",
                  padding: "11px 19px", fontSize: 13, fontWeight: 500,
                  display: "flex", alignItems: "center", gap: 10,
                  color: active ? "#fff" : "#9FB3C4",
                }}
              >
                <Icon size={16} /> {t.label}
              </button>
            );
          })}
        </nav>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {storageError && (
          <div style={{
            background: DANGER_BG, color: DANGER, fontSize: 12.5, fontWeight: 500,
            padding: "10px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AlertTriangle size={14} /> {storageError}
            </span>
            <button className="ghost" style={{ padding: "3px 8px", borderColor: DANGER, color: DANGER }} onClick={() => setStorageError("")}>
              <X size={12} />
            </button>
          </div>
        )}

        <div style={{ padding: 28 }}>
        {tab === "dashboard" && (
          <div>
            <PageHeading icon={LayoutDashboard} title="Dashboard" subtitle="Umsatz, Touren und Kennzahlen im Überblick" />
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: "14px 18px", marginBottom: 20 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 10 }}>
                <div>
                  <label>Jahr</label>
                  <select value={dashFilters.jahr} onChange={(e) => setDashFilters({ ...dashFilters, jahr: e.target.value })}>
                    <option value="ALLE">Alle</option>
                    {years.map((y) => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
                <div>
                  <label>LKW</label>
                  <select value={dashFilters.lkw} onChange={(e) => setDashFilters({ ...dashFilters, lkw: e.target.value })}>
                    <option value="ALLE">Alle</option>
                    {fleet.map((f) => <option key={f.plate} value={f.plate}>{f.plate}</option>)}
                  </select>
                </div>
                <div>
                  <label>Fahrer</label>
                  <select value={dashFilters.fahrer} onChange={(e) => setDashFilters({ ...dashFilters, fahrer: e.target.value })}>
                    <option value="ALLE">Alle</option>
                    {allDrivers.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label>Monat</label>
                  <select value={dashFilters.monat} onChange={(e) => setDashFilters({ ...dashFilters, monat: e.target.value })}>
                    <option value="ALLE">Alle</option>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label>KW</label>
                  <select value={dashFilters.kw} onChange={(e) => setDashFilters({ ...dashFilters, kw: e.target.value })}>
                    <option value="ALLE">Alle</option>
                    {Array.from({ length: 53 }, (_, i) => i + 1).map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                </div>
                <div>
                  <label>Datum von</label>
                  <input type="date" value={dashFilters.von} onChange={(e) => setDashFilters({ ...dashFilters, von: e.target.value })} />
                </div>
                <div>
                  <label>Datum bis</label>
                  <input type="date" value={dashFilters.bis} onChange={(e) => setDashFilters({ ...dashFilters, bis: e.target.value })} />
                </div>
              </div>
              <button className="ghost" style={{ marginTop: 10 }}
                onClick={() => setDashFilters({ jahr: "ALLE", lkw: "ALLE", fahrer: "ALLE", monat: "ALLE", kw: "ALLE", von: "", bis: "" })}>
                Filter zurücksetzen
              </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 14, marginBottom: 24 }}>
              {[
                { label: "Umsatz", val: euro(kpi.umsatz) },
                { label: "Touren", val: kpi.anzahl },
                { label: "Einsatztage", val: kpi.einsatztage },
                { label: "Ø pro Einsatztag", val: euro(kpi.avg) },
                { label: "Offen / Reklamiert", val: `${kpi.offen} / ${kpi.reklamiert}` },
              ].map((k) => (
                <div key={k.label} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ background: MARINE, color: AMBER, fontSize: 11, fontWeight: 600, padding: "8px 14px" }}>
                    {k.label.toUpperCase()}
                  </div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 600, padding: "14px 14px", color: MARINE }}>
                    {k.val}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, marginBottom: 16 }}>
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Umsatz je LKW</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={perLkw}>
                    <CartesianGrid strokeDasharray="3 3" stroke={BORDER} vertical={false} />
                    <XAxis dataKey="lkw" tick={{ fontSize: 11, fill: TEXT_MUTED }} />
                    <YAxis tick={{ fontSize: 11, fill: TEXT_MUTED }} width={50} />
                    <Tooltip formatter={(v) => euro(v)} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
                    <Bar dataKey="umsatz" radius={[4, 4, 0, 0]}>
                      {perLkw.map((_, i) => <Cell key={i} fill={i === 0 ? AMBER : MARINE_LIGHT} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Top Kunden</div>
                {topKunden.length === 0 && <div style={{ fontSize: 12, color: TEXT_MUTED }}>Noch keine Touren erfasst.</div>}
                {topKunden.map((k, i) => (
                  <div key={k.kunde} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: i < topKunden.length - 1 ? `1px solid ${BORDER}` : "none" }}>
                    <span style={{ fontSize: 12.5 }}>{k.kunde}</span>
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{euro(k.umsatz)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>LKW-Ranking</div>
              {perLkw.length === 0 && <div style={{ fontSize: 12, color: TEXT_MUTED }}>Noch keine Touren mit LKW erfasst.</div>}
              {perLkw.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>LKW</th><th style={{ textAlign: "right" }}>Umsatz</th><th style={{ textAlign: "right" }}>Touren</th>
                      <th style={{ textAlign: "right" }}>Einsatztage</th><th style={{ textAlign: "right" }}>Ø Umsatz/Tag</th>
                      <th style={{ textAlign: "right" }}>{kmColumnLabel()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perLkw.map((l) => {
                      const km = periodKmPerLkw[l.lkw];
                      return (
                        <tr key={l.lkw}>
                          <td>{l.lkw}</td>
                          <td className="mono" style={{ textAlign: "right" }}>{euro(l.umsatz)}</td>
                          <td className="mono" style={{ textAlign: "right" }}>{l.touren}</td>
                          <td className="mono" style={{ textAlign: "right" }}>{l.einsatztage}</td>
                          <td className="mono" style={{ textAlign: "right" }}>{euro(l.proTag)}</td>
                          <td className="mono" style={{ textAlign: "right" }}>
                            {km === null || km === undefined ? "–" : `${km.toLocaleString("de-DE")} km`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Fahrer-Ranking</div>
              {perFahrer.length === 0 && <div style={{ fontSize: 12, color: TEXT_MUTED }}>Noch keine Touren mit Fahrer erfasst.</div>}
              {perFahrer.length > 0 && (
                <table>
                  <thead>
                    <tr><th>Fahrer</th><th style={{ textAlign: "right" }}>Umsatz</th><th style={{ textAlign: "right" }}>Touren</th><th style={{ textAlign: "right" }}>Einsatztage</th><th style={{ textAlign: "right" }}>Ø Umsatz/Tag</th></tr>
                  </thead>
                  <tbody>
                    {perFahrer.map((f) => (
                      <tr key={f.fahrer}>
                        <td>{f.fahrer}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{euro(f.umsatz)}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{f.touren}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{f.einsatztage}</td>
                        <td className="mono" style={{ textAlign: "right" }}>{euro(f.proTag)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 18 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Monatstrend</div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={perMonth}>
                  <CartesianGrid strokeDasharray="3 3" stroke={BORDER} vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: TEXT_MUTED }} />
                  <YAxis tick={{ fontSize: 11, fill: TEXT_MUTED }} width={50} />
                  <Tooltip formatter={(v) => euro(v)} contentStyle={{ fontSize: 12, borderRadius: 6 }} />
                  <Line type="monotone" dataKey="umsatz" stroke={AMBER} strokeWidth={2.5} dot={{ r: 3, fill: AMBER }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {tab === "touren" && (
          <div>
            <PageHeading icon={Truck} title="Touren" subtitle="Alle erfassten Touren" />
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 14 }}>
              <div style={{ width: 160 }}>
                <label>Monat</label>
                <select value={tourenMonat} onChange={(e) => setTourenMonat(e.target.value)}>
                  <option value="ALLE">Alle</option>
                  {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
            </div>
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Datum</th><th>KW</th><th>LKW</th><th>Fahrer</th><th>Kunde</th>
                    <th>Auftrags-Nr.</th>
                    {COSTFIELDS.map((k) => <th key={k} style={{ textAlign: "right" }}>{COSTFIELD_LABELS[k]}</th>)}
                    <th style={{ textAlign: "right" }}>Gesamt</th>
                    <th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {tourenList.length === 0 && (
                    <tr><td colSpan={16} style={{ textAlign: "center", color: TEXT_MUTED, padding: 24 }}>
                      {tourenMonat !== "ALLE" ? "Keine Touren in diesem Monat." : "Noch keine Touren erfasst."}
                    </td></tr>
                  )}
                  {tourenList.map((t) => {
                    const sc = statusColors(t.status);
                    return (
                      <tr key={t.id} onDoubleClick={() => openEdit(t)} style={{ cursor: "pointer", background: sc.bg }} title="Doppelklick zum Bearbeiten">
                        <td className="mono">{formatDateDMY(t.datum)}</td>
                        <td className="mono">{isoWeek(t.datum) ?? "–"}</td>
                        <td className="mono">{t.lkw}</td>
                        <td>{t.fahrer}</td>
                        <td>{t.kunde}</td>
                        <td className="mono">{t.auftragsNr}</td>
                        {COSTFIELDS.map((k) => (
                          <td key={k} className="mono" style={{ textAlign: "right" }}>{euro(t[k])}</td>
                        ))}
                        <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{euro(gesamt(t))}</td>
                        <td>
                          <span style={{ color: sc.text, fontSize: 12, fontWeight: 700 }}>
                            {t.status}
                          </span>
                        </td>
                        <td>
                          <button className="ghost" onClick={() => openEdit(t)} style={{ padding: "4px 8px" }}>
                            <Pencil size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        )}

        {tab === "reklamationen" && (
          <div>
            <PageHeading icon={AlertTriangle} title="Reklamationen" />
            <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 14 }}>
              Offene und reklamierte Touren, sortiert nach Datum. Sobald eine Tour auf "Abgerechnet" gesetzt wird
              (über Suche → Bearbeiten), verschwindet sie automatisch aus dieser Liste.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14, marginBottom: 20 }}>
              {[
                { label: "Offen", stat: reklamationStats.offen },
                { label: "Reklamiert", stat: reklamationStats.reklamiert },
              ].map((k) => (
                <div key={k.label} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
                  <div style={{ background: MARINE, color: AMBER, fontSize: 11, fontWeight: 600, padding: "8px 14px" }}>
                    {k.label.toUpperCase()}
                  </div>
                  <div style={{ padding: "14px 14px", display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                    <span className="mono" style={{ fontSize: 22, fontWeight: 600, color: MARINE }}>
                      {k.stat.anzahl} {k.stat.anzahl === 1 ? "Tour" : "Touren"}
                    </span>
                    <span className="mono" style={{ fontSize: 14, fontWeight: 500, color: TEXT_MUTED }}>{euro(k.stat.summe)}</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Datum</th><th>KW</th><th>LKW</th><th>Fahrer</th><th>Kunde</th>
                    <th>Auftrags-Nr.</th>
                    {COSTFIELDS.map((k) => <th key={k} style={{ textAlign: "right" }}>{COSTFIELD_LABELS[k]}</th>)}
                    <th style={{ textAlign: "right" }}>Gesamt</th>
                    <th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {reklamationTours.length === 0 && (
                    <tr><td colSpan={16} style={{ textAlign: "center", color: TEXT_MUTED, padding: 24 }}>Keine offenen oder reklamierten Touren.</td></tr>
                  )}
                  {reklamationTours.map((t) => {
                    const sc = statusColors(t.status);
                    return (
                      <tr key={t.id} onDoubleClick={() => openEdit(t)} style={{ cursor: "pointer", background: sc.bg }} title="Doppelklick zum Bearbeiten">
                        <td className="mono">{formatDateDMY(t.datum)}</td>
                        <td className="mono">{isoWeek(t.datum) ?? "–"}</td>
                        <td className="mono">{t.lkw}</td>
                        <td>{t.fahrer}</td>
                        <td>{t.kunde}</td>
                        <td className="mono">{t.auftragsNr}</td>
                        {COSTFIELDS.map((k) => (
                          <td key={k} className="mono" style={{ textAlign: "right" }}>{euro(t[k])}</td>
                        ))}
                        <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{euro(gesamt(t))}</td>
                        <td>
                          <span style={{ color: sc.text, fontSize: 12, fontWeight: 700 }}>
                            {t.status}
                          </span>
                        </td>
                        <td>
                          <button className="ghost" onClick={() => openEdit(t)} style={{ padding: "4px 8px" }}>
                            <Pencil size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        )}

        {tab === "neu" && (
          <div>
          <PageHeading icon={PlusCircle} title="Neue Tour erfassen" />
          <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ maxWidth: 640, flex: "1 1 480px", background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 24 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <label>Datum *</label>
                <input type="date" value={form.datum} style={fieldStyle("datum", formErrors)}
                  onChange={(e) => { handleDatumChange(e.target.value, setForm, form); setFormErrors(formErrors.filter((k) => k !== "datum")); }} />
              </div>
              <div>
                <label>LKW *</label>
                <select value={form.lkw} style={fieldStyle("lkw", formErrors)}
                  onChange={(e) => { handlePlateChange(e.target.value, setForm, form); setFormErrors(formErrors.filter((k) => k !== "lkw")); }}>
                  <option value="">Auswählen …</option>
                  {fleet.map((f) => <option key={f.plate} value={f.plate}>{f.plate}</option>)}
                </select>
              </div>
              <div>
                <label>Fahrer * {suggestedFahrer && <span style={{ color: TEXT_MUTED }}>· aus Einsatzplan übernommen</span>}</label>
                <select value={form.fahrer} style={fieldStyle("fahrer", formErrors)}
                  onChange={(e) => { setForm({ ...form, fahrer: e.target.value }); setFormErrors(formErrors.filter((k) => k !== "fahrer")); }}>
                  <option value="">Bitte wählen …</option>
                  {driverOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <div>
                <label>Auftrags-Nr. *</label>
                <input value={form.auftragsNr} style={fieldStyle("auftragsNr", formErrors)}
                  onChange={(e) => { setForm({ ...form, auftragsNr: e.target.value }); setFormErrors(formErrors.filter((k) => k !== "auftragsNr")); }} />
              </div>
              <div>
                <label>Container-Nr. *</label>
                <input value={form.containerNr} style={fieldStyle("containerNr", formErrors)}
                  onChange={(e) => { setForm({ ...form, containerNr: e.target.value.toUpperCase() }); setFormErrors(formErrors.filter((k) => k !== "containerNr")); }} />
              </div>
              <div>
                <label>Kunde / Ladestelle *</label>
                <input value={form.kunde} style={fieldStyle("kunde", formErrors)}
                  onChange={(e) => { setForm({ ...form, kunde: e.target.value }); setFormErrors(formErrors.filter((k) => k !== "kunde")); }} />
              </div>
              <div>
                <label>PLZ * {lastTour && <span style={{ color: TEXT_MUTED }}>· Vorschlag: {lastTour.plz}</span>}</label>
                <input value={form.plz} style={fieldStyle("plz", formErrors)}
                  onChange={(e) => { setForm({ ...form, plz: e.target.value }); setFormErrors(formErrors.filter((k) => k !== "plz")); }} />
              </div>
              <div>
                <label>Ort * {lastTour && <span style={{ color: TEXT_MUTED }}>· Vorschlag: {lastTour.ort}</span>}</label>
                <input value={form.ort} style={fieldStyle("ort", formErrors)}
                  onChange={(e) => { setForm({ ...form, ort: e.target.value }); setFormErrors(formErrors.filter((k) => k !== "ort")); }} />
              </div>
              <div>
                <label>Ankunft *</label>
                <input type="time" value={form.ankunft} style={fieldStyle("ankunft", formErrors)}
                  onChange={(e) => { setForm({ ...form, ankunft: e.target.value }); setFormErrors(formErrors.filter((k) => k !== "ankunft")); }} />
              </div>
              <div>
                <label>Abfahrt *</label>
                <input type="time" value={form.abfahrt} style={fieldStyle("abfahrt", formErrors)}
                  onChange={(e) => { setForm({ ...form, abfahrt: e.target.value }); setFormErrors(formErrors.filter((k) => k !== "abfahrt")); }} />
              </div>
              <div>
                <label>Abrechnungs-KM *</label>
                <input type="number" value={form.km} style={fieldStyle("km", formErrors)}
                  onChange={(e) => {
                    const km = e.target.value;
                    const fracht = calcFracht(km);
                    const diesel = calcDiesel(km, form.datum);
                    setForm({ ...form, km, ...(fracht !== "" ? { fracht } : {}), ...(diesel !== "" ? { diesel } : {}) });
                    setFormErrors(formErrors.filter((k) => k !== "km"));
                  }} />
              </div>

              {[
                ["fracht", "Fracht (€)", "automatisch aus Staffelrate"],
                ["fd", "FD (€)", null],
                ["adr", "ADR (€)", null],
                ["multistop", "Multistop (€)", null],
                ["wartezeit", "Wartezeit (€)", null],
                ["maut", "Maut (€)", null],
                ["diesel", "Diesel (€)", "automatisch aus Diesel-Index"],
              ].map(([key, lbl, hint]) => (
                <div key={key}>
                  <label>
                    {lbl}
                    {hint && <span style={{ color: TEXT_MUTED }}> · {hint}</span>}
                    {key === "maut" && lastTour && lastTour.maut !== undefined && lastTour.maut !== "" && (
                      <span style={{ color: TEXT_MUTED }}> · Vorschlag: {euro(lastTour.maut)}</span>
                    )}
                  </label>
                  <input type="number" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                </div>
              ))}

              <div style={{ gridColumn: "1 / -1" }}>
                <label>Bemerkungen</label>
                <textarea rows={2} value={form.bemerkungen} onChange={(e) => setForm({ ...form, bemerkungen: e.target.value })} />
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <label>Status *</label>
                <select value={form.status} style={statusFieldStyle(form.status, formErrors)}
                  onChange={(e) => { setForm({ ...form, status: e.target.value }); setFormErrors(formErrors.filter((k) => k !== "status")); }}>
                  <option value="">Bitte wählen …</option>
                  <option>Offen</option><option>Reklamiert</option><option>Abgerechnet</option>
                </select>
              </div>
            </div>

            <div style={{ marginTop: 18, background: BG, borderRadius: 8, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: TEXT_MUTED }}>Gesamtsumme</span>
              <span className="mono" style={{ fontSize: 18, fontWeight: 600, color: MARINE }}>{euro(gesamt(form))}</span>
            </div>

            <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 14 }}>
              <button className="primary" onClick={handleSave}><Save size={15} /> Tour speichern</button>
              {saveNote && <span style={{ fontSize: 12.5, color: formErrors.length > 0 ? DANGER : SUCCESS }}>{saveNote}</span>}
            </div>
            <div style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 10 }}>* Pflichtfeld</div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, flex: "2 1 600px" }}>
            <RatesInfoBox />

            <div style={{ flex: "1 1 260px", minWidth: 240, background: CARD, border: `1px solid ${BORDER}`, borderTop: `3px solid ${SUCCESS}`, borderRadius: 12, padding: 18 }}>
              <InfoBoxHeader icon={Fuel} badgeBg={SUCCESS} iconColor="#fff" title="Diesel-Index" />
              <div style={{ fontSize: 11, color: TEXT_MUTED, marginBottom: 10, marginTop: -4 }}>monatlich von Contargo</div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={{ marginBottom: 2 }}>Monat</label>
                  <select value={diMonat} onChange={(e) => setDiMonat(Number(e.target.value))}>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ marginBottom: 2 }}>Jahr</label>
                  <input type="number" value={diJahr} onChange={(e) => setDiJahr(e.target.value)} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ marginBottom: 2 }}>Betrag (€)</label>
                  <input type="number" step="0.001" value={diBetrag} onChange={(e) => setDiBetrag(e.target.value)} />
                </div>
                <button className="primary" style={{ padding: "7px 10px" }} onClick={addDieselIndex}>
                  <PlusCircle size={14} />
                </button>
              </div>

              {dieselIndex.length === 0 && (
                <div style={{ fontSize: 12, color: TEXT_MUTED }}>Noch keine Werte erfasst.</div>
              )}
              {dieselIndex.length > 0 && (
                <table>
                  <thead>
                    <tr><th>Monat</th><th>Jahr</th><th style={{ textAlign: "right" }}>Betrag</th><th></th></tr>
                  </thead>
                  <tbody>
                    {dieselIndex
                      .slice()
                      .sort((a, b) => (b.jahr * 100 + b.monat) - (a.jahr * 100 + a.monat))
                      .map((d) => {
                        const confirming = confirmDeleteDiesel === d.id;
                        return (
                          <tr key={d.id}>
                            <td style={{ fontSize: 12, padding: "6px 4px" }}>{MONTHS[d.monat - 1]}</td>
                            <td className="mono" style={{ fontSize: 12, padding: "6px 4px" }}>{d.jahr}</td>
                            <td className="mono" style={{ fontSize: 12, padding: "6px 4px", textAlign: "right" }}>{euro(d.betrag)}</td>
                            <td style={{ padding: "6px 0 6px 4px" }}>
                              {!confirming && (
                                <button className="ghost" style={{ padding: "3px 6px" }} onClick={() => setConfirmDeleteDiesel(d.id)}>
                                  <Trash2 size={12} />
                                </button>
                              )}
                              {confirming && (
                                <div style={{ display: "flex", gap: 4 }}>
                                  <button className="ghost" style={{ padding: "3px 6px", fontSize: 11 }} onClick={() => setConfirmDeleteDiesel(null)}>
                                    Nein
                                  </button>
                                  <button className="primary" style={{ padding: "3px 6px", fontSize: 11, background: DANGER, color: "#fff" }}
                                    onClick={() => { persistDieselIndex(dieselIndex.filter((x) => x.id !== d.id)); setConfirmDeleteDiesel(null); }}>
                                    Löschen
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          </div>
          </div>
        )}

        {tab === "suche" && (
          <div>
            <PageHeading icon={SearchIcon} title="Suche" />
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 18, marginBottom: 18 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
                <div>
                  <label>Tournummer</label>
                  <input value={search.nr} onChange={(e) => setSearch({ ...search, nr: e.target.value })} placeholder="auch Teilzeichen" />
                </div>
                <div>
                  <label>Container-Nr.</label>
                  <input value={search.containerNr} onChange={(e) => setSearch({ ...search, containerNr: e.target.value })} placeholder="auch Teilzeichen" />
                </div>
                <div>
                  <label>Kunde</label>
                  <input value={search.kunde} onChange={(e) => setSearch({ ...search, kunde: e.target.value })} placeholder="auch Teilzeichen" />
                </div>
                <div>
                  <label>PLZ</label>
                  <input value={search.plz} onChange={(e) => setSearch({ ...search, plz: e.target.value })} placeholder="auch Teilzeichen" />
                </div>
                <div>
                  <label>Ort</label>
                  <input value={search.ort} onChange={(e) => setSearch({ ...search, ort: e.target.value })} placeholder="auch Teilzeichen" />
                </div>
                <div>
                  <label>LKW</label>
                  <select value={search.lkw} onChange={(e) => setSearch({ ...search, lkw: e.target.value })}>
                    <option value="">Alle</option>
                    {fleet.map((f) => <option key={f.plate} value={f.plate}>{f.plate}</option>)}
                  </select>
                </div>
                <div>
                  <label>Status</label>
                  <select value={search.status} onChange={(e) => setSearch({ ...search, status: e.target.value })}>
                    <option value="">Alle</option>
                    <option>Offen</option><option>Reklamiert</option><option>Abgerechnet</option>
                  </select>
                </div>
              </div>
              <button className="ghost" style={{ marginTop: 10 }}
                onClick={() => setSearch({ nr: "", containerNr: "", kunde: "", plz: "", ort: "", lkw: "", status: "" })}>
                Filter zurücksetzen
              </button>
            </div>

            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Datum</th><th>KW</th><th>LKW</th><th>Kunde</th><th>Container-Nr.</th><th>PLZ</th><th>Ort</th>
                    {COSTFIELDS.map((k) => <th key={k} style={{ textAlign: "right" }}>{COSTFIELD_LABELS[k]}</th>)}
                    <th style={{ textAlign: "right" }}>Gesamt</th><th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.length === 0 && (
                    <tr><td colSpan={17} style={{ textAlign: "center", color: TEXT_MUTED, padding: 24 }}>
                      {Object.values(search).some(Boolean) ? "Keine Treffer." : "Mindestens ein Suchfeld ausfüllen."}
                    </td></tr>
                  )}
                  {searchResults.map((t) => {
                    const sc = statusColors(t.status);
                    return (
                      <tr key={t.id} onDoubleClick={() => openEdit(t)} style={{ cursor: "pointer", background: sc.bg }} title="Doppelklick zum Bearbeiten">
                        <td className="mono">{formatDateDMY(t.datum)}</td>
                        <td className="mono">{isoWeek(t.datum) ?? "–"}</td>
                        <td className="mono">{t.lkw}</td>
                        <td>{t.kunde}</td>
                        <td className="mono">{t.containerNr}</td>
                        <td className="mono">{t.plz}</td>
                        <td>{t.ort}</td>
                        {COSTFIELDS.map((k) => (
                          <td key={k} className="mono" style={{ textAlign: "right" }}>{euro(t[k])}</td>
                        ))}
                        <td className="mono" style={{ textAlign: "right", fontWeight: 700 }}>{euro(gesamt(t))}</td>
                        <td><span style={{ color: sc.text, fontSize: 12, fontWeight: 700 }}>{t.status}</span></td>
                        <td>
                          <div style={{ display: "flex", gap: 4 }}>
                            <button className="ghost" onClick={() => openEdit(t)} style={{ padding: "4px 8px" }} title="Bearbeiten">
                              <Pencil size={13} />
                            </button>
                            {quickStatusId === t.id ? (
                              <select autoFocus value={t.status} style={{ width: 130 }}
                                onChange={(e) => quickChangeStatus(t.id, e.target.value)}
                                onBlur={() => setQuickStatusId(null)}>
                                <option>Offen</option><option>Reklamiert</option><option>Abgerechnet</option>
                              </select>
                            ) : (
                              <button className="ghost" onClick={() => setQuickStatusId(t.id)} style={{ padding: "4px 8px" }} title="Status ändern">
                                <RefreshCw size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        )}

        {tab === "einsatz" && (
          <div>
            <PageHeading icon={CalendarClock} title="Einsatzplan" />
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <div>
                <label>Jahr</label>
                <input type="number" style={{ width: 100 }} value={epJahr} onChange={(e) => setEpJahr(Number(e.target.value))} />
              </div>
              <div>
                <label>Kalenderwoche</label>
                <input type="number" min="1" max="53" style={{ width: 100 }} value={epKw} onChange={(e) => setEpKw(Number(e.target.value))} />
              </div>
              <button className="ghost" title="Vorherige Woche" onClick={() => shiftWeek(-1)}>◀</button>
              <button className="ghost" title="Nächste Woche" onClick={() => shiftWeek(1)}>▶</button>
              <button className="ghost" onClick={() => { setEpJahr(isoWeekYear(today)); setEpKw(isoWeek(today)); }}>
                Aktuelle Woche
              </button>
              <button className="primary" disabled={!epDirty || epSaving} onClick={saveEinsatzWeek}
                style={!epDirty || epSaving ? { opacity: 0.5, cursor: "default" } : undefined}>
                <Save size={14} /> {epSaving ? "Speichert …" : "Speichern"}
              </button>
              {epDirty && !epSaving && (
                <span style={{ fontSize: 12, color: AMBER_DARK, fontWeight: 500 }}>
                  Ungespeicherte Änderungen – bitte speichern, bevor du die Woche wechselst.
                </span>
              )}
              {weeksWithData.length > 0 && (
                <div>
                  <label>Frühere Woche öffnen</label>
                  <select value="" style={{ width: 200 }}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const [j, w] = e.target.value.split("-").map(Number);
                      setEpJahr(j); setEpKw(w);
                    }}>
                    <option value="">Woche wählen …</option>
                    {weeksWithData.map((w) => (
                      <option key={`${w.jahr}-${w.kw}`} value={`${w.jahr}-${w.kw}`}>
                        KW {w.kw}/{w.jahr}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {fleet.length === 0 && (
              <div style={{ fontSize: 13, color: TEXT_MUTED }}>Erst unter "Stammdaten" Fahrzeuge anlegen.</div>
            )}

            {fleet.length > 0 && (
              <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>LKW</th><th>Fahrer diese Woche</th><th style={{ width: 140 }}>Status</th>
                      <th style={{ width: 110 }}>Start-KM</th><th style={{ width: 110 }}>Ende-KM</th><th style={{ width: 100 }}>Wochen-KM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fleet.map((f) => {
                      const draft = epDraft[f.plate] || { fahrer: "", status: "Aktiv", endKm: "" };
                      const inactiveRow = draft.status !== "Aktiv";
                      const startKm = computeStartKm(epJahr, epKw, f.plate);
                      const endKm = draft.endKm !== undefined && draft.endKm !== "" ? Number(draft.endKm) : null;
                      const wochenKm = startKm !== null && endKm !== null ? endKm - startKm : null;
                      return (
                        <tr key={f.plate} style={inactiveRow ? { background: "#F2F3F5" } : undefined}>
                          <td className="mono" style={{ fontWeight: 500 }}>{f.plate}</td>
                          <td>
                            <select
                              value={draft.fahrer}
                              onChange={(e) => setEpDraftField(f.plate, "fahrer", e.target.value)}
                            >
                              <option value="">{f.driver ? `Standard: ${f.driver}` : "– auswählen –"}</option>
                              {driverOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                            </select>
                          </td>
                          <td>
                            <select value={draft.status} onChange={(e) => setEpDraftField(f.plate, "status", e.target.value)}>
                              <option>Aktiv</option><option>Urlaub</option><option>Krank</option><option>Inaktiv</option>
                            </select>
                          </td>
                          <td className="mono" style={{ fontSize: 12.5, color: TEXT_MUTED, padding: "8px 10px" }}>
                            {startKm !== null ? startKm.toLocaleString("de-DE") : "–"}
                          </td>
                          <td>
                            <input
                              type="number"
                              value={draft.endKm}
                              onChange={(e) => setEpDraftField(f.plate, "endKm", e.target.value)}
                            />
                          </td>
                          <td className="mono" style={{ fontSize: 12.5, padding: "8px 10px" }}>
                            {wochenKm !== null ? wochenKm.toLocaleString("de-DE") + " km" : "–"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>
            )}
            <div style={{ fontSize: 12, color: TEXT_MUTED, marginTop: 12, marginBottom: 24 }}>
              Änderungen an Fahrer, Status oder Ende-KM werden erst mit Klick auf "Speichern" übernommen.
              Bleibt das Fahrer-Feld leer, greift in "Neue Tour" der Standard-Fahrer aus den Stammdaten.
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Frühere Wochen</div>
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Woche</th><th>LKW</th><th>Fahrer</th><th>Status</th>
                    <th style={{ textAlign: "right" }}>Start-KM</th><th style={{ textAlign: "right" }}>Ende-KM</th>
                    <th style={{ textAlign: "right" }}>Wochen-KM</th>
                  </tr>
                </thead>
                <tbody>
                  {einsatzHistory.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: "center", color: TEXT_MUTED, padding: 24 }}>Noch keine Wochen erfasst.</td></tr>
                  )}
                  {einsatzHistory.map((e) => {
                    const active = e.jahr === epJahr && e.kw === epKw;
                    return (
                      <tr key={`${e.jahr}-${e.kw}-${e.lkw}`} onClick={() => { setEpJahr(e.jahr); setEpKw(e.kw); }}
                        style={{ cursor: "pointer", background: active ? WARN_BG : undefined }} title="Diese Woche oben anzeigen">
                        <td className="mono">KW {e.kw}/{e.jahr}</td>
                        <td className="mono">{e.lkw}</td>
                        <td>{e.fahrer || "–"}</td>
                        <td>{e.status || "–"}</td>
                        <td className="mono" style={{ textAlign: "right", color: TEXT_MUTED }}>
                          {e.startKmVal !== null ? e.startKmVal.toLocaleString("de-DE") : "–"}
                        </td>
                        <td className="mono" style={{ textAlign: "right" }}>
                          {e.endKmVal !== null ? e.endKmVal.toLocaleString("de-DE") : "–"}
                        </td>
                        <td className="mono" style={{ textAlign: "right", color: e.wochenKm !== null && e.wochenKm < 0 ? DANGER : TEXT }}>
                          {e.wochenKm !== null ? e.wochenKm.toLocaleString("de-DE") + " km" : "–"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          </div>
        )}

        {tab === "wochenkontrolle" && (
          <div>
            <PageHeading icon={ListChecks} title="Wochen-Kontrolle" />
            <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
              <div>
                <label>Jahr</label>
                <input type="number" style={{ width: 100 }} value={epJahr} onChange={(e) => setEpJahr(Number(e.target.value))} />
              </div>
              <div>
                <label>Kalenderwoche</label>
                <input type="number" min="1" max="53" style={{ width: 100 }} value={epKw} onChange={(e) => setEpKw(Number(e.target.value))} />
              </div>
              <button className="ghost" title="Vorherige Woche" onClick={() => shiftWeek(-1)}>◀</button>
              <button className="ghost" title="Nächste Woche" onClick={() => shiftWeek(1)}>▶</button>
              <button className="ghost" onClick={() => { setEpJahr(isoWeekYear(today)); setEpKw(isoWeek(today)); }}>
                Aktuelle Woche
              </button>
            </div>

            <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 16 }}>
              KW {epKw}/{epJahr} ({formatDateShort(isoWeekMonday(epJahr, epKw))} – {formatDateShort(new Date(isoWeekMonday(epJahr, epKw).getTime() + 6 * 86400000))})
              &nbsp;· reine Kontrollansicht – hier wird nichts gespeichert, Doppelklick auf eine Zeile öffnet die Tour zum Bearbeiten.
            </div>

            {fleet.length === 0 && (
              <div style={{ fontSize: 13, color: TEXT_MUTED }}>Erst unter "Stammdaten" Fahrzeuge anlegen.</div>
            )}

            <div style={{ display: "grid", gap: 16 }}>
              {wochenBloecke.map((b) => {
                const inactive = b.status !== "Aktiv";
                const keineTouren = !inactive && b.touren.length === 0;
                return (
                  <div key={b.plate} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, overflow: "hidden", opacity: inactive ? 0.65 : 1 }}>
                    <div style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8,
                      padding: "12px 16px", background: lkwBlockColor(b.plate), borderBottom: `1px solid ${BORDER}`,
                    }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>{b.plate}</span>
                        <span style={{ fontSize: 12.5, color: TEXT_MUTED }}>{b.fahrer || "– kein Fahrer zugeordnet –"}</span>
                        <span style={{ fontSize: 11.5, color: TEXT_MUTED }}>
                          Start-KM <span className="mono" style={{ color: TEXT, fontWeight: 500 }}>{b.startKm !== null ? b.startKm.toLocaleString("de-DE") : "–"}</span>
                        </span>
                        <span style={{ fontSize: 11.5, color: TEXT_MUTED }}>
                          Ende-KM <span className="mono" style={{ color: TEXT, fontWeight: 500 }}>{b.endKm !== null ? b.endKm.toLocaleString("de-DE") : "–"}</span>
                        </span>
                        <span style={{ fontSize: 11.5, color: TEXT_MUTED }}>
                          KM-Woche <span className="mono" style={{ color: TEXT, fontWeight: 500 }}>{b.wochenKm !== null ? b.wochenKm.toLocaleString("de-DE") + " km" : "–"}</span>
                        </span>
                        <span style={{ fontSize: 11.5, color: TEXT_MUTED }}>
                          Einsatztage <span className="mono" style={{ color: TEXT, fontWeight: 500 }}>{b.einsatztage}</span>
                        </span>
                        <span style={{ fontSize: 11.5, color: TEXT_MUTED }}>
                          Ø pro Tag <span className="mono" style={{ color: TEXT, fontWeight: 500 }}>{euro(b.proTag)}</span>
                        </span>
                        {inactive && (
                          <span style={{ background: "#EDEFF2", color: TEXT_MUTED, fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 20 }}>
                            {b.status}
                          </span>
                        )}
                        {keineTouren && (
                          <span style={{ background: WARN_BG, color: AMBER_DARK, fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 20 }}>
                            Keine Touren erfasst
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                        <span style={{ fontSize: 12.5, color: TEXT_MUTED }}>
                          {b.touren.length} {b.touren.length === 1 ? "Tour" : "Touren"}
                        </span>
                        <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{euro(b.summe)}</span>
                      </div>
                    </div>
                    {b.touren.length > 0 && (
                      <div style={{ overflowX: "auto" }}>
                        {/* table-layout:fixed + feste Spaltenbreiten (colgroup): ohne das berechnet
                            jede Block-Tabelle ihre Spaltenbreiten unabhängig vom Inhalt - lange Werte
                            (z. B. Kunde "Gadot Germany") verschieben dann die Spalten eines Blocks
                            gegenüber den anderen Blöcken ("Spalten verrutscht" zwischen den LKW-Blöcken). */}
                        <table style={{ minWidth: 1300, tableLayout: "fixed", width: "100%" }}>
                          <colgroup>
                            <col style={{ width: "7%" }} />
                            <col style={{ width: "8%" }} />
                            <col style={{ width: "13%" }} />
                            <col style={{ width: "9%" }} />
                            <col style={{ width: "5%" }} />
                            <col style={{ width: "5%" }} />
                            <col style={{ width: "6%" }} />
                            <col style={{ width: "5%" }} />
                            <col style={{ width: "5%" }} />
                            <col style={{ width: "6%" }} />
                            <col style={{ width: "6%" }} />
                            <col style={{ width: "5%" }} />
                            <col style={{ width: "5%" }} />
                            <col style={{ width: "7%" }} />
                            <col style={{ width: "8%" }} />
                          </colgroup>
                          <thead>
                            <tr>
                              <th style={{ whiteSpace: "nowrap" }}>Datum</th>
                              <th style={ellipsisCell}>Fahrer</th>
                              <th style={ellipsisCell}>Kunde</th>
                              <th style={ellipsisCell}>Auftrags-Nr.</th>
                              <th style={{ whiteSpace: "nowrap" }}>Ankunft</th>
                              <th style={{ whiteSpace: "nowrap" }}>Abfahrt</th>
                              {COSTFIELDS.map((k) => (
                                <th key={k} style={{ textAlign: "right", whiteSpace: "nowrap" }}>{COSTFIELD_LABELS[k]}</th>
                              ))}
                              <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>Gesamt</th>
                              <th style={{ whiteSpace: "nowrap" }}>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {b.touren.map((t) => {
                              const sc = statusColors(t.status);
                              return (
                                <tr key={t.id} onDoubleClick={() => openEdit(t)} style={{ cursor: "pointer", background: sc.bg }} title="Doppelklick zum Bearbeiten">
                                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{formatDateDMY(t.datum)}</td>
                                  <td className="ellipsis" style={ellipsisCell} title={t.fahrer}>{t.fahrer}</td>
                                  <td className="ellipsis" style={ellipsisCell} title={t.kunde}>{t.kunde}</td>
                                  <td className="mono ellipsis" style={ellipsisCell} title={t.auftragsNr}>{t.auftragsNr}</td>
                                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{t.ankunft}</td>
                                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{t.abfahrt}</td>
                                  {COSTFIELDS.map((k) => (
                                    <td key={k} className="mono" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{euro(t[k])}</td>
                                  ))}
                                  <td className="mono" style={{ textAlign: "right", whiteSpace: "nowrap", fontWeight: 700 }}>{euro(gesamt(t))}</td>
                                  <td style={{ whiteSpace: "nowrap" }}>
                                    <span style={{ color: sc.text, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>
                                      {t.status}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "import" && (
          <div style={{ maxWidth: 640 }}>
            <PageHeading icon={Upload} title="Import" />
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Touren importieren</div>
              <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 16 }}>
                JSON-Datei auswählen (z. B. aus einer früheren Excel-Liste aufbereitet). Bereits
                vorhandene Touren (gleiches Datum + LKW + Auftrags-Nr.) werden automatisch übersprungen.
              </div>
              <input type="file" accept=".json" onChange={handleImportFile} />
              {importStatus && (
                <div style={{ marginTop: 14, fontSize: 13, color: MARINE, background: BG, borderRadius: 8, padding: "10px 14px" }}>
                  {importStatus}
                </div>
              )}
              {importPreview && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 12.5, marginBottom: 10 }}>
                    Beispiel (erste Zeile): {formatDateDMY(importPreview[0]?.datum)} · {importPreview[0]?.lkw} ·{" "}
                    {importPreview[0]?.kunde || "(kein Kunde)"} · {euro(gesamt(importPreview[0] || {}))}
                  </div>
                  <button className="primary" onClick={confirmImport}>
                    <Upload size={15} /> {importPreview.length} Touren jetzt importieren
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "stamm" && (
          <div style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 20 }}>
            <PageHeading icon={Users} title="Stammdaten" />
            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Fuhrpark</div>
              {fleet.map((f, i) => {
                const usedByTours = tours.filter((t) => t.lkw === f.plate).length;
                const confirming = confirmDeleteFleet === f.plate;
                return (
                  <div key={f.plate} style={{ padding: "8px 0", borderBottom: `1px solid ${BORDER}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="mono" style={{ fontSize: 13, fontWeight: 500, width: 110 }}>{f.plate}</span>
                      {f.note && (
                        <span style={{ background: WARN_BG, color: AMBER_DARK, fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 20 }}>
                          {f.note}
                        </span>
                      )}
                      <span style={{ fontSize: 13, flex: 1 }}>{f.driver}</span>
                      <button className="ghost" style={{ padding: "4px 8px" }}
                        onClick={() => setConfirmDeleteFleet(confirming ? null : f.plate)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <div style={{ marginTop: 6, marginLeft: 118 }}>
                      {editingStartKm !== f.plate && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 11, color: TEXT_MUTED }}>
                            Start-KM:{" "}
                            <span className="mono" style={{ color: TEXT, fontWeight: 500 }}>
                              {f.startKm !== undefined && f.startKm !== "" ? Number(f.startKm).toLocaleString("de-DE") : "–"}
                            </span>
                            {f.startKmDatum ? ` (ab ${formatDateDMY(f.startKmDatum)})` : ""}
                          </span>
                          <button className="ghost" style={{ padding: "2px 6px" }} title="Start-KM bearbeiten" onClick={() => startEditKm(f)}>
                            <Pencil size={11} />
                          </button>
                          {f.startKmHistory && f.startKmHistory.length > 0 && (
                            <button className="ghost" style={{ padding: "2px 6px", fontSize: 10.5 }}
                              onClick={() => setExpandedKmHistory((h) => ({ ...h, [f.plate]: !h[f.plate] }))}>
                              Verlauf ({f.startKmHistory.length})
                            </button>
                          )}
                        </div>
                      )}

                      {editingStartKm === f.plate && !confirmingKmChange && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <input type="number" value={editKmValue} style={{ width: 100 }} onChange={(e) => setEditKmValue(e.target.value)} />
                          <span style={{ fontSize: 11, color: TEXT_MUTED }}>ab</span>
                          <input type="date" value={editKmDatum} style={{ width: 140 }} onChange={(e) => setEditKmDatum(e.target.value)} />
                          <button className="ghost" style={{ padding: "3px 8px", fontSize: 11.5 }} onClick={cancelEditKm}>Abbrechen</button>
                          <button className="primary" style={{ padding: "3px 10px", fontSize: 11.5 }} onClick={() => requestKmSave(f)}>Speichern</button>
                        </div>
                      )}

                      {editingStartKm === f.plate && confirmingKmChange && (
                        <div style={{ background: WARN_BG, borderRadius: 8, padding: "8px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 11.5, color: AMBER_DARK, fontWeight: 500 }}>
                            Start-KM von {f.startKm !== undefined && f.startKm !== "" ? Number(f.startKm).toLocaleString("de-DE") : "–"}
                            {f.startKmDatum ? ` (ab ${formatDateDMY(f.startKmDatum)})` : ""} auf{" "}
                            {editKmValue !== "" ? Number(editKmValue).toLocaleString("de-DE") : "–"}
                            {editKmDatum ? ` (ab ${formatDateDMY(editKmDatum)})` : ""} ändern?
                          </span>
                          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                            <button className="ghost" onClick={cancelEditKm}>Abbrechen</button>
                            <button className="primary" onClick={() => confirmKmSave(f)}>Bestätigen</button>
                          </div>
                        </div>
                      )}

                      {expandedKmHistory[f.plate] && f.startKmHistory && f.startKmHistory.length > 0 && (
                        <div style={{ marginTop: 6, fontSize: 10.5, color: TEXT_MUTED }}>
                          {f.startKmHistory.slice().reverse().map((h) => (
                            <div key={h.id}>
                              {formatDateDMY(h.changedAt)}: {h.from !== "" ? Number(h.from).toLocaleString("de-DE") : "–"}{h.fromDatum ? ` (ab ${formatDateDMY(h.fromDatum)})` : ""}
                              {" → "}
                              {h.to !== "" ? Number(h.to).toLocaleString("de-DE") : "–"}{h.toDatum ? ` (ab ${formatDateDMY(h.toDatum)})` : ""}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {confirming && (
                      <div style={{ marginTop: 8, background: DANGER_BG, borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                        <span style={{ fontSize: 12.5, color: DANGER, fontWeight: 500 }}>
                          {f.plate} wirklich löschen?
                          {usedByTours > 0
                            ? ` Achtung: ${usedByTours} bestehende Tour${usedByTours === 1 ? "" : "en"} referenziert/referenzieren dieses Kennzeichen - diese Touren bleiben erhalten, zeigen das LKW-Feld aber weiter als Text an.`
                            : " Ist in keiner bisherigen Tour verwendet."}
                        </span>
                        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                          <button className="ghost" onClick={() => setConfirmDeleteFleet(null)}>Abbrechen</button>
                          <button className="primary" style={{ background: DANGER, color: "#fff" }}
                            onClick={() => { persistFleet(fleet.filter((x) => x.plate !== f.plate)); setConfirmDeleteFleet(null); }}>
                            Ja, löschen
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
                <input placeholder="Kennzeichen" value={newPlate} onChange={(e) => setNewPlate(e.target.value)} style={{ flex: "1 1 120px" }} />
                <input placeholder="Standard-Fahrer (optional)" value={newDriver} onChange={(e) => setNewDriver(e.target.value)} style={{ flex: "1 1 140px" }} />
                <input placeholder="Start-KM" type="number" style={{ width: 100 }} value={newStartKm} onChange={(e) => setNewStartKm(e.target.value)} />
                <input type="date" title="Start-KM ab Datum" style={{ width: 140 }} value={newStartKmDatum} onChange={(e) => setNewStartKmDatum(e.target.value)} />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: TEXT_MUTED, marginBottom: 0, whiteSpace: "nowrap" }}>
                  <input type="checkbox" style={{ width: "auto" }} checked={newMiete} onChange={(e) => setNewMiete(e.target.checked)} />
                  Miet-LKW
                </label>
                <button className="primary" style={{ whiteSpace: "nowrap" }}
                  onClick={() => {
                    const plate = newPlate.trim();
                    if (!plate) return;
                    // Kennzeichen darf nicht doppelt angelegt werden - sonst würde
                    // fleet.find(...) an anderer Stelle (Einsatzplan, Start-KM, ...)
                    // immer nur den ersten Treffer finden und der zweite Eintrag
                    // wäre unerreichbar.
                    if (fleet.some((f) => f.plate.toLowerCase() === plate.toLowerCase())) {
                      setNewPlate("");
                      return;
                    }
                    persistFleet([...fleet, { plate, driver: newDriver, startKm: newStartKm, startKmDatum: newStartKmDatum, note: newMiete ? "Miet-LKW" : "", startKmHistory: [] }]);
                    setNewPlate(""); setNewDriver(""); setNewStartKm(""); setNewStartKmDatum(""); setNewMiete(false);
                  }}>
                  <PlusCircle size={14} />
                </button>
              </div>
              <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 8 }}>
                Start-KM ist der Kilometerstand, ab dem die Zählung im Einsatzplan losgeht (z. B. Jahresanfang). Der
                Standard-Fahrer ist nur ein Vorschlag - die tatsächliche Zuteilung pro Woche läuft über den Einsatzplan.
              </div>
            </div>

            <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Fahrer</div>
              {drivers.length === 0 && (
                <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 8 }}>Noch keine Fahrer erfasst.</div>
              )}
              {drivers.map((d) => {
                const confirming = confirmDeleteDriver === d.id;
                return (
                  <div key={d.id} style={{ padding: "6px 0", borderBottom: `1px solid ${BORDER}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 13, flex: 1 }}>{d.name}</span>
                      <button className="ghost" style={{ padding: "4px 8px" }}
                        onClick={() => setConfirmDeleteDriver(confirming ? null : d.id)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {confirming && (
                      <div style={{ marginTop: 8, background: DANGER_BG, borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                        <span style={{ fontSize: 12.5, color: DANGER, fontWeight: 500 }}>{d.name} wirklich löschen?</span>
                        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                          <button className="ghost" onClick={() => setConfirmDeleteDriver(null)}>Abbrechen</button>
                          <button className="primary" style={{ background: DANGER, color: "#fff" }}
                            onClick={() => { persistDrivers(drivers.filter((x) => x.id !== d.id)); setConfirmDeleteDriver(null); }}>
                            Ja, löschen
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <input placeholder="Name" value={newDriverName} onChange={(e) => setNewDriverName(e.target.value)} />
                <button className="primary" style={{ whiteSpace: "nowrap" }} onClick={addDriver}>
                  <PlusCircle size={14} />
                </button>
              </div>
              <div style={{ fontSize: 11.5, color: TEXT_MUTED, marginTop: 8 }}>
                Diese Liste ist die Grundlage für die Fahrer-Vorschläge in Einsatzplan, Neue Tour und den Dashboard-Filtern.
              </div>
            </div>
          </div>
        )}
      </div>
      </div>

      {dupWarning && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,42,67,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
          <div style={{ background: CARD, borderRadius: 12, padding: 24, width: 520 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <AlertTriangle size={18} color={AMBER_DARK} />
              <div style={{ fontSize: 15, fontWeight: 600 }}>Auftrags-Nr. existiert bereits</div>
            </div>
            <div style={{ fontSize: 12.5, color: TEXT_MUTED, marginBottom: 14 }}>
              "{form.auftragsNr}" ist schon {dupWarning.length === 1 ? "einmal" : `${dupWarning.length}-mal`} erfasst. Falls es wirklich dieselbe Tour ist, "Bearbeiten" wählen – ansonsten trotzdem als neue Tour speichern.
            </div>
            <div style={{ border: `1px solid ${BORDER}`, borderRadius: 8, overflow: "hidden", marginBottom: 18 }}>
              {dupWarning.map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: `1px solid ${BORDER}` }}>
                  <span className="mono" style={{ fontSize: 12.5, width: 90 }}>{formatDateDMY(t.datum)}</span>
                  <span className="mono" style={{ fontSize: 12.5, width: 80 }}>{t.lkw}</span>
                  <span style={{ fontSize: 12.5, flex: 1 }}>{t.kunde}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: statusColors(t.status).text, background: statusColors(t.status).bg, padding: "2px 8px", borderRadius: 20 }}>{t.status}</span>
                  <button className="ghost" style={{ padding: "4px 8px" }} onClick={() => editFromWarning(t)}>
                    <Pencil size={12} /> Bearbeiten
                  </button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <button className="ghost" onClick={() => setDupWarning(null)}>Abbrechen</button>
              <button className="primary" onClick={doSaveTour}>Trotzdem speichern</button>
            </div>
          </div>
        </div>
      )}

      {editId && editForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,42,67,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ background: CARD, borderRadius: 12, padding: 24, width: 560, maxHeight: "85vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Tour bearbeiten</div>
              <button className="ghost" style={{ padding: 6 }} onClick={() => { setEditId(null); setEditForm(null); setConfirmDelete(false); setEditErrors([]); setEditSaveNote(""); }}><X size={15} /></button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div><label>Datum *</label>
                <input type="date" value={editForm.datum} style={fieldStyle("datum", editErrors)}
                  onChange={(e) => {
                    const datum = e.target.value;
                    const diesel = calcDiesel(editForm.km, datum);
                    setEditForm({ ...editForm, datum, ...(diesel !== "" ? { diesel } : {}) });
                    setEditErrors(editErrors.filter((k) => k !== "datum"));
                  }} />
              </div>
              <div><label>LKW *</label>
                <select value={editForm.lkw} style={fieldStyle("lkw", editErrors)}
                  onChange={(e) => { handlePlateChange(e.target.value, setEditForm, editForm, false); setEditErrors(editErrors.filter((k) => k !== "lkw")); }}>
                  <option value="">Auswählen …</option>
                  {fleet.map((f) => <option key={f.plate} value={f.plate}>{f.plate}</option>)}
                </select>
              </div>
              <div><label>Fahrer *</label>
                <select value={editForm.fahrer} style={fieldStyle("fahrer", editErrors)}
                  onChange={(e) => { setEditForm({ ...editForm, fahrer: e.target.value }); setEditErrors(editErrors.filter((k) => k !== "fahrer")); }}>
                  <option value="">Bitte wählen …</option>
                  {driverOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <div><label>Auftrags-Nr. *</label>
                <input value={editForm.auftragsNr} style={fieldStyle("auftragsNr", editErrors)}
                  onChange={(e) => { setEditForm({ ...editForm, auftragsNr: e.target.value }); setEditErrors(editErrors.filter((k) => k !== "auftragsNr")); }} />
              </div>
              <div><label>Container-Nr. *</label>
                <input value={editForm.containerNr} style={fieldStyle("containerNr", editErrors)}
                  onChange={(e) => { setEditForm({ ...editForm, containerNr: e.target.value.toUpperCase() }); setEditErrors(editErrors.filter((k) => k !== "containerNr")); }} />
              </div>
              <div><label>Kunde *</label>
                <input value={editForm.kunde} style={fieldStyle("kunde", editErrors)}
                  onChange={(e) => { setEditForm({ ...editForm, kunde: e.target.value }); setEditErrors(editErrors.filter((k) => k !== "kunde")); }} />
              </div>
              <div><label>PLZ *</label>
                <input value={editForm.plz} style={fieldStyle("plz", editErrors)}
                  onChange={(e) => { setEditForm({ ...editForm, plz: e.target.value }); setEditErrors(editErrors.filter((k) => k !== "plz")); }} />
              </div>
              <div><label>Ort *</label>
                <input value={editForm.ort} style={fieldStyle("ort", editErrors)}
                  onChange={(e) => { setEditForm({ ...editForm, ort: e.target.value }); setEditErrors(editErrors.filter((k) => k !== "ort")); }} />
              </div>
              <div><label>Ankunft *</label>
                <input type="time" value={editForm.ankunft} style={fieldStyle("ankunft", editErrors)}
                  onChange={(e) => { setEditForm({ ...editForm, ankunft: e.target.value }); setEditErrors(editErrors.filter((k) => k !== "ankunft")); }} />
              </div>
              <div><label>Abfahrt *</label>
                <input type="time" value={editForm.abfahrt} style={fieldStyle("abfahrt", editErrors)}
                  onChange={(e) => { setEditForm({ ...editForm, abfahrt: e.target.value }); setEditErrors(editErrors.filter((k) => k !== "abfahrt")); }} />
              </div>
              <div><label>Abrechnungs-KM *</label>
                <input type="number" value={editForm.km} style={fieldStyle("km", editErrors)}
                  onChange={(e) => {
                    const km = e.target.value;
                    const fracht = calcFracht(km);
                    const diesel = calcDiesel(km, editForm.datum);
                    setEditForm({ ...editForm, km, ...(fracht !== "" ? { fracht } : {}), ...(diesel !== "" ? { diesel } : {}) });
                    setEditErrors(editErrors.filter((k) => k !== "km"));
                  }} />
              </div>
              {COSTFIELDS.map((k) => (
                <div key={k}>
                  <label>
                    {COSTFIELD_LABELS[k]}
                    {(k === "fracht" || k === "diesel") && <span style={{ color: TEXT_MUTED }}> · automatisch berechnet</span>}
                  </label>
                  <input type="number" value={editForm[k]} onChange={(e) => setEditForm({ ...editForm, [k]: e.target.value })} />
                </div>
              ))}
              <div style={{ gridColumn: "1 / -1" }}><label>Bemerkungen</label><textarea rows={2} value={editForm.bemerkungen} onChange={(e) => setEditForm({ ...editForm, bemerkungen: e.target.value })} /></div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label>Status *</label>
                <select value={editForm.status} style={statusFieldStyle(editForm.status, editErrors)}
                  onChange={(e) => { setEditForm({ ...editForm, status: e.target.value }); setEditErrors(editErrors.filter((k) => k !== "status")); }}>
                  <option value="">Bitte wählen …</option>
                  <option>Offen</option><option>Reklamiert</option><option>Abgerechnet</option>
                </select>
              </div>
            </div>
            <div style={{ fontSize: 11, color: TEXT_MUTED, marginTop: 10 }}>* Pflichtfeld</div>
            {confirmDelete && (
              <div style={{ marginTop: 16, background: DANGER_BG, borderRadius: 8, padding: "12px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <span style={{ fontSize: 13, color: DANGER, fontWeight: 500 }}>
                  Tour wirklich löschen? Das lässt sich nicht rückgängig machen.
                </span>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button className="ghost" onClick={() => setConfirmDelete(false)}>Abbrechen</button>
                  <button className="primary" style={{ background: DANGER, color: "#fff" }} onClick={() => deleteTour(editId)}>
                    Ja, löschen
                  </button>
                </div>
              </div>
            )}
            {editSaveNote && (
              <div style={{ marginTop: 12, fontSize: 12.5, color: DANGER }}>{editSaveNote}</div>
            )}
            <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between" }}>
              <button className="ghost" style={{ color: DANGER, borderColor: DANGER_BG }} onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Löschen</button>
              <button className="primary" onClick={saveEdit}><Save size={14} /> Speichern</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
