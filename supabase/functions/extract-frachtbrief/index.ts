// Edge Function: extract-frachtbrief
//
// Nimmt einen fotografierten/gescannten Frachtbrief (PDF oder Foto, base64)
// entgegen, schickt ihn serverseitig an die Anthropic Messages API (Claude)
// und liefert die erkannten Tour-Felder als strukturiertes JSON zurück.
//
// WICHTIG: Das ist eine Vorausfüll-Hilfe, kein Ersatz für die Prüfung durch
// den Disponenten. Handschrift ist nicht immer eindeutig lesbar, deshalb
// muss die aufrufende App die Werte im "Neue Tour"-Formular anzeigen und
// den Disponenten vor dem Speichern bestätigen lassen. Felder, bei denen
// sich Claude selbst unsicher ist, werden zusätzlich in "unsichereFelder"
// gemeldet, damit die UI sie hervorheben kann.
//
// Erwarteter Request-Body (POST, JSON):
//   { "fileBase64": "<base64>", "mediaType": "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif",
//     "knownPlates": ["OF-RY 800", ...] }
//
// knownPlates (optional): die aktuellen Kennzeichen aus den Fuhrpark-Stammdaten.
// Werden mitgeschickt, damit das handschriftliche Kennzeichen gegen die
// tatsächlich existierenden LKW abgeglichen werden kann, statt es rein aus
// der (oft schwer leserlichen) Handschrift zu erraten - bei einem kleinen,
// festen Fuhrpark deutlich zuverlässiger als freie OCR.
//
// Antwort bei Erfolg:
//   { "data": { datum, lkw, auftragsNr, containerNr, kunde, plz, ort, ankunft, abfahrt, km, gefahrgutErkannt, unsichereFelder } }
// Antwort bei Fehler:
//   { "error": "<Text für den Nutzer>" }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
// Haiku 4.5: reicht für strukturierte Datenextraktion und ist bei den hier
// anfallenden Mengen (~3000 Frachtbriefe/Jahr) deutlich günstiger als Sonnet.
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Tool-Schema für strukturierte Extraktion (tool_choice erzwingt diesen
// Aufruf) statt Freitext-JSON zu parsen - liefert immer vollständige,
// vorhersagbare Felder.
const EXTRACTION_TOOL = {
  name: "frachtbrief_daten",
  description:
    "Aus einem Frachtbrief (Contargo Trucking Order) erkannte Tour-Daten. " +
    "Trage für jedes Feld exakt das ein, was auf dem Dokument steht (gedruckt " +
    "oder handschriftlich nachgetragen). Ist ein Feld nicht vorhanden oder " +
    "nicht sicher lesbar, trage einen leeren String ein und liste den " +
    "Feldnamen zusätzlich in unsichereFelder auf statt zu raten.",
  input_schema: {
    type: "object",
    properties: {
      datum: {
        type: "string",
        description:
          "Datum der Tour, Format TT.MM.JJJJ. IMMER aus dem Feld \"GEST.DATUM\" übernehmen " +
          "(Gestellungsdatum, z.B. \"30.09.2026 08:00\" - davon nur den Datumsteil, die Uhrzeit " +
          "hier weglassen). NIEMALS das Feld \"DATUM:\" oben im Kopfbereich des Dokuments " +
          "verwenden - das ist nur das Druck-/Ausstellungsdatum des Dokuments, nicht das " +
          "Tourdatum.",
      },
      lkw: {
        type: "string",
        description:
          "Kfz-Kennzeichen der Zugmaschine (LKW). WICHTIG: Auf diesem Dokumenttyp gibt es KEIN " +
          "Feld, das \"Kennzeichen\" heißt. Der Fahrer schreibt es handschriftlich irgendwo in " +
          "den Kopfbereich des Dokuments - meistens auf oder neben die Zeile " +
          "\"Auftraggeber:\"/\"ORIGINAL\", manchmal aber auch an anderer Stelle ganz oben auf " +
          "der Seite. Suche also den GESAMTEN oberen Bereich des Dokuments gründlich nach " +
          "einer handschriftlichen Eintragung im Format eines deutschen Kfz-Kennzeichens ab " +
          "(1-3 Buchstaben, Bindestrich oder Leerzeichen, 1-2 Buchstaben, Leerzeichen, 1-4 " +
          "Ziffern, z.B. \"OF-RY 800\", \"B-CY 3552\"). Falls eine Liste bekannter Kennzeichen " +
          "mitgegeben wurde, prüfe gezielt, ob die handschriftliche Eintragung zu einem davon " +
          "passt, auch wenn die Handschrift auf den ersten Blick uneindeutig ist - ordne ihr " +
          "im Zweifel das ähnlichste bekannte Kennzeichen zu, statt mit leerem Feld zu melden. " +
          "Nicht verwechseln mit dem Wert im Feld \"CHASSIS:\" weiter unten - das ist eine " +
          "andere, hier nicht benötigte Kennung (z.B. des Anhängers/Chassis) und darf " +
          "NIEMALS als Kennzeichen übernommen werden.",
      },
      auftragsNr: {
        type: "string",
        description:
          "Die interne Auftragsnummer - das ist IMMER der Wert im Feld \"INT. ORDER NO.\" " +
          "(Format: mehrstellige Zahl, Schrägstrich, weitere Ziffer, z.B. \"3500952/1\"). " +
          "NIEMALS das Feld \"EXT. ORDER NO.\" (oft mit Zusatz \"Carrier\" oder \"Merchant\") " +
          "und NIEMALS \"LADENUMMER\" verwenden, auch wenn diese Felder ähnlich aussehen " +
          "oder sogar denselben Wert enthalten wie \"EXT. ORDER NO.\" - beide sind NICHT " +
          "die Auftragsnummer.",
      },
      containerNr: {
        type: "string",
        description:
          "Container-Nummer. WICHTIG: Es stehen manchmal zwei Container-Nummern auf dem " +
          "Dokument (z.B. bei Tausch beim Kunden). Immer nur die oben rechts gedruckte " +
          "Nummer verwenden, niemals eine zusätzliche/zweite Nummer.",
      },
      kunde: {
        type: "string",
        description:
          "Name des Kunden bzw. der Ladestelle - NUR der kurze, gängige Name " +
          "(z.B. \"Pollmeier\"), OHNE Rechtsform-Zusätze wie GmbH, GmbH & Co. KG, " +
          "AG, KG, e.K., auch wenn diese auf dem Dokument mit abgedruckt sind.",
      },
      plz: { type: "string", description: "Postleitzahl der Ladestelle/des Kunden." },
      ort: { type: "string", description: "Ort der Ladestelle/des Kunden." },
      ankunft: {
        type: "string",
        description:
          "Ankunftszeit beim Kunden, Format HH:MM (24h, mit führender Null, z.B. \"08:30\" " +
          "statt \"8:30\", ohne den Zusatz \"Uhr\"). Häufig handschriftlich ergänzt. WICHTIG: " +
          "Die Ankunftszeit liegt IMMER vor der Abfahrtszeit, niemals danach oder gleichzeitig " +
          "- findest du zwei handschriftliche Uhrzeiten und ist nicht eindeutig, welche zu " +
          "welchem Feld gehört, ordne die frühere Uhrzeit der Ankunft zu.",
      },
      abfahrt: {
        type: "string",
        description:
          "Abfahrtszeit beim Kunden, Format HH:MM (24h, mit führender Null, z.B. \"08:30\" " +
          "statt \"8:30\", ohne den Zusatz \"Uhr\"). Häufig handschriftlich und nicht " +
          "immer auf der dafür vorgesehenen Zeile - steht mitunter freihändig in der Nähe " +
          "der Unterschrift/des Unterschriftsfelds. Dort gezielt mitsuchen. WICHTIG: Die " +
          "Abfahrtszeit liegt IMMER nach der Ankunftszeit - findest du zwei handschriftliche " +
          "Uhrzeiten und ist nicht eindeutig, welche zu welchem Feld gehört, ordne die " +
          "spätere Uhrzeit der Abfahrt zu.",
      },
      km: { type: "string", description: "Gefahrene Kilometer laut Frachtbrief, nur die Zahl." },
      gefahrgutErkannt: {
        type: "boolean",
        description:
          "true, wenn auf dem Dokument irgendein Hinweis auf Gefahrgut zu finden ist - z.B. " +
          "ein Stempel, Aufdruck oder handschriftlicher Vermerk \"ADR\", \"Gefahrgut\", " +
          "\"GGVS\"/\"GGVSEB\", \"Gefahrgutklasse\" oder eine UN-Nummer (z.B. \"UN 1203\", " +
          "\"UN1830\"). Sonst false.",
      },
      unsichereFelder: {
        type: "array",
        items: { type: "string" },
        description:
          "Namen aller obigen Felder (z.B. \"abfahrt\", \"lkw\"), bei denen die Erkennung " +
          "unsicher ist: schlecht leserliche Handschrift, mehrdeutige Position, oder das " +
          "Feld fehlt ganz auf dem Dokument.",
      },
    },
    required: [
      "datum",
      "lkw",
      "auftragsNr",
      "containerNr",
      "kunde",
      "plz",
      "ort",
      "ankunft",
      "abfahrt",
      "km",
      "gefahrgutErkannt",
      "unsichereFelder",
    ],
  },
};

const SYSTEM_PROMPT =
  "Du liest Frachtbriefe (Trucking Order, meist vom Typ Contargo) für eine Spedition " +
  "aus und trägst die erkannten Werte über das Tool frachtbrief_daten ein. Die Dokumente " +
  "enthalten gedruckte Felder, die oft handschriftlich vom Fahrer ergänzt wurden (Kennzeichen, " +
  "Uhrzeiten, Kilometer, Unterschrift). Lies sowohl den Druck- als auch den Handschrift-Teil " +
  "sorgfältig, auch abseits der vorgesehenen Zeilen (z.B. am Rand oder nahe der Unterschrift). " +
  "Rate niemals einen Wert, den du nicht sicher lesen kannst - trage in diesem Fall einen " +
  "leeren String ein und melde das Feld in unsichereFelder. Ein Mensch prüft jede Erkennung " +
  "vor dem Speichern.";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Nur POST-Anfragen werden unterstützt." }, 405);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY fehlt in den Edge-Function-Secrets.");
    return jsonResponse({ error: "Texterkennung ist serverseitig nicht konfiguriert." }, 500);
  }

  let body: { fileBase64?: string; mediaType?: string; knownPlates?: string[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Ungültiger Request (JSON erwartet)." }, 400);
  }

  const { fileBase64, mediaType, knownPlates } = body;
  if (!fileBase64 || !mediaType) {
    return jsonResponse({ error: "fileBase64 und mediaType sind erforderlich." }, 400);
  }
  const plateList = Array.isArray(knownPlates) ? knownPlates.filter((p) => typeof p === "string" && p.trim()) : [];

  const isPdf = mediaType === "application/pdf";
  const isImage = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mediaType);
  if (!isPdf && !isImage) {
    return jsonResponse({ error: `Nicht unterstützter Dateityp: ${mediaType}` }, 400);
  }

  const documentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: fileBase64 } };

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: "tool", name: "frachtbrief_daten" },
        messages: [
          {
            role: "user",
            content: [
              documentBlock,
              {
                type: "text",
                text:
                  plateList.length > 0
                    ? "Lies diesen Frachtbrief aus und trage die Daten über frachtbrief_daten ein. " +
                      "Bekannte Kennzeichen aus unserem Fuhrpark (für das Feld \"lkw\" - ordne das " +
                      "handschriftlich eingetragene Kennzeichen, falls möglich, einem dieser Werte " +
                      "zu): " + plateList.join(", ")
                    : "Lies diesen Frachtbrief aus und trage die Daten über frachtbrief_daten ein.",
              },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    console.error("Netzwerkfehler beim Aufruf der Anthropic API:", err);
    return jsonResponse({ error: "Texterkennung ist gerade nicht erreichbar. Bitte später erneut versuchen." }, 502);
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    console.error("Anthropic API Fehler:", anthropicRes.status, errText);
    const msg =
      anthropicRes.status === 429
        ? "Texterkennung ist gerade ausgelastet. Bitte kurz warten und erneut versuchen."
        : `Texterkennung fehlgeschlagen (Status ${anthropicRes.status}).`;
    return jsonResponse({ error: msg }, 502);
  }

  const result = await anthropicRes.json();
  const toolUse = (result.content || []).find(
    (b: { type: string; name?: string }) => b.type === "tool_use" && b.name === "frachtbrief_daten"
  );
  if (!toolUse) {
    console.error("Keine tool_use-Antwort erhalten:", JSON.stringify(result));
    return jsonResponse({ error: "Konnte keine Daten aus dem Frachtbrief extrahieren." }, 502);
  }

  return jsonResponse({ data: toolUse.input });
});
