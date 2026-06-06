create policy "Owner can delete events" on events
  for delete using (auth.uid() = created_by);
