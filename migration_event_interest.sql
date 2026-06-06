create table if not exists event_interest (
  id          uuid default gen_random_uuid() primary key,
  event_id    uuid references events(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,
  created_at  timestamptz default now(),
  unique(event_id, user_id)
);

alter table event_interest enable row level security;

create policy "Own interest" on event_interest
  for all using (auth.uid() = user_id);

create policy "Authenticated read" on event_interest
  for select using (auth.role() = 'authenticated');
