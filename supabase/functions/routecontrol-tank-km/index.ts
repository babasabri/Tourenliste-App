// routecontrol-tank-km: ermittelt für Tankvorgänge (Tabelle tankvorgaenge) den
// Tachostand (CAN-Bus) zum Tankzeitpunkt aus dem routecontrol-Routenbericht.
//
// Methode: Routenbericht des LKW für Vortag + Tanktag holen (Tankzeit vorher von
// MEZ auf Ortszeit umgerechnet, s. tankZeitLokal) und den Stand an der Säule
// aus den Fahrten davor/danach bestimmen (s. kmZumZeitpunkt). Geprüft gegen
// 29 Tankungen mit an der Säule eingegebenem KM-Stand.
//
// Aufruf (POST, JSON-Body, alles optional):
//   { "ids": [1,2], "alle": false, "maxTage": 40, "debug": false }
//   ohne ids: alle Tankvorgänge ohne Ergebnis (km_rc_status ist leer), bis zu
//   maxTage LKW-Tage pro Aufruf (Laufzeitgrenze) - Antwort enthält "rest".
//   alle=true: auch bereits ermittelte neu berechnen.
// Auth: Login-Token eines App-Nutzers oder Header x-cron-secret.
// Secrets: ROUTECONTROL_EMAIL, ROUTECONTROL_PASSWORD

import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://api.routechip.de";
const TZ = "Europe/Berlin";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const normPlate = (p: string) => String(p || "").toUpperCase().replace(/[\s-]/g, "");

function parseKm(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = Number(String(v).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function berlinOffsetMin(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - d.getTime()) / 60000);
}
function berlinToUtc(y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, mi, s, ms));
  const off1 = berlinOffsetMin(guess);
  const t = new Date(guess.getTime() - off1 * 60000);
  const off2 = berlinOffsetMin(t);
  return off2 === off1 ? t : new Date(guess.getTime() - off2 * 60000);
}

// Datum/Zeit aus dem Bericht ("01.10.2026"/"2026-10-01", "14:31"/"14:31:05")
// -> vergleichbarer Ortszeit-Schlüssel "2026-10-01 14:31:05"
function lokalSchluessel(datum: unknown, zeit: unknown): string | null {
  const d = String(datum ?? "").trim();
  let iso: string | null = null;
  let m = d.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) iso = `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) iso = `${m[1]}-${m[2]}-${m[3]}`;
  if (!iso) return null;
  const z = String(zeit ?? "").trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/) ?? d.match(/[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!z) return null;
  return `${iso} ${z[1].padStart(2, "0")}:${z[2]}:${z[3] ?? "00"}`;
}
function plusMinuten(schluessel: string, min: number): string {
  const [d, t] = schluessel.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map(Number);
  const x = new Date(Date.UTC(y, mo - 1, da, h, mi + min, s));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getUTCFullYear()}-${p(x.getUTCMonth() + 1)}-${p(x.getUTCDate())} ${p(x.getUTCHours())}:${p(x.getUTCMinutes())}:${p(x.getUTCSeconds())}`;
}

