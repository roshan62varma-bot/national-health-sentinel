# Aegis Health Command

AegisHealth BRICS — Master Build Prompt

National Federated Health Resource & Supply Chain Command Platform

0. Role & Mandate

You are a Principal Full-Stack Engineer, Applied ML Engineer, and Product Designer. Build a production-ready, mobile-first Progressive Web App — AegisHealth BRICS — that gives a nation real-time command over its entire Primary Health Centre (PHC) network, forecasts demand, raises early warnings before emergencies bite, auto-recommends cross-district redistribution, and shares predictive intelligence with BRICS partner nations without ever moving raw data across a border.

This document is the single source of truth. Every module below carries the exact decision logic it must implement — treat the formulas as normative, not illustrative. Do not ship a UI shell around mock data; the logic must actually run.

Problem this solves, restated as an engineering contract:

Problem statement requirement System obligation Real-time visibility into medicine stock, beds, personnel — nationally Live 4-tier hierarchy (PHC → District → State → Nation), <5s data freshness on live views Forecast demand Per-facility, per-medicine time-series forecasting, 7-day and 30-day horizons Early warnings for stock-outs during emergencies Composite, weighted, three-signal risk score with auto emergency-mode escalation Automated cross-district redistribution Deficit/surplus matching algorithm producing an executable dispatch manifest Shared predictive modelling across BRICS Federated learning (FedAvg + differential privacy) — weights only, never raw data

1. Technical Architecture

1.1 Frontend / PWA

Framework: Next.js 14+ (App Router), TypeScript, Tailwind CSS, Lucide React icons.

State & offline persistence: Zustand (UI/session state) + idb-keyval (IndexedDB write queue) for offline-first field capture.

PWA core: manifest.json, service worker (Workbox via next-pwa or hand-rolled sw.ts), standalone display mode, installable on Android/iOS home screen.

Caching strategy (be explicit in code comments):

Static assets/app shell → cache-first.

Dashboard GET endpoints (stock levels, bed board, roster) → stale-while-revalidate, so officers see last-known state instantly, refreshed silently.

Write actions (voice ledger entries, approvals) → network-first with background sync: on failure, queue in IndexedDB, retry via the Background Sync API when connectivity returns.

Push notifications: Web Push API wired through the service worker for Red-tier alerts (stock-out <24h, bed occupancy >95%, critical understaffing) — these must reach a District Officer even with the app closed.

Conflict resolution: last-write-wins by server timestamp, with every overwritten offline entry retained in an append-only audit_log table so nothing is silently lost.

1.2 Backend / Intelligence Layer

