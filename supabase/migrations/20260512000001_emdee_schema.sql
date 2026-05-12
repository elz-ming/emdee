-- Emdee schema — lives alongside other app schemas in whatelz-supabase.
-- All Emdee tables are namespaced here to avoid collisions with public schema.

create schema if not exists emdee;

-- ─── Users ────────────────────────────────────────────────────────────────────
-- Mirrors auth.users with any extra profile fields we need.
-- Populated automatically via the trigger below on first sign-up.
create table emdee.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

alter table emdee.profiles enable row level security;

create policy "users can read their own profile"
  on emdee.profiles for select
  using (auth.uid() = id);

create policy "users can update their own profile"
  on emdee.profiles for update
  using (auth.uid() = id);

-- Auto-create profile on signup
create or replace function emdee.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into emdee.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function emdee.handle_new_user();

-- ─── PAT Tokens ───────────────────────────────────────────────────────────────
-- One token per user. Stored as a SHA-256 hex hash — the plaintext is shown
-- once to the user and never persisted. Rotating replaces the row.
create table emdee.pat_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  token_hash  text not null,
  created_at  timestamptz not null default now(),
  constraint uq_pat_tokens_user unique (user_id)
);

alter table emdee.pat_tokens enable row level security;

-- Users can only see/manage their own token via API routes (service role).
-- Direct client access is intentionally blocked — all PAT ops go through
-- server-side API routes that use the service role key.
create policy "no direct client access"
  on emdee.pat_tokens for all
  using (false);
