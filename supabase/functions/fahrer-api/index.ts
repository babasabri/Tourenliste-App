// Edge Function: fahrer-api
//
// Schnittstelle für die Fahrer-App (/fahrer). Fahrer haben KEIN Supabase-Konto
// und sehen keine Daten aus der Tourenliste - sie melden sich mit Name + PIN an
// und bekommen ein signiertes Token, mit dem sie nur zwei Dinge dürfen:
// Frachtbriefe hochladen und ihre eigenen gesendeten Briefe sehen.
//
// Aktionen (POST, JSON { action, ... }):
//   fahrer                     -> { fahrer: ["Serdar", ...] }   (nur Fahrer mit PIN)
//   login   { name, pin }      -> { token, name, lkw }
//   me      { token }          -> { name, lkw, briefe: [...] }
//   upload  { token, clientId, pages: [{ b64, w, h }] } -> { id, doppelt? }
//
// Upload: Die Seiten kommen als JPEG (im Handy bereits verkleinert), hier wird
// daraus ein PDF gebaut, im privaten Bucket "frachtbriefe" gespeichert, eine
// Zeile in frachtbrief_eingang angelegt und das Auslesen (bestehende Function
// extract-frachtbrief) im Hintergrund gestartet - der Fahrer muss darauf nicht
// warten.
//
// verify_jwt ist AUS (Fahrer haben kein Supabase-Login); die Prüfung macht
// diese Function selbst über das HMAC-signierte Token.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const TOKEN_TAGE = 180;
const MAX_SEITEN = 8;
const MAX_SEITE_BYTES = 4 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ------------------------------------------------------------- Token (HMAC) --
const enc = new TextEncoder();
let hmacKey: CryptoKey | null = null;
async function key() {
  if (!hmacKey) {
    const raw = await crypto.subtle.digest("SHA-256", enc.encode("fahrer-token:" + SERVICE_KEY));
    hmacKey = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  }
  return hmacKey;
}
function b64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function signToken(name: string, version: number) {
  const payload = b64url(enc.encode(JSON.stringify({ n: name, v: version, e: Date.now() + TOKEN_TAGE * 864e5 })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(), enc.encode(payload)));
  return payload + "." + b64url(sig);
}
// Prüft Signatur, Ablauf und ob die PIN seitdem geändert/entzogen wurde.
async function checkToken(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await key(), fromB64url(sig), enc.encode(payload));
  } catch { return null; }
  if (!ok) return null;
  let p: { n: string; v: number; e: number };
  try { p = JSON.parse(new TextDecoder().decode(fromB64url(payload))); } catch { return null; }
  if (!p.n || Date.now() > p.e) return null;
  const { data } = await supabase.from("fahrer_zugang").select("pin_version, pin_hash").eq("fahrer", p.n).maybeSingle();
  if (!data || data.pin_hash === "!" || data.pin_version !== p.v) return null;
  return p.n;
}

// -------------------------------------------------------------- Hilfen ------
function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { jahr: t.getUTCFullYear(), kw: Math.ceil(((t.getTime() - yearStart.getTime()) / 864e5 + 1) / 7) };
}
function berlinNow() {
  // Datum in deutscher Zeit (für die Kalenderwoche kurz nach Mitternacht wichtig)
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
}
async function lkwFuer(name: string) {
  const { jahr, kw } = isoWeek(berlinNow());
  const { data } = await supabase.from("einsatzplan").select("lkw").eq("jahr", jahr).eq("kw", kw).eq("fahrer", name).limit(1);
  return data && data[0] ? data[0].lkw : null;
}

