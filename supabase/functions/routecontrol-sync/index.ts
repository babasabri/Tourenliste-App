// routecontrol-sync: holt Tachostände (CAN-Bus) aus routecontrol (api.routechip.de)
// und schreibt den Wochen-End-KM-Stand je LKW in die Tabelle einsatzplan.
//
// Aufruf (POST, JSON-Body, alles optional):
//   { "jahr": 2026, "kw": 41, "dryRun": true }
//   ohne jahr/kw: aktuelle KW + Vorwoche (Vorwoche wird damit sauber abgeschlossen)
// Auth: entweder Login-Token eines App-Nutzers (Authorization: Bearer <jwt>)
//       oder Header x-cron-secret (für den nächtlichen Zeitplan).
// Secrets: ROUTECONTROL_EMAIL, ROUTECONTROL_PASSWORD (Cron-Schlüssel in app_config)

import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://api.routechip.de";
const TZ = "Europe/Berlin";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// "OF - RY 500" / "B-CY 3552" -> "OFRY500" / "BCY3552"
const normPlate = (p: string) => String(p || "").toUpperCase().replace(/[\s-]/g, "");

// "765.104,24" -> 765104.24
function parseKm(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Offset (Minuten) von Europe/Berlin gegenüber UTC zu einem Zeitpunkt
function berlinOffsetMin(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - d.getTime()) / 60000);
}

// Berlin-Ortszeit (y,m,d,h,mi,s,ms) -> UTC-Date
function berlinToUtc(y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, mi, s, ms));
  const off1 = berlinOffsetMin(guess);
  const t = new Date(guess.getTime() - off1 * 60000);
  const off2 = berlinOffsetMin(t);
  return off2 === off1 ? t : new Date(guess.getTime() - off2 * 60000);
}

