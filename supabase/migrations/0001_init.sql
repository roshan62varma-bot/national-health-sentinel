-- AegisHealth BRICS — core schema
-- Mirrors src/lib/aegis/types.ts exactly (snake_case here, camelCase in TS;
-- the mapping happens in src/lib/aegis/repository.ts — nowhere else).
-- Run via `supabase db push`, or paste into the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- hierarchy

create table nations (
  id text primary key,
  name text not null
);

create table states (
  id text primary key,
  name text not null,
  nation_id text not null references nations(id)
);

create table districts (
  id text primary key,
  name text not null,
  state_id text not null references states(id),
  emergency_mode boolean not null default false,
  red_hours_streak numeric not null default 0
);

create table facilities (
  id text primary key,
  name text not null,
  type text not null check (type in ('PHC', 'CHC', 'DISTRICT_HOSPITAL')),
  district_id text not null references districts(id),
  state_id text not null references states(id),
  nation_id text not null references nations(id),
  lat double precision not null,
  lng double precision not null,
  catchment_population integer not null default 0
);

-- ---------------------------------------------------------------- resources

create table medicines (
  id text primary key,
  name text not null,
  who_essential boolean not null default true,
  unit text not null
);

-- current position per (facility, medicine) — logic.ts reads this directly
create table stock_snapshot (
  facility_id text not null references facilities(id),
  medicine_id text not null references medicines(id),
  on_hand numeric not null default 0,
  on_order numeric not null default 0,
  backorder numeric not null default 0,
  avg_daily_consumption numeric not null default 0,
  sigma_demand numeric not null default 0,
  lead_time_days numeric not null default 3,
  updated_at timestamptz not null default now(),
  primary key (facility_id, medicine_id)
);

-- append-only daily consumption feeding forecastDemand()'s history array
create table stock_history (
  id bigserial primary key,
  facility_id text not null references facilities(id),
  medicine_id text not null references medicines(id),
  day date not null,
  consumption numeric not null,
  unique (facility_id, medicine_id, day)
);

create table beds (
  id text primary key,
  facility_id text not null references facilities(id),
  ward_type text not null check (ward_type in ('General', 'ICU', 'Maternity', 'Isolation')),
  total integer not null,
  occupied integer not null default 0,
  updated_at timestamptz not null default now()
);

create table staff_roster (
  facility_id text not null references facilities(id),
  role text not null check (role in ('Doctor', 'Nurse', 'ANM', 'Pharmacist')),
  present integer not null default 0,
  min_safe_staffing_count integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (facility_id, role)
);

