# Setup — real database + real voice/vision capture

This adds a Supabase (Postgres) backend and real Gemini-powered capture on
top of the existing UI and algorithm code, which are untouched. Nothing here
runs yet — three things need to be connected first.

## 1. Connect Supabase

If you're still working in Lovable: **Project Settings → Integrations → add
Supabase** (Lovable provisions the project for you). Otherwise, create a
project at supabase.com.

Either way, grab from the project's API settings:
- Project URL
- `anon` public key
- `service_role` secret key (⚠️ server-only, never expose client-side)

Run the schema:
```bash
# via the Supabase SQL editor: paste supabase/migrations/0001_init.sql, or:
supabase db push
```

Load the existing demo scenario into real rows:
```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed
```

## 2. Add a Gemini API key

Get one at https://aistudio.google.com/apikey. Voice and vision capture
won't work without it — everything else (dashboards, redistribution,
approvals) works fine without Gemini.

## 3. Set environment variables

Copy `.env.example` to `.env` and fill in all five values (or set them as
secrets in Lovable Cloud / your hosting provider — never commit `.env`).

## 4. Install and run

```bash
npm install   # or bun install — pulls in @supabase/supabase-js and tsx, newly added
npm run dev
```

## What still works without any of this configured

`src/server-fn/aegis.ts` checks for Supabase env vars and falls back to the
original seeded mock (`buildMockNationalState()`) if they're absent, so the
UI keeps working while you finish setup. Voice/vision capture calls Gemini
regardless — those need `GEMINI_API_KEY` specifically, independent of
whether Supabase is connected.

## Known follow-ups (flagged, not fixed here)

- **RBAC is enforced in Postgres (RLS) but not yet in the UI** — the sidebar
  still shows a hardcoded "NATIONAL_MINISTRY_ADMIN" label rather than a real
  signed-in user. Wiring Supabase Auth is the natural next step.
- **Bed-transfer direction** — `repository.ts`'s `approveManifestInDb` has a
  comment flagging that the existing surplus→deficit convention (correct for
  medicine/staff) may be backwards for beds, where you'd expect patients to
  move from the over-occupied facility to the one with capacity. Worth a
  decision before this goes further.
- **Offline queue uses localStorage, not IndexedDB** — functional and does
  real background-sync replay of voice captures, but the original spec named
  `idb-keyval` specifically. Swap-in if you want it exactly to spec.
- **Speech recognition needs a language picked up front** (no
  browser-native auto-detect across code-switched languages) — a small
  language selector was added to field.tsx as the pragmatic fix.