const rcHeaders = (token?: string) => ({
  "Accept": "application/json, text/plain, */*", "Content-Type": "application/json",
  "Language": "de", "From": "RC-Web-App", ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function rcLogin(): Promise<string> {
  const email = Deno.env.get("ROUTECONTROL_EMAIL");
  const password = Deno.env.get("ROUTECONTROL_PASSWORD");
  if (!email || !password) throw new Error("routecontrol-Zugangsdaten fehlen (Secrets ROUTECONTROL_EMAIL / ROUTECONTROL_PASSWORD).");
  const r = await fetch(`${API}/login`, { method: "POST", headers: rcHeaders(), body: JSON.stringify({ role_group: "company", email, password }) });
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch { /* */ }
  const token = j?.token ?? j?.data?.token;
  if (!r.ok || !token) throw new Error(`routecontrol-Login fehlgeschlagen (HTTP ${r.status})`);
  return token;
}

async function rcVehicles(token: string): Promise<{ id: number; plate: string }[]> {
  const r = await fetch(`${API}/vehicles-and-vehicle-groups`, { headers: rcHeaders(token) });
  if (!r.ok) throw new Error(`Fahrzeugliste: HTTP ${r.status}`);
  const j = await r.json();
  return (j?.data ?? []).map((v: any) => ({ id: v.id, plate: v.license_plate || v.name }));
}

type Fahrt = { start: string | null; ende: string | null; startKm: number | null; endKm: number | null; roh?: any };

// Alle Fahrten eines Fahrzeugs von (tag-3) 00:00 bis (tag+1) 02:00 Ortszeit
// (3 Tage zurück, damit auch nach einem Wochenende ohne Fahrten der letzte Stand da ist)
async function rcFahrten(token: string, vehicleId: number, isoTag: string): Promise<{ fahrten: Fahrt[]; roh: any[] }> {
  const [y, m, d] = isoTag.split("-").map(Number);
  const vortag = new Date(Date.UTC(y, m - 1, d - 3));
  const from = berlinToUtc(vortag.getUTCFullYear(), vortag.getUTCMonth() + 1, vortag.getUTCDate());
  const to = berlinToUtc(y, m, d + 1, 2, 0, 0); // bis 02:00 Folgetag (Tankung kurz vor Mitternacht MEZ)
  const off = berlinOffsetMin(to);
  const fahrten: Fahrt[] = [];
  const roh: any[] = [];
  const limit = 200;
  for (let page = 1; page < 20; page++) {
    const r = await fetch(`${API}/reports/route-report`, {
      method: "POST", headers: rcHeaders(token),
      body: JSON.stringify({
        vehicle_ids: [vehicleId], from_date: from.toISOString(), to_date: to.toISOString(),
        response_type: "json", language: "de", response_type_format: "base64",
        utc_timezone_offset: -off, is_dst_active: off === 120,
        page, limit, sort_by: "", direction: "asc",
      }),
    });
    if (r.status === 404) break; // routecontrol: keine Fahrten im Zeitraum
    if (!r.ok) throw new Error(`Routenbericht Fahrzeug ${vehicleId}: HTTP ${r.status}`);
    const j = await r.json();
    const rows: any[] = Array.isArray(j?.report) ? j.report : Array.isArray(j?.data) ? j.data : [];
    for (const row of rows) {
      if (row?.vehicle_id != null && row.vehicle_id !== vehicleId) continue;
      if (roh.length < 4) roh.push(row);
      fahrten.push({
        start: lokalSchluessel(row?.start_point_date, row?.start_point_time),
        ende: lokalSchluessel(row?.end_point_date, row?.end_point_time),
        startKm: parseKm(row?.start_km),
        endKm: parseKm(row?.end_km),
      });
    }
    if (rows.length < limit) break;
  }
  return { fahrten, roh };
}

// Fahrten mit offensichtlich falschem Tachostand verwerfen (z. B. CAN-Aussetzer
// "11 km" mitten im Jahr): Abweichung > 5.000 km vom Median des Zeitraums.
function plausibleFahrten(fahrten: Fahrt[]): Fahrt[] {
  const werte = fahrten.flatMap((f) => [f.startKm, f.endKm]).filter((k): k is number => k != null && k > 0).sort((a, b) => a - b);
  if (werte.length === 0) return [];
  const median = werte[Math.floor(werte.length / 2)];
  const ok = (k: number | null) => k != null && k > 0 && Math.abs(k - median) <= 5000;
  return fahrten.filter((f) => f.start && f.ende && ok(f.startKm) && ok(f.endKm));
}

// KM-Stand zum Tankzeitpunkt. Belegzeit und routecontrol-Zeit können ein paar
// Minuten auseinanderliegen (in beide Richtungen), daher:
//  - f = letzte Fahrt, die bis Tankzeit (+2 Min.) begonnen hat
//  - beginnt f erst kurz vor der Tankzeit (ab -3 Min.): Abfahrt nach dem
//    Tanken -> Start-KM von f
//  - endet f spätestens 20 Min. nach der Tankzeit: das ist die Anfahrt zur
//    Tankstelle -> End-KM von f
//  - endet f später: der LKW ist während/nach dem Tanken losgefahren ->
//    Start-KM von f (= Stand an der Säule)
//  - keine Fahrt davor: Start-KM der ersten Fahrt danach
function kmZumZeitpunkt(alle: Fahrt[], tank: string) {
  const fahrten = plausibleFahrten(alle);
  const startGrenze = plusMinuten(tank, 2);
  let f: Fahrt | null = null;
  let nachher: Fahrt | null = null;
  for (const x of fahrten) {
    if (x.start! <= startGrenze) { if (!f || x.start! > f.start!) f = x; }
    else if (!nachher || x.start! < nachher.start!) nachher = x;
  }
  if (f) {
    if (f.start! >= plusMinuten(tank, -3)) return { km: Math.floor(f.startKm!), standVom: f.start };
    if (f.ende! <= plusMinuten(tank, 20)) return { km: Math.floor(f.endKm!), standVom: f.ende };
    return { km: Math.floor(f.startKm!), standVom: f.start };
  }
  if (nachher) return { km: Math.floor(nachher.startKm!), standVom: nachher.start };
  return null;
}

// Tankpool druckt die Uhrzeit ganzjährig in Winterzeit (MEZ, UTC+1) - geprüft
// an Tankungen mit an der Säule eingegebenem KM-Stand (Sept./Okt. 2026: erst
// mit +1 Std. passt der Säulen-KM exakt zum Fahrtende in routecontrol).
// Während der Sommerzeit daher +1 Stunde auf Berliner Ortszeit umrechnen.
function tankZeitLokal(datum: string, zeit: string): string {
  const [y, m, d] = datum.split("-").map(Number);
  const offset = berlinOffsetMin(new Date(Date.UTC(y, m - 1, d, 11)));
  return plusMinuten(`${datum} ${zeit.slice(0, 5)}:00`, offset - 60);
}

// Ortszeit-Schlüssel -> timestamptz (für km_rc_stand_vom)
function schluesselZuIso(s: string): string {
  const [d, t] = s.split(" ");
  const [y, m, da] = d.split("-").map(Number);
  const [h, mi, se] = t.split(":").map(Number);
  return berlinToUtc(y, m, da, h, mi, se).toISOString();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let cronSecret = Deno.env.get("ROUTECONTROL_CRON_SECRET") || "";
  if (!cronSecret) {
    const { data: cfg } = await supabase.from("app_config").select("value").eq("key", "routecontrol_cron_secret").maybeSingle();
    cronSecret = cfg?.value || "";
  }
  const viaCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
  if (!viaCron) {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data, error } = jwt ? await supabase.auth.getUser(jwt) : { data: null, error: true } as any;
    if (error || !data?.user) return json({ ok: false, fehler: "Nicht angemeldet." }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const ids: number[] | null = Array.isArray(body?.ids) && body.ids.length ? body.ids.map(Number) : null;
  const alle = !!body?.alle;
  const maxTage = Math.min(Number(body?.maxTage) || 40, 120);
  const debug = !!body?.debug;

  try {
    let q = supabase.from("tankvorgaenge").select("id,lkw,datum,zeit").not("zeit", "is", null).order("datum");
    if (ids) q = q.in("id", ids);
    else if (!alle) q = q.is("km_rc_status", null);
    const { data: offen, error } = await q.limit(5000);
    if (error) throw new Error(error.message);

    const token = await rcLogin();
    const fz = new Map((await rcVehicles(token)).map((v) => [normPlate(v.plate), v.id]));

    // nach LKW + Tag gruppieren (ein Berichtsabruf je Gruppe)
    const gruppen = new Map<string, any[]>();
    for (const t of offen ?? []) {
      const k = `${t.lkw}|${t.datum}`;
      if (!gruppen.has(k)) gruppen.set(k, []);
      gruppen.get(k)!.push(t);
    }
    const keys = Array.from(gruppen.keys());
    const jetzt = keys.slice(0, maxTage);
    const stat = { ok: 0, keine_fahrten: 0, kein_fahrzeug: 0, fehler: 0 };
    const debugOut: any[] = [];
    const fehlerDetails: string[] = [];

    for (const k of jetzt) {
      const [lkw, datum] = k.split("|");
      const liste = gruppen.get(k)!;
      const vid = fz.get(normPlate(lkw));
      const now = new Date().toISOString();
      if (vid == null) {
        await supabase.from("tankvorgaenge").update({ km_rc_status: "kein_fahrzeug", km_rc_abgerufen_am: now }).in("id", liste.map((t) => t.id));
        stat.kein_fahrzeug += liste.length;
        continue;
      }
      try {
        const { fahrten, roh } = await rcFahrten(token, vid, datum);
        if (debug && debugOut.length < 3) debugOut.push({ lkw, datum, anzahl: fahrten.length });
        for (const t of liste) {
          const tank = tankZeitLokal(datum, String(t.zeit));
          const r = kmZumZeitpunkt(fahrten, tank);
          const upd = r
            ? { km_rc: r.km, km_rc_stand_vom: schluesselZuIso(r.standVom!), km_rc_status: "ok", km_rc_abgerufen_am: now }
            : { km_rc: null, km_rc_stand_vom: null, km_rc_status: "keine_fahrten", km_rc_abgerufen_am: now };
          if (!debug) await supabase.from("tankvorgaenge").update(upd).eq("id", t.id);
          stat[r ? "ok" : "keine_fahrten"]++;
          if (debug && debugOut.length <= 3) {
            const nah = fahrten.filter((f) => (f.ende ?? "") >= plusMinuten(tank, -240) && (f.start ?? "") <= plusMinuten(tank, 240))
              .map((f) => `${f.start} → ${f.ende}  ${f.startKm} → ${f.endKm}`);
            debugOut[debugOut.length - 1].ergebnis = [...(debugOut[debugOut.length - 1].ergebnis ?? []), { tank, r, nah }];
          }
        }
      } catch (e) {
        if (!debug) await supabase.from("tankvorgaenge").update({ km_rc_status: "fehler", km_rc_abgerufen_am: now }).in("id", liste.map((t) => t.id));
        stat.fehler += liste.length;
        fehlerDetails.push(`${lkw} ${datum}: ${(e as Error).message}`);
      }
    }
    return json({ ok: true, debug, verarbeiteteTage: jetzt.length, restTage: keys.length - jetzt.length, ergebnis: stat, fehlerDetails, ...(debug ? { debugOut } : {}) });
  } catch (e) {
    return json({ ok: false, fehler: (e as Error).message }, 500);
  }
});
