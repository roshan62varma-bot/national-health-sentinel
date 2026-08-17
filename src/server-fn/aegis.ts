import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { MEDICINES, STAFF_ROLES, WARD_TYPES } from "@/lib/aegis/data";
import { buildMockNationalState, buildNationalState } from "@/lib/aegis/engine";
import {
  approveManifestInDb,
  fetchDataset,
  getBedOccupied,
  getStockOnHand,
  insertFlRounds,
  markAttendanceDirect,
  recordAndApplyCapture,
} from "@/lib/aegis/repository";
import { auditShelfPhoto, auditWardPhoto, parseVoiceTranscript } from "@/lib/ai/gemini";
import type { FlRound } from "@/lib/aegis/types";

const hasSupabaseEnv = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Falls back to the deterministic mock dataset when Supabase isn't
 * configured yet, so the UI keeps working while you finish wiring the
 * database — remove the fallback once you're ready to require a real DB.
 */
export const getNationalState = createServerFn({ method: "GET" }).handler(async () => {
  if (!hasSupabaseEnv()) return buildMockNationalState();
  const dataset = await fetchDataset();
  return buildNationalState(dataset);
});

const approveSchema = z.object({
  id: z.string(),
  resourceType: z.string(),
  label: z.string(),
  sourceFacilityId: z.string(),
  destFacilityId: z.string(),
  quantity: z.number(),
  distanceKm: z.number(),
  etaHours: z.number(),
  severity: z.number(),
  daysToStockout: z.number(),
  rationale: z.string(),
  actorId: z.string().nullable(),
});

export const approveManifest = createServerFn({ method: "POST" })
  .validator((data: unknown) => approveSchema.parse(data))
  .handler(async ({ data }) => {
    if (!hasSupabaseEnv()) {
      // Same shape as the DB path, so the client doesn't need to branch —
      // it just won't survive a reload until Supabase is connected.
      return { signatureToken: `SIG-${data.id.slice(3, 12)}-DEMO` };
    }
    const { actorId, ...manifest } = data;
    return approveManifestInDb(manifest, actorId);
  });

const flRoundSchema = z.array(
  z.object({
    id: z.string(),
    roundNumber: z.number(),
    nationId: z.string(),
    nation: z.string(),
    dpEpsilon: z.number(),
    weightsHash: z.string(),
    aggregateAccuracyDelta: z.number(),
    timestamp: z.string(),
  }),
);

/** Persists a batch of rounds computed client-side by BricsPanel's runRound() — the clip/noise/FedAvg math
 *  itself stays a pure client-side demo (no secrets involved); this just makes the ledger durable. */
export const recordFlRounds = createServerFn({ method: "POST" })
  .validator((data: unknown) => flRoundSchema.parse(data))
  .handler(async ({ data }) => {
    if (!hasSupabaseEnv()) return { persisted: false };
    await insertFlRounds(data as FlRound[]);
    return { persisted: true };
  });

const markAttendanceSchema = z.object({
  facilityId: z.string(),
  role: z.enum(["Doctor", "Nurse", "ANM", "Pharmacist"]),
  status: z.enum(["PRESENT", "ABSENT", "COVERING"]),
});

export const markAttendance = createServerFn({ method: "POST" })
  .validator((data: unknown) => markAttendanceSchema.parse(data))
  .handler(async ({ data }) => {
    if (!hasSupabaseEnv()) return { applied: false };
    await markAttendanceDirect(data.facilityId, data.role, data.status);
    return { applied: true };
  });

const voiceSchema = z.object({ facilityId: z.string(), transcript: z.string().min(1) });

export const captureVoice = createServerFn({ method: "POST" })
  .validator((data: unknown) => voiceSchema.parse(data))
  .handler(async ({ data }) => {
    const parsed = await parseVoiceTranscript(data.transcript, {
      facilityId: data.facilityId,
      medicines: MEDICINES.map((m) => ({ id: m.id, name: m.name })),
      staffRoles: STAFF_ROLES,
      wardTypes: WARD_TYPES,
    });
    if (hasSupabaseEnv()) {
      await recordAndApplyCapture({
        facilityId: data.facilityId,
        kind: "VOICE",
        rawTranscript: data.transcript,
        parsed,
        confidence: Number(parsed.confidenceScore ?? 0),
      });
    }
    return parsed;
  });

const shelfSchema = z.object({
  facilityId: z.string(),
  medicineId: z.string(),
  base64Image: z.string(),
  mimeType: z.string(),
});

export const captureShelfPhoto = createServerFn({ method: "POST" })
  .validator((data: unknown) => shelfSchema.parse(data))
  .handler(async ({ data }) => {
    const recordedOnHand = hasSupabaseEnv() ? await getStockOnHand(data.facilityId, data.medicineId) : 0;
    const parsed = await auditShelfPhoto(data.base64Image, data.mimeType, {
      facilityId: data.facilityId,
      medicines: MEDICINES.map((m) => ({ id: m.id, name: m.name })),
      staffRoles: STAFF_ROLES,
      wardTypes: WARD_TYPES,
      recordedOnHand,
      recordedMedicineId: data.medicineId,
    });
    if (hasSupabaseEnv()) {
      await recordAndApplyCapture({
        facilityId: data.facilityId,
        kind: "VISION_SHELF",
        parsed,
        confidence: Number(parsed.confidenceScore ?? 0),
      });
    }
    return parsed;
  });

const wardSchema = z.object({
  facilityId: z.string(),
  wardType: z.string(),
  base64Image: z.string(),
  mimeType: z.string(),
});

export const captureWardPhoto = createServerFn({ method: "POST" })
  .validator((data: unknown) => wardSchema.parse(data))
  .handler(async ({ data }) => {
    const recordedOccupied = hasSupabaseEnv() ? await getBedOccupied(data.facilityId, data.wardType) : 0;
    const parsed = await auditWardPhoto(data.base64Image, data.mimeType, {
      facilityId: data.facilityId,
      medicines: MEDICINES.map((m) => ({ id: m.id, name: m.name })),
      staffRoles: STAFF_ROLES,
      wardTypes: WARD_TYPES,
      recordedOccupied,
      recordedWardType: data.wardType,
    });
    if (hasSupabaseEnv()) {
      await recordAndApplyCapture({
        facilityId: data.facilityId,
        kind: "VISION_WARD",
        parsed,
        confidence: Number(parsed.confidenceScore ?? 0),
      });
    }
    return parsed;
  });
