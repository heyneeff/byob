-- Shared, anyone-can-open presets for ternary/sampler.html.
-- Run manually in the Supabase SQL editor (Dashboard → SQL Editor → New query).
--
-- No accounts in this app, so this is intentionally public: anon can read,
-- create, and overwrite-by-name (upsert) presets. Anon delete is NOT granted —
-- one bad actor deleting everyone's shared presets is a worse failure mode
-- than living without public delete. (Local, browser-only presets still
-- support delete client-side via localStorage, unaffected by this table.)

create table if not exists sampler_presets (
  id         uuid default gen_random_uuid() primary key,
  name       text not null unique,
  data       jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table sampler_presets enable row level security;

create policy "Public read" on sampler_presets
  for select to anon using (true);

create policy "Public create" on sampler_presets
  for insert to anon with check (true);

create policy "Public overwrite by name" on sampler_presets
  for update to anon using (true) with check (true);

-- Keep updated_at current on overwrite (upsert onConflict).
create or replace function sampler_presets_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sampler_presets_set_updated_at on sampler_presets;
create trigger sampler_presets_set_updated_at
  before update on sampler_presets
  for each row execute function sampler_presets_touch_updated_at();

notify pgrst, 'reload schema';
