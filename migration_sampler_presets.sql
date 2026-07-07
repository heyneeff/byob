-- Shared, anyone-can-open presets for ternary/sampler.html.
-- Run manually in the Supabase SQL editor (Dashboard > SQL Editor > New query).
--
-- No accounts in this app, so this is intentionally public.
-- Anon + authenticated can read, create, and overwrite-by-name (upsert).
-- No delete policy: one bad actor deleting shared presets for everyone
-- is worse than living without public delete. Local browser-only
-- presets still delete fine client-side via localStorage.

create table if not exists sampler_presets (
  id         uuid default gen_random_uuid() primary key,
  name       text not null unique,
  data       jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table sampler_presets enable row level security;

-- Grants both anon and authenticated: the browser may already hold an
-- authenticated Supabase session from artist.html/listener.html, since
-- Supabase JS auto-restores any session found in localStorage. A policy
-- scoped to anon only would then reject that browser's requests.
drop policy if exists "Public read" on sampler_presets;
create policy "Public read" on sampler_presets
  for select to anon, authenticated using (true);

drop policy if exists "Public create" on sampler_presets;
create policy "Public create" on sampler_presets
  for insert to anon, authenticated with check (true);

drop policy if exists "Public overwrite by name" on sampler_presets;
create policy "Public overwrite by name" on sampler_presets
  for update to anon, authenticated using (true) with check (true);

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
