-- ============================================================
-- BYOB full schema rebuild — for a FRESH Supabase project.
-- Reconstructed 2026-07-13 from code usage + migration_*.sql
-- after the old project (ohacvuwzvuifpyqckise) hit free-tier
-- quota restriction.
--
-- Run in the new project's SQL editor (Dashboard → SQL Editor).
-- Idempotent: safe to re-run.
--
-- ALSO DO IN THE DASHBOARD (not SQL):
--   1. Authentication → Providers → Anonymous Sign-ins → Enable
--   2. Storage → New bucket: "boombox", PUBLIC
--      (only needed if not moving all audio to R2)
-- ============================================================

-- ---------- profiles + new-user trigger ----------
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  emoji        text,
  vibe_tag     text,
  phone        text,
  instagram    text,
  created_at   timestamptz default now()
);

alter table profiles enable row level security;

do $$ begin
  create policy "Own profile" on profiles
    for all using (auth.uid() = id) with check (auth.uid() = id);
exception when duplicate_object then null; end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- zones ----------
create table if not exists zones (
  id                  uuid default gen_random_uuid() primary key,
  name                text,
  host_id             uuid references auth.users(id) on delete set null,
  lat                 double precision,
  lng                 double precision,
  radius_m            double precision,
  active              boolean default false,
  listeners           integer default 0,
  current_track_url   text,
  track_name          text,
  playback_started_at timestamptz,
  play_at             double precision,   -- epoch ms (serverNow()+lead)
  play_from_s         double precision default 0,
  last_message        text,
  last_message_at     timestamptz,
  tip_url             text,
  created_at          timestamptz default now()
);

alter table zones enable row level security;

do $$ begin
  create policy "Public read active zones" on zones
    for select using (active = true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "DJ reads own zones" on zones
    for select to authenticated using (auth.uid() = host_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "DJ inserts own zones" on zones
    for insert to authenticated with check (auth.uid() = host_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "DJ updates own zones" on zones
    for update to authenticated
    using (auth.uid() = host_id) with check (auth.uid() = host_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "DJ deletes own zones" on zones
    for delete to authenticated using (auth.uid() = host_id);
exception when duplicate_object then null; end $$;

-- Listener heartbeat bumps the counter on zones it can see; realtime
-- postgres_changes on zones needs replica identity + publication.
alter publication supabase_realtime add table zones;

-- ---------- tracks ----------
create table if not exists tracks (
  id         uuid default gen_random_uuid() primary key,
  user_id    uuid references auth.users(id) on delete set null,
  zone_id    uuid references zones(id) on delete set null,
  title      text,
  file_path  text,
  public_url text,       -- may point at Supabase Storage OR R2
  created_at timestamptz default now()
);

alter table tracks enable row level security;

do $$ begin
  create policy "Public read tracks" on tracks
    for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Own tracks insert" on tracks
    for insert to authenticated with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Own tracks delete" on tracks
    for delete to authenticated using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

-- ---------- events ----------
create table if not exists events (
  id                 uuid default gen_random_uuid() primary key,
  name               text,
  artists            text,
  description        text,
  event_start        timestamptz,
  location_reveal_at timestamptz,
  lat                double precision,
  lng                double precision,
  radius_m           double precision,
  zone_id            uuid references zones(id) on delete set null,
  created_by         uuid references auth.users(id) on delete set null,
  city               text,
  ticket_price       numeric,
  image_url          text,
  created_at         timestamptz default now()
);

alter table events enable row level security;

do $$ begin
  create policy "Public read events" on events
    for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Authenticated create events" on events
    for insert to authenticated with check (auth.uid() = created_by);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Owner updates events" on events
    for update to authenticated
    using (auth.uid() = created_by) with check (auth.uid() = created_by);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Owner can delete events" on events
    for delete using (auth.uid() = created_by);
exception when duplicate_object then null; end $$;

-- ---------- event_interest + public counts view ----------
create table if not exists event_interest (
  id         uuid default gen_random_uuid() primary key,
  event_id   uuid references events(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  unique(event_id, user_id)
);

alter table event_interest enable row level security;

do $$ begin
  create policy "Own interest" on event_interest
    for all using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Authenticated read" on event_interest
    for select using (auth.role() = 'authenticated');
exception when duplicate_object then null; end $$;

create or replace view event_interest_counts as
  select event_id, count(*)::int as going_count
  from event_interest
  group by event_id;

grant select on event_interest_counts to anon, authenticated;

-- ---------- friendships ----------
create table if not exists friendships (
  id           uuid default gen_random_uuid() primary key,
  requester_id uuid references auth.users(id) on delete cascade,
  addressee_id uuid references auth.users(id) on delete cascade,
  status       text default 'pending',   -- pending | accepted
  created_at   timestamptz default now(),
  unique(requester_id, addressee_id)
);

alter table friendships enable row level security;

do $$ begin
  create policy "Own friendships" on friendships
    for all to authenticated
    using (auth.uid() = requester_id or auth.uid() = addressee_id)
    with check (auth.uid() = requester_id);
exception when duplicate_object then null; end $$;

-- ---------- sampler_presets (public, no accounts) ----------
create table if not exists sampler_presets (
  id         uuid default gen_random_uuid() primary key,
  name       text not null unique,
  data       jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table sampler_presets enable row level security;

drop policy if exists "Public read" on sampler_presets;
create policy "Public read" on sampler_presets
  for select to anon, authenticated using (true);

drop policy if exists "Public create" on sampler_presets;
create policy "Public create" on sampler_presets
  for insert to anon, authenticated with check (true);

drop policy if exists "Public overwrite by name" on sampler_presets;
create policy "Public overwrite by name" on sampler_presets
  for update to anon, authenticated using (true) with check (true);

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

-- ---------- storage policies (only if using a Supabase "boombox" bucket) ----------
-- Create the bucket first in the dashboard (Storage → New bucket → "boombox", public).
do $$ begin
  create policy "Anon jam uploads" on storage.objects for insert to anon
    with check (bucket_id = 'boombox' and name like 'jams/%');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public jam reads" on storage.objects for select to anon
    using (bucket_id = 'boombox' and name like 'jams/%');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Authenticated uploads" on storage.objects for insert to authenticated
    with check (bucket_id = 'boombox');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public reads" on storage.objects for select
    using (bucket_id = 'boombox');
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
