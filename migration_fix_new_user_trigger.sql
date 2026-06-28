-- Fix the handle_new_user trigger so new signups don't fail with {}.
--
-- Supabase's default new-user trigger tries to insert into public.profiles.
-- If the function is missing or the profiles table has NOT NULL columns
-- without defaults, every signUp() call returns error.message = "{}".
--
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: uses CREATE OR REPLACE + IF NOT EXISTS throughout.

-- 1. Ensure profiles table exists with nullable columns so the trigger
--    can insert a minimal row without violating constraints.
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

-- Users can read and write their own profile
do $$ begin
  create policy "Own profile" on profiles
    for all using (auth.uid() = id) with check (auth.uid() = id);
exception when duplicate_object then null; end $$;

-- 2. Create/replace the trigger function.
--    Inserts a minimal row; remaining fields filled in later by the app.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 3. Drop and recreate the trigger (idempotent).
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