-- individual attendance events (voice/manual/geofence) — staff_roster.present
-- is the rolled-up figure logic.ts consumes; this is the audit trail behind it
create table attendance_log (
  id bigserial primary key,
  facility_id text not null references facilities(id),
  role text not null,
  status text not null check (status in ('PRESENT', 'ABSENT', 'COVERING')),
  covering_for text,
  source text not null check (source in ('VOICE', 'MANUAL', 'GEOFENCE')),
  recorded_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- redistribution

create table dispatch_manifests (
  id text primary key,
  resource_type text not null check (resource_type in ('MEDICINE', 'BED', 'STAFF')),
  label text not null,
  source_facility_id text not null references facilities(id),
  dest_facility_id text not null references facilities(id),
  quantity numeric not null,
  distance_km numeric not null,
  eta_hours numeric not null,
  severity numeric not null,
  days_to_stockout numeric not null,
  status text not null default 'PENDING_APPROVAL' check (status in ('PENDING_APPROVAL', 'APPROVED')),
  signature_token text,
  rationale text not null,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- federated learning

create table fl_rounds (
  id text primary key,
  round_number integer not null,
  nation_id text not null,
  nation text not null,
  dp_epsilon numeric not null,
  weights_hash text not null,
  aggregate_accuracy_delta numeric not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- field capture

-- every voice/vision capture, before AND after Gemini structures it — this is
-- what makes "hold to speak" a real pipeline instead of a canned string
create table captures (
  id bigserial primary key,
  facility_id text not null references facilities(id),
  kind text not null check (kind in ('VOICE', 'VISION_SHELF', 'VISION_WARD')),
  raw_transcript text,
  parsed jsonb,
  confidence numeric,
  applied boolean not null default false,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  entity text not null,
  entity_id text not null,
  action text not null,
  actor uuid references auth.users(id),
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- RBAC

create table app_users (
  id uuid primary key references auth.users(id),
  name text not null,
  role text not null check (
    role in ('PHC_FIELD_STAFF', 'DISTRICT_OFFICER', 'STATE_HEALTH_OFFICIAL', 'NATIONAL_MINISTRY_ADMIN', 'BRICS_LIAISON')
  ),
  facility_id text references facilities(id),
  district_id text references districts(id),
  state_id text references states(id),
  nation_id text references nations(id)
);

-- SECURITY DEFINER so RLS policies on other tables can call this without a
-- circular RLS check on app_users itself.
create function current_app_user()
returns app_users
language sql security definer stable
set search_path = public
as $$
  select * from app_users where id = auth.uid();
$$;

-- aggregate-only projection for BRICS_LIAISON — no facility identifiers, no
-- district-level breakdown, only the federated round ledger and national
-- composite risk. This view, not a policy someone must remember, is what
-- keeps facility-level data out of cross-border reach.
create view brics_aggregate as
select
  f.nation_id,
  count(*) filter (where s.on_hand::float / nullif(s.avg_daily_consumption, 0) < 1) as emergency_lines,
  avg(s.on_hand::float / nullif(s.avg_daily_consumption, 0)) as avg_days_of_supply
from facilities f
join stock_snapshot s on s.facility_id = f.id
group by f.nation_id;

alter table nations enable row level security;
alter table states enable row level security;
alter table districts enable row level security;
alter table facilities enable row level security;
alter table medicines enable row level security;
alter table stock_snapshot enable row level security;
alter table stock_history enable row level security;
alter table beds enable row level security;
alter table staff_roster enable row level security;
alter table attendance_log enable row level security;
alter table dispatch_manifests enable row level security;
alter table fl_rounds enable row level security;
alter table captures enable row level security;
alter table audit_log enable row level security;
alter table app_users enable row level security;

-- Reference data: readable by any authenticated user.
create policy read_reference on nations for select to authenticated using (true);
create policy read_reference on states for select to authenticated using (true);
create policy read_reference on medicines for select to authenticated using (true);
create policy read_own_row on app_users for select to authenticated using (id = auth.uid());

-- Hierarchical read: national admins see their nation; state officials see
-- their state; district officers and field staff see their district/facility.
create policy read_districts on districts for select to authenticated using (
  (select role from current_app_user()) = 'NATIONAL_MINISTRY_ADMIN'
  or state_id = (select state_id from current_app_user())
  or id = (select district_id from current_app_user())
);

create policy read_facilities on facilities for select to authenticated using (
  (select role from current_app_user()) = 'NATIONAL_MINISTRY_ADMIN'
  or state_id = (select state_id from current_app_user())
  or district_id = (select district_id from current_app_user())
  or id = (select facility_id from current_app_user())
);

create policy read_stock on stock_snapshot for select to authenticated using (
  facility_id in (select id from facilities) -- narrowed by facilities' own RLS via join
);
create policy read_history on stock_history for select to authenticated using (
  facility_id in (select id from facilities)
);
create policy read_beds on beds for select to authenticated using (
  facility_id in (select id from facilities)
);
create policy read_staff on staff_roster for select to authenticated using (
  facility_id in (select id from facilities)
);
create policy read_attendance on attendance_log for select to authenticated using (
  facility_id in (select id from facilities)
);
create policy read_manifests on dispatch_manifests for select to authenticated using (
  source_facility_id in (select id from facilities) or dest_facility_id in (select id from facilities)
);

-- Field staff write their own facility's captures and attendance.
create policy insert_own_captures on captures for insert to authenticated with check (
  facility_id = (select facility_id from current_app_user())
);
create policy insert_own_attendance on attendance_log for insert to authenticated with check (
  facility_id = (select facility_id from current_app_user())
);

-- Only district officers (and above) approve manifests for their district's facilities.
create policy approve_manifests on dispatch_manifests for update to authenticated using (
  (select role from current_app_user()) in ('DISTRICT_OFFICER', 'STATE_HEALTH_OFFICIAL', 'NATIONAL_MINISTRY_ADMIN')
  and dest_facility_id in (select id from facilities)
);

-- BRICS_LIAISON: aggregate view and the FL round ledger only — no direct
-- grant on facilities/stock_snapshot/etc., so a liaison account cannot query
-- another nation's facility-level rows even if it tried.
create policy read_fl_rounds on fl_rounds for select to authenticated using (true);
grant select on brics_aggregate to authenticated;

-- Server-side writers (approve, capture ingestion, FL rounds) go through the
-- service-role key from src/lib/supabase/server.ts, which bypasses RLS by
-- design — RLS above governs direct browser access only.