// Minimaler PDF-Bau aus JPEG-Seiten (JPEG wird unverändert eingebettet).
function buildPdf(pages: { bytes: Uint8Array; w: number; h: number; c: number }[]) {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (x: string | Uint8Array) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    parts.push(b);
    len += b.length;
  };
  const n = pages.length;
  // Objekt-Nummern: 1 Katalog, 2 Seitenbaum, je Seite 3 Objekte (Seite, Inhalt, Bild)
  const pageObj = (i: number) => 3 + i * 3;
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const obj = (num: number, body: () => void) => {
    offsets[num] = len;
    push(`${num} 0 obj\n`);
    body();
    push("\nendobj\n");
  };
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`));
  pages.forEach((p, i) => {
    const pw = 595.28; // A4-Breite in Punkt, Höhe proportional zum Foto
    const ph = Math.round((pw * p.h) / p.w * 100) / 100;
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(pageObj(i), () =>
      push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${pageObj(i) + 2} 0 R >> >> /Contents ${pageObj(i) + 1} 0 R >>`));
    obj(pageObj(i) + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(pageObj(i) + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /${p.c === 1 ? "DeviceGray" : p.c === 4 ? "DeviceCMYK" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`);
      push(p.bytes);
      push("\nendstream");
    });
  });
  const total = 3 + n * 3;
  const xref = len;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  push(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

// Liest echte Pixelmaße aus dem JPEG (SOF-Marker) - nicht dem Handy vertrauen.
function jpegSize(b: Uint8Array): { w: number; h: number; c: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    const segLen = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], c: b[i + 9] };
    }
    i += 2 + segLen;
  }
  return null;
}

// Ruft die bestehende Function extract-frachtbrief auf (gleiche KI-Auslese wie
// beim Hochladen im Büro) und speichert das Ergebnis an der Eingangs-Zeile.
async function auslesen(id: string, file: { b64: string; type: string }) {
  try {
    const { data: fleet } = await supabase.from("fleet").select("plate");
    const res = await fetch(`${SUPABASE_URL}/functions/v1/extract-frachtbrief`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
      body: JSON.stringify({ fileBase64: file.b64, mediaType: file.type, knownPlates: (fleet || []).map((f) => f.plate) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.data) throw new Error(body.error || `Status ${res.status}`);
    await supabase.from("frachtbrief_eingang").update({ extraktion: body.data, auslese_status: "fertig", auslese_fehler: null }).eq("id", id);
  } catch (err) {
    console.error("Auslesen fehlgeschlagen", id, err);
    await supabase.from("frachtbrief_eingang")
      .update({ auslese_status: "fehler", auslese_fehler: String((err as Error)?.message || err).slice(0, 300) }).eq("id", id);
  }
}

// --------------------------------------------------------------- Aktionen ---
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST." }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }

  try {
    switch (body.action) {
      case "fahrer": {
        const { data } = await supabase.from("fahrer_zugang").select("fahrer").neq("pin_hash", "!").order("fahrer");
        return json({ fahrer: (data || []).map((r) => r.fahrer) });
      }

      case "login": {
        const name = String(body.name || "");
        const pin = String(body.pin || "");
        if (!name || !/^[0-9]{4,6}$/.test(pin)) return json({ error: "Name oder PIN fehlt." }, 400);
        const { data: version, error } = await supabase.rpc("fahrer_pin_pruefen", { p_fahrer: name, p_pin: pin });
        if (error) throw error;
        if (version === -1) return json({ error: "Zu viele Fehlversuche. Bitte in 15 Minuten nochmal versuchen." }, 429);
        if (version === null || version === undefined) return json({ error: "PIN falsch." }, 401);
        return json({ token: await signToken(name, version), name, lkw: await lkwFuer(name) });
      }

      case "me": {
        const name = await checkToken(body.token);
        if (!name) return json({ error: "abgemeldet" }, 401);
        const { data } = await supabase.from("frachtbrief_eingang")
          .select("id, client_id, seiten, status, auslese_status, created_at")
          .eq("fahrer", name).order("created_at", { ascending: false }).limit(30);
        return json({ name, lkw: await lkwFuer(name), briefe: data || [] });
      }

      case "upload": {
        const name = await checkToken(body.token);
        if (!name) return json({ error: "abgemeldet" }, 401);
        const clientId = String(body.clientId || "");
        const pagesIn = Array.isArray(body.pages) ? body.pages as { b64: string }[] : [];
        if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) return json({ error: "Ungültige Kennung." }, 400);
        if (pagesIn.length < 1 || pagesIn.length > MAX_SEITEN) return json({ error: `1 bis ${MAX_SEITEN} Seiten erlaubt.` }, 400);

        // Schon da? (Handy hat nach Netzabbruch erneut gesendet) -> einfach bestätigen
        const { data: vorhanden } = await supabase.from("frachtbrief_eingang").select("id").eq("client_id", clientId).maybeSingle();
        if (vorhanden) return json({ id: vorhanden.id, doppelt: true });

        const pages = pagesIn.map((p) => {
          const bytes = Uint8Array.from(atob(String(p.b64 || "")), (c) => c.charCodeAt(0));
          if (bytes.length > MAX_SEITE_BYTES) throw new Error("Seite zu groß.");
          const size = jpegSize(bytes);
          if (!size) throw new Error("Seite ist kein JPEG-Bild.");
          return { bytes, ...size };
        });
        const pdf = buildPdf(pages);

        const jetzt = berlinNow();
        const id = crypto.randomUUID();
        const pfad = `${jetzt.getFullYear()}/${String(jetzt.getMonth() + 1).padStart(2, "0")}/${id}.pdf`;
        const up = await supabase.storage.from("frachtbriefe").upload(pfad, pdf, { contentType: "application/pdf" });
        if (up.error) throw up.error;

        const { error: insErr } = await supabase.from("frachtbrief_eingang").insert({
          id, client_id: clientId, fahrer: name, lkw: await lkwFuer(name),
          seiten: pages.length, datei_pfad: pfad, datei_groesse: pdf.length,
        });
        if (insErr) {
          if (insErr.code === "23505") { // gleichzeitig doppelt gesendet
            await supabase.storage.from("frachtbriefe").remove([pfad]);
            const { data: d } = await supabase.from("frachtbrief_eingang").select("id").eq("client_id", clientId).maybeSingle();
            return json({ id: d?.id, doppelt: true });
          }
          throw insErr;
        }

        // Eine Seite: direkt als Bild auslesen (schärfer); mehrere: als PDF.
        const file = pages.length === 1
          ? { b64: String(pagesIn[0].b64), type: "image/jpeg" }
          : { b64: b64std(pdf), type: "application/pdf" };
        // @ts-ignore EdgeRuntime ist in Supabase verfügbar
        EdgeRuntime.waitUntil(auslesen(id, file));
        return json({ id });
      }

      default:
        return json({ error: "Unbekannte Aktion." }, 400);
    }
  } catch (err) {
    console.error("fahrer-api Fehler:", err);
    return json({ error: "Serverfehler. Bitte später nochmal versuchen." }, 500);
  }
});

function b64std(bytes: Uint8Array) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
