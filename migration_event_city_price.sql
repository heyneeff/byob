alter table events add column if not exists city text;
alter table events add column if not exists ticket_price numeric;
alter table events add column if not exists image_url text;

-- Supabase's PostgREST API caches the schema; without this the API keeps
-- reporting "Could not find the 'city' column" even after the alter above.
notify pgrst, 'reload schema';