API gateway: Next.js API routes (/api/*), the only edge-facing surface.

Forecasting & Federated ML microservice: Python + FastAPI, containerized, internal-only, called by the Next.js layer. Owns:

Time-series forecasting (Section 3.1).

Federated learning orchestration (Section 3.4).

Database: PostgreSQL with a hierarchical facility → district → state → nation foreign-key model; TimescaleDB hypertables for stock/bed/attendance time-series feeding the forecaster.

Real-time fan-out: Redis pub/sub → WebSocket/SSE channel pushing live updates to district/state/national dashboards (bed board, stock gauges, roster) without polling.

AI Integrations (Google AI SDK):

gemini-1.5-flash — multilingual voice transcript → structured JSON (inventory / bed / attendance, one schema per intent).

gemini-1.5-flash vision — shelf-audit mode (medicine) and ward-audit mode (bed occupancy from a photo).

Vertex AI / Gemini agent — drafts multi-echelon redistribution manifests in natural language for officer review, backed by the deterministic algorithm in Section 3.2 (the LLM explains and drafts; it does not decide quantities).

2. Data Model

facilities(id, name, type, district_id, state_id, nation_id, lat, lng, catchment_population)

medicines(id, name, who_essential BOOLEAN, unit)
stock_ledger(id, facility_id, medicine_id, batch_number, quantity_change, type, source, created_at)
stock_snapshot(facility_id, medicine_id, on_hand, avg_daily_consumption, updated_at) -- materialized, TimescaleDB continuous aggregate

beds(id, facility_id, ward_type, total, occupied, updated_at)

staff(id, facility_id, role, min_safe_staffing_count)
attendance(id, staff_id, date, status, covering_for_id, source)

forecast_runs(id, facility_id, medicine_id, horizon_days, predicted_demand, model_version, generated_at)
risk_scores(id, facility_id, stock_risk, bed_risk, staff_risk, composite_score, tier, computed_at)

dispatch_manifests(id, resource_type, source_facility_id, dest_facility_id, quantity, distance_km,
                    status, approved_by, signature_token, created_at)

fl_rounds(id, round_number, nation_id, dp_epsilon, weights_hash, aggregate_accuracy_delta, timestamp)

users(id, name, role, facility_id, district_id, state_id, nation_id)
audit_log(id, entity, entity_id, action, actor_id, before, after, created_at)


3. Core Logic — This Is What Makes the System Work

3.1 Demand Forecasting

Model: Prophet (or SARIMA) per (facility_id, medicine_id) pair, trained on stock_ledger daily consumption, with regressors for seasonality (month, monsoon/flu-season flags) and an emergency_mode exogenous flag.

Cold-start rule: facilities with <90 days of history borrow the state-level per-capita consumption rate, scaled by catchment_population, until enough local history accumulates.

Retrain on a rolling nightly batch job; store each run in forecast_runs with a model_version for auditability.

3.2 Cross-District Redistribution Algorithm

This must be a real matching algorithm, not a canned suggestion.

Inventory Position: IP = OnHand + OnOrder − Backorder

Safety Stock: SS = Z × σ_demand × √(LeadTimeDays) (Z = 1.65 for a 95% service level, configurable)

Reorder Point: ROP = (AvgDailyConsumption × LeadTimeDays) + SS

Days of Supply: DoS = OnHand / AvgDailyConsumption

Classify every facility per resource:

Deficit (Red): DoS < 1 day (emergency) or DoS < 3 days (warning)

Surplus: DoS > ROP_days + 14 (configurable buffer)

Match: build a bipartite graph — deficit facilities as sinks, surplus facilities as sources — edges only within a radius (default 35 km medicine / 50 km bed-transfer, haversine distance). Solve as a min-cost flow (or greedy nearest-surplus-first ordered by a priority queue keyed on severity DESC, time-to-stockout ASC) to fully cover deficits at minimum total distance.

Emit a dispatch_manifest row per matched pair with quantity, ETA (distance ÷ assumed transport speed), and status = PENDING_APPROVAL.

Officer action: "One-Click Approve & Dispatch" flips status to APPROVED, stamps a simulated digital signature token, and writes to audit_log. Nothing auto-executes without a human in the loop — this is a recommendation engine with one-tap execution, not autonomous dispatch.

The same algorithm runs for beds (patient transfer routing, matched by ward type) and personnel (short-term secondment from a facility with roster surplus), not medicine alone.

3.3 Composite Early-Warning Score (this is the emergency-detection engine)

StockRisk(f)  = clamp(1 − DoS/3, 0, 1)                 # 0 = 3+ days safe, 1 = out now
BedRisk(f)    = clamp((Occupancy% − 70) / 30, 0, 1)     # 0 at ≤70%, 1 at ≥100%
StaffRisk(f)  = clamp(1 − PresentStaff/MinSafeStaff, 0, 1)

RiskScore(f) = w1·StockRisk + w2·BedRisk + w3·StaffRisk    # default w1=w2=w3=0.33, tunable per emergency type


Tier mapping: Green <0.3, Amber 0.3–0.6, Red >0.6 — these are the same three colors used everywhere in the UI (Section 4), so the score is never abstract to the officer looking at it.

District emergency auto-escalation: if >Y% of facilities in a district hold Red for >X consecutive hours (defaults: 30%, 6h — configurable), the district is auto-flagged EMERGENCY_MODE. This: (a) shortens forecast horizons to 3-day granularity, (b) tightens all Red/Amber thresholds by 20%, (c) raises the redistribution radius by 50% to widen the eligible surplus pool, (d) triggers push alerts to State and National roles.

This is the mechanism that satisfies "generate early warnings for potential stock-outs during health emergencies" — it correlates three signals together rather than waiting for any single metric to cross a line alone.

3.4 Federated Learning Across BRICS (privacy-preserving by construction)

Each nation's FastAPI FL client trains a local forecasting model update on its own (facility, medicine, day) consumption tensors. Nothing leaves the country at this step.

Weight deltas are max-norm clipped, then Gaussian noise is added to satisfy an (ε, δ)-differential-privacy budget (start ε=1.0, configurable) before upload.

A BRICS aggregation coordinator runs FedAvg across participating nations' noised weight updates on a fixed cadence (e.g., weekly), producing an improved global model.

The global model is redistributed; each nation blends it with a locally fine-tuned personalization layer rather than overwriting local weights — so a dengue-surge pattern learned in Brazil can sharpen India's early-signal detection during onset season, without India's facility-level data ever being visible to Brazil, or vice versa.

Log every round in fl_rounds (round number, participating nation, epsilon used, weights hash, accuracy delta) and surface it on the BRICS Network panel — this is the auditable proof that only weights, never records, crossed the border.

3.5 Role-Based Access Control

Role Scope Notes PHC_FIELD_STAFF Own facility only Voice/vision capture, local ledger DISTRICT_OFFICER Own district, all facilities in it Approve dispatch manifests STATE_HEALTH_OFFICIAL Own state, all districts in it Read + escalation override NATIONAL_MINISTRY_ADMIN Whole nation Full roll-up, situation report export BRICS_LIAISON Cross-nation, aggregate only No facility-level drill-down outside own nation — enforced server-side, not just hidden in UI

4. UI/UX — Design System

Grounded in the actual subject: this is an operations console for people managing a nation's supply of medicine, beds, and staff — think dispatch board and vital-sign monitor, not a generic SaaS dashboard. Avoid the templated AI-design defaults (cream+serif+terracotta, near-black+neon, broadsheet-with-hairlines) — none of them fit a clinical command tool.

4.1 Token System

Color — functional first, decorative never:

--bg-console: #12161C (graphite) — desktop/officer dashboards, an ops-room feel for long monitoring sessions

--bg-field: #F7F9FA (clinical white) — mobile field PWA, high daylight/outdoor legibility for PHC staff

--brand-primary: #0E7C86 (Aegis Teal) — primary actions, brand mark; deliberately not the generic medical blue

--risk-critical: #D64545 (Red tier)

--risk-warning: #E2A63B (Amber tier)

--risk-stable: #3E9B5C (Green tier)

These three risk colors are not decoration — they are the literal output of the RiskScore tiers in Section 3.3, used identically on the bed board, stock gauge, staffing panel, and district heatmap, so the color always means the same thing everywhere in the product.

Type:

UI/body: a humanist grotesk (e.g., Public Sans or Inter) — clean, legible at small mobile sizes, unremarkable by design so it never competes with the data.

Data readouts (stock counts, bed numbers, countdown-to-stockout): a monospace face (e.g., IBM Plex Mono or JetBrains Mono) — evokes the digital readout of a real monitoring instrument, and monospacing keeps rapidly-updating numbers from jittering in width as digits change.

Layout:

Field PWA (mobile): single-column, bottom tab bar — [Inventory] [Beds] [Attendance] [Voice/Scan] [Rebalancer]. Large 48px+ tap targets, one primary action per screen.

Officer/National dashboards (desktop, responsive down to tablet): left-rail nav with a hierarchy breadcrumb (Nation > State > District > PHC), main canvas for the heatmap/board, right-drawer for manifest detail on selection.

Signature element — "The Pulse Strip": A persistent horizontal strip pinned to the top of every screen (mobile and desktop alike) rendering three live sparkline waveforms — one each for medicine stock, bed occupancy, and staffing coverage — color-shifting along the Red/Amber/Green scale in real time as RiskScore updates. It is literally the nation's supply chain rendered as vital signs: the one memorable device that ties field, district, and national views into a single visual language, and it is never just decorative — tapping any waveform deep-links into that resource's detail view.

4.2 Wireframe sketches

Mobile field view:

┌─────────────────────────┐
│  ▁▂▃ ▅▇▆ ▂▃▁   ● Online │  ← Pulse Strip + sync pill
├─────────────────────────┤
│  PHC Anantapur           │
│  Emergency banner (if    │
│  district in EMERGENCY)  │
├─────────────────────────┤
│                          │
│   [ 🎙  Hold to speak ]  │  ← primary voice capture action
│                          │
│   Recent entries…        │
│                          │
├─────────────────────────┤
│ [Inv][Bed][Att][Voice][↔]│  ← bottom tab bar
└─────────────────────────┘


National dashboard:

┌──┬──────────────────────────────────────┐
│  │ ▁▂▃ ▅▇▆ ▂▃▁            Nation > All   │  ← Pulse Strip + breadcrumb
│N │────────────────────────────────────────
│a │  District heatmap (Red/Amber/Green)   │
│v │  ┌────┐┌────┐┌────┐┌────┐              │
│  │  │ D1 ││ D2 ││ D3 ││ D4 │  …           │
│  │  └────┘└────┘└────┘└────┘              │
│  │────────────────────────────────────────
│  │  Pending dispatch manifests   [Approve]│
└──┴──────────────────────────────────────┘


4.3 Interaction & content rules

Buttons name the action, not the mechanism: "Approve & Dispatch," never "Submit."

Empty states are an invitation to act ("No pending manifests — the district is balanced" rather than a blank table).

Errors state what happened and how to fix it, never apologize, never go vague ("Voice capture failed — check microphone permission" not "Something went wrong").

Respect prefers-reduced-motion; all interactive elements carry a visible keyboard focus ring (this is a tool officials may use on a projector or via keyboard in a control room).

5. Implementation Deliverables

PWA shell: manifest.json, service worker with the three caching strategies from 1.1, install-prompt handling, offline write queue.

AI routes:

/api/ai/voice-parse/route.ts — inventory / bed / attendance intents, one strict JSON schema per intent.

/api/ai/vision-audit/route.ts — shelf mode and ward mode.

/api/ai/redistribute/route.ts — wraps the Section 3.2 algorithm; LLM drafts the human-readable manifest summary, the algorithm decides the numbers.

FastAPI microservice:

/forecast/{facility_id}/{medicine_id} implementing 3.1.

/risk-score/{facility_id} implementing 3.3.

/fl/train-round, /fl/aggregate implementing 3.4, with a real (not stubbed) clip-and-noise function.

PostgreSQL DDL exactly per Section 2, plus the TimescaleDB continuous aggregate for stock_snapshot.

Dashboards: Field PWA (mobile) and National Command Dashboard (desktop), both built to the token system in Section 4, both RBAC-aware server-side (not just UI-hidden), both reflecting live WebSocket/SSE updates.

Architecture docblock at the top of the FL microservice explaining, in plain terms, why raw cross-border data transmission is structurally impossible (not just policy) given the clip → noise → aggregate pipeline.

Pre-populate mock data: WHO Essential Medicines (Amoxicillin, Insulin Regular, ORS, DPT Vaccine, Paracetamol), ward types (General, ICU, Maternity, Isolation), sample rosters (doctor/nurse/ANM/pharmacist) across at least 3 districts so the heatmap, redistribution engine, and emergency-mode escalation all have real data to demonstrate against.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/352f3b72-9a75-4b8a-9aca-3490739fcdd0).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
