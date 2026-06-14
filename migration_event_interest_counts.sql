-- Public, anonymous-readable aggregate of "I'm going" counts per event.
-- event_interest itself stays RLS-locked to "own rows" (see
-- migration_event_interest.sql) so visitors can't see who's going, but
-- index.html (no-auth) needs the total count to show on event cards.
-- Views run with the privileges of their owner, so this bypasses the
-- underlying table's RLS for aggregate counts only — no user_id is exposed.
create or replace view event_interest_counts as
  select event_id, count(*)::int as going_count
  from event_interest
  group by event_id;

grant select on event_interest_counts to anon, authenticated;
