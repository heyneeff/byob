-- Enable anonymous auth in the Supabase dashboard:
--   Authentication → Providers → Anonymous Sign-ins → Enable
--
-- Then run this to let anonymous users upload audio to jams/:

create policy "Anon jam uploads"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'boombox' and name like 'jams/%');

create policy "Public jam reads"
  on storage.objects for select
  to anon
  using (bucket_id = 'boombox' and name like 'jams/%');
