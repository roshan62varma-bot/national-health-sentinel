/**
 * Server-only Gemini integration. Never import this from a route or
 * component — the API key must stay server-side. Called exclusively from
 * src/server-fn/aegis.ts.
 *
 * Model naming churns fast on Google's side (gemini-1.5-flash and 2.0 are
 * both fully shut down as of mid-2026). GEMINI_MODEL below was current as of
 * August 2026 — check https://ai.google.dev/gemini-api/docs/models before
 * you ship if it's been a while.
 */
const GEMINI_MODEL = "gemini-3.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

interface FacilityContext {
  facilityId: string;
  medicines: { id: string; name: string }[];
  staffRoles: string[];
  wardTypes: string[];
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set. Add it as a server secret before using voice/vision capture.");
  return key;
}

async function callGemini(parts: unknown[], schema: object): Promise<Record<string, unknown>> {
  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.1, // structured extraction, not creative generation
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no structured content.");
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------- voice

const VOICE_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["INVENTORY", "BED", "ATTENDANCE", "UNKNOWN"] },
    medicineId: { type: "string" },
    quantityChange: { type: "number" },
    type: { type: "string", enum: ["INFLOW", "OUTFLOW"] },
    wardType: { type: "string" },
    bedsOccupied: { type: "number" },
    role: { type: "string" },
    status: { type: "string", enum: ["PRESENT", "ABSENT", "COVERING"] },
    coveringForRole: { type: "string" },
    confidenceScore: { type: "number" },
  },
  required: ["intent", "confidenceScore"],
};

export async function parseVoiceTranscript(transcript: string, ctx: FacilityContext) {
  const prompt = [
    "You are the ledger-parsing engine for a PHC field app. The transcript may mix languages",
    "(e.g. Hindi/English code-switching, Portuguese). Classify it into exactly one intent and",
    "extract only the fields that intent needs, leaving the rest absent. Match medicine and",
    "ward/role names to the closest id/name in the provided lists — never invent an id that",
    "isn't listed. If nothing in the transcript matches a known intent, return intent: UNKNOWN",
    "with a low confidenceScore rather than guessing.",
    "",
    `Known medicines: ${ctx.medicines.map((m) => `${m.id}=${m.name}`).join(", ")}`,
    `Known ward types: ${ctx.wardTypes.join(", ")}`,
    `Known staff roles: ${ctx.staffRoles.join(", ")}`,
    "",
    `Transcript: "${transcript}"`,
  ].join("\n");

  return callGemini([{ text: prompt }], VOICE_SCHEMA);
}

// ---------------------------------------------------------------- vision: shelf

const SHELF_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["INVENTORY"] },
    medicineId: { type: "string" },
    brandNameDetected: { type: "string" },
    boxesCounted: { type: "number" },
    expiryDateDetected: { type: "string" },
    quantityChange: { type: "number" },
    type: { type: "string", enum: ["INFLOW", "OUTFLOW"] },
    mismatchFlag: { type: "boolean" },
    mismatchNote: { type: "string" },
    confidenceScore: { type: "number" },
  },
  required: ["boxesCounted", "confidenceScore"],
};

export async function auditShelfPhoto(base64Image: string, mimeType: string, ctx: FacilityContext & { recordedOnHand: number; recordedMedicineId: string }) {
  const prompt = [
    "You are auditing a medicine shelf photo against the recorded ledger for a PHC. Count boxes",
    "visible on the shelf, read the brand name and any visible expiry date, and match to the",
    "closest known medicine id. Set quantityChange/type as the delta needed to correct the ledger",
    "from the recorded on-hand figure to what you counted (INFLOW if you counted more than",
    "recorded, OUTFLOW if less). Flag mismatchFlag=true if the counted quantity differs from the",
    "recorded on-hand figure by more than 10%.",
    "",
    `Known medicines: ${ctx.medicines.map((m) => `${m.id}=${m.name}`).join(", ")}`,
    `Recorded medicine: ${ctx.recordedMedicineId}, recorded on-hand: ${ctx.recordedOnHand}`,
  ].join("\n");

  return callGemini(
    [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Image } }],
    SHELF_SCHEMA,
  );
}

// ---------------------------------------------------------------- vision: ward

const WARD_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["BED"] },
    wardType: { type: "string" },
    totalEstimate: { type: "number" },
    occupiedEstimate: { type: "number" },
    mismatchFlag: { type: "boolean" },
    confidenceScore: { type: "number" },
  },
  required: ["wardType", "occupiedEstimate", "confidenceScore"],
};

export async function auditWardPhoto(base64Image: string, mimeType: string, ctx: FacilityContext & { recordedOccupied: number; recordedWardType: string }) {
  const prompt = [
    "You are auditing a hospital ward photo to estimate bed occupancy. Count occupied vs. vacant",
    "beds visible in the photo. Match wardType to the closest known ward type. Flag",
    "mismatchFlag=true if your occupied estimate differs from the recorded figure by more than 1 bed.",
    "",
    `Known ward types: ${ctx.wardTypes.join(", ")}`,
    `Recorded ward: ${ctx.recordedWardType}, recorded occupied: ${ctx.recordedOccupied}`,
  ].join("\n");

  return callGemini(
    [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64Image } }],
    WARD_SCHEMA,
  );
}
