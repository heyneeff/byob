-- Allow any authenticated user to create and manage their own zones.
-- Each DJ only sees/edits their own zones via host_id = auth.uid().
-- Listeners (anon or authenticated) can read all active zones.
--
-- Run in Supabase SQL editor if new DJs are getting permission errors
-- after sign-in (zone create fails silently or returns 403).

alter table zones enable row level security;

-- Listeners: read any active zone (needed for GPS geofence lookup)
do $$ begin
  create policy "Public read active zones" on zones
    for select using (active = true);
exception when duplicate_object then null; end $$;

-- Authenticated users can also see their own inactive zones (draft/setup)
do $$ begin
  create policy "DJ reads own zones" on zones
    for select to authenticated
    using (auth.uid() = host_id);
exception when duplicate_object then null; end $$;

-- Any authenticated user can create a zone they own
do $$ begin
  create policy "DJ inserts own zones" on zones
    for insert to authenticated
    with check (auth.uid() = host_id);
exception when duplicate_object then null; end $$;

-- DJ can update and delete only their own zones
do $$ begin
  create policy "DJ updates own zones" on zones
    for update to authenticated
    using (auth.uid() = host_id)
    with check (auth.uid() = host_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "DJ deletes own zones" on zones
    for delete to authenticated
    using (auth.uid() = host_id);
exception when duplicate_object then null; end $$;