// Montag der ISO-KW als (y,m,d)
function isoWeekMonday(jahr: number, kw: number) {
  const jan4 = new Date(Date.UTC(jahr, 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const mon = new Date(jan4.getTime() - (dow - 1) * 86400000 + (kw - 1) * 7 * 86400000);
  return { y: mon.getUTCFullYear(), m: mon.getUTCMonth() + 1, d: mon.getUTCDate() };
}

// ISO-KW eines Zeitpunkts in Berlin
function isoWeekOf(date: Date) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(date).split("-").map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const jahr = d.getUTCFullYear();
  const kw = Math.ceil(((d.getTime() - Date.UTC(jahr, 0, 1)) / 86400000 + 1) / 7);
  return { jahr, kw };
}

function weekRange(jahr: number, kw: number) {
  const mon = isoWeekMonday(jahr, kw);
  const from = berlinToUtc(mon.y, mon.m, mon.d);
  const sunUtc = new Date(Date.UTC(mon.y, mon.m - 1, mon.d + 6));
  const to = berlinToUtc(sunUtc.getUTCFullYear(), sunUtc.getUTCMonth() + 1, sunUtc.getUTCDate(), 23, 59, 59, 999);
  return { from, to };
}

const rcHeaders = (token?: string) => ({
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json",
  "Language": "de",
  "From": "RC-Web-App",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function rcLogin(): Promise<string> {
  const email = Deno.env.get("ROUTECONTROL_EMAIL");
  const password = Deno.env.get("ROUTECONTROL_PASSWORD");
  if (!email || !password) throw new Error("routecontrol-Zugangsdaten fehlen (Secrets ROUTECONTROL_EMAIL / ROUTECONTROL_PASSWORD).");
  const r = await fetch(`${API}/login`, {
    method: "POST", headers: rcHeaders(),
    body: JSON.stringify({ role_group: "company", email, password }),
  });
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch { /* */ }
  const token = j?.token ?? j?.data?.token;
  if (!r.ok || !token) throw new Error(`routecontrol-Login fehlgeschlagen (HTTP ${r.status}): ${(j?.message ?? t).toString().slice(0, 200)}`);
  return token;
}

async function rcVehicles(token: string): Promise<{ id: number; plate: string }[]> {
  const r = await fetch(`${API}/vehicles-and-vehicle-groups`, { headers: rcHeaders(token) });
  if (!r.ok) throw new Error(`Fahrzeugliste: HTTP ${r.status}`);
  const j = await r.json();
  return (j?.data ?? []).map((v: any) => ({ id: v.id, plate: v.license_plate || v.name }));
}

// Höchster Tachostand eines Fahrzeugs im Zeitraum (null = keine Fahrten)
async function rcMaxKm(token: string, vehicleId: number, from: Date, to: Date) {
  const off = berlinOffsetMin(from);
  let page = 1, max: number | null = null, lastEnd: string | null = null, fahrten = 0;
  const limit = 200;
  while (page < 50) {
    const r = await fetch(`${API}/reports/route-report`, {
      method: "POST", headers: rcHeaders(token),
      body: JSON.stringify({
        vehicle_ids: [vehicleId], from_date: from.toISOString(), to_date: to.toISOString(),
        response_type: "json", language: "de", response_type_format: "base64",
        utc_timezone_offset: -off, is_dst_active: off === 120,
        page, limit, sort_by: "", direction: "asc",
      }),
    });
    if (!r.ok) throw new Error(`Routenbericht Fahrzeug ${vehicleId}: HTTP ${r.status}`);
    const j = await r.json();
    const rows: any[] = Array.isArray(j?.report) ? j.report : Array.isArray(j?.data) ? j.data : [];
    for (const row of rows) {
      if (row?.vehicle_id != null && row.vehicle_id !== vehicleId) continue;
      fahrten++;
      for (const k of [parseKm(row?.end_km), parseKm(row?.start_km)]) {
        if (k != null && k > 0 && (max == null || k > max)) { max = k; lastEnd = `${row.end_point_date} ${row.end_point_time}`; }
      }
    }
    if (rows.length < limit) break;
    page++;
  }
  return { max, lastEnd, fahrten };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // --- Berechtigung ---
  let cronSecret = Deno.env.get("ROUTECONTROL_CRON_SECRET") || "";
  if (!cronSecret) {
    const { data: cfg } = await supabase.from("app_config").select("value").eq("key", "routecontrol_cron_secret").maybeSingle();
    cronSecret = cfg?.value || "";
  }
  const viaCron = !!cronSecret && req.headers.get("x-cron-secret") === cronSecret;
  if (!viaCron) {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data, error } = jwt ? await supabase.auth.getUser(jwt) : { data: null, error: true } as any;
    if (error || !data?.user) return json({ ok: false, error: "Nicht angemeldet." }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* leerer Body */ }
  const dryRun = !!body?.dryRun;

  const now = new Date();
  let wochen: { jahr: number; kw: number }[];
  if (body?.jahr && body?.kw) {
    wochen = [{ jahr: Number(body.jahr), kw: Number(body.kw) }];
  } else {
    const aktuell = isoWeekOf(now);
    const vorwoche = isoWeekOf(new Date(now.getTime() - 7 * 86400000));
    wochen = [vorwoche, aktuell];
  }

  const ergebnis: any[] = [];
  let fehler: string | null = null;
  try {
    const { data: fleet, error: fe } = await supabase.from("fleet").select("plate");
    if (fe) throw new Error("Fuhrpark laden: " + fe.message);
    const fleetByNorm = new Map((fleet ?? []).map((f: any) => [normPlate(f.plate), f.plate as string]));

    const token = await rcLogin();
    const fahrzeuge = (await rcVehicles(token))
      .map((v) => ({ ...v, lkw: fleetByNorm.get(normPlate(v.plate)) }))
      .filter((v) => v.lkw); // Fahrzeuge ohne Gegenstück im Fuhrpark (z. B. OF RY 4444) werden ignoriert

    for (const w of wochen) {
      const { from, to } = weekRange(w.jahr, w.kw);
      if (from > now) continue; // Woche liegt in der Zukunft
      const bis = to > now ? now : to;
      for (const v of fahrzeuge) {
        const r = await rcMaxKm(token, v.id, from, bis);
        const eintrag: any = { jahr: w.jahr, kw: w.kw, lkw: v.lkw, fahrten: r.fahrten, km_stand: r.max, stand_vom: r.lastEnd };
        if (r.max == null) { eintrag.aktion = "keine Fahrten – unverändert"; ergebnis.push(eintrag); continue; }
        const km = Math.floor(r.max); // wie Tachoanzeige: Nachkommastellen abschneiden
        eintrag.km_stand = km;
        const { data: zeile, error: ze } = await supabase.from("einsatzplan")
          .select("id,end_km").eq("jahr", w.jahr).eq("kw", w.kw).eq("lkw", v.lkw).maybeSingle();
        if (ze) { eintrag.aktion = "Fehler: " + ze.message; ergebnis.push(eintrag); continue; }
        if (!zeile) {
          // Woche noch nicht angelegt: Fahrer/Status aus der Vorwoche übernehmen
          const vw = isoWeekOf(new Date(from.getTime() - 3 * 86400000));
          const { data: prev } = await supabase.from("einsatzplan")
            .select("fahrer,status").eq("jahr", vw.jahr).eq("kw", vw.kw).eq("lkw", v.lkw).maybeSingle();
          eintrag.vorher = null;
          if (dryRun) { eintrag.aktion = "würde Zeile anlegen"; ergebnis.push(eintrag); continue; }
          const { error: ie } = await supabase.from("einsatzplan").insert({
            jahr: w.jahr, kw: w.kw, lkw: v.lkw, fahrer: prev?.fahrer ?? "", status: prev?.status ?? "Aktiv", end_km: km,
          });
          eintrag.aktion = ie ? "Fehler: " + ie.message : "Zeile angelegt";
          ergebnis.push(eintrag);
          continue;
        }
        eintrag.vorher = zeile.end_km == null ? null : Number(zeile.end_km);
        if (eintrag.vorher === km) { eintrag.aktion = "unverändert"; ergebnis.push(eintrag); continue; }
        if (dryRun) { eintrag.aktion = "würde aktualisiert"; ergebnis.push(eintrag); continue; }
        const { error: ue } = await supabase.from("einsatzplan").update({ end_km: km }).eq("id", zeile.id);
        eintrag.aktion = ue ? "Fehler: " + ue.message : "aktualisiert";
        ergebnis.push(eintrag);
      }
    }
  } catch (e) {
    fehler = (e as Error).message;
  }

  if (!dryRun) {
    await supabase.from("routecontrol_sync_log").insert({
      ausloeser: viaCron ? "zeitplan" : "manuell", ok: !fehler, fehler, details: ergebnis,
    });
  }
  return json({ ok: !fehler, dryRun, fehler, wochen, ergebnis }, fehler ? 500 : 200);
});
