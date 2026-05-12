-- Switch from Supabase Auth to Clerk.
-- auth.jwt() ->> 'sub' returns the Clerk user ID (user_xxxx).
-- Requires Supabase JWT secret configured with Clerk's JWKS URL.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists public.pat_tokens;
drop table if exists public.profiles;

-- ─── Profiles ─────────────────────────────────────────────────────────────────
create table public.profiles (
  clerk_id   text primary key,
  vault_id   uuid not null default gen_random_uuid(),
  email      text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "users can read own profile"
  on public.profiles for select
  using ((auth.jwt() ->> 'sub') = clerk_id);

create policy "users can insert own profile"
  on public.profiles for insert
  with check ((auth.jwt() ->> 'sub') = clerk_id);

create policy "users can update own profile"
  on public.profiles for update
  using ((auth.jwt() ->> 'sub') = clerk_id);

-- Used for share-by-email lookup
create index profiles_email_idx on public.profiles (email);

-- ─── PAT Tokens ───────────────────────────────────────────────────────────────
-- All access via service-role API routes only; no direct client access.
create table public.pat_tokens (
  id          uuid primary key default gen_random_uuid(),
  clerk_id    text not null references public.profiles (clerk_id) on delete cascade,
  token_hash  text not null,
  created_at  timestamptz not null default now(),
  constraint uq_pat_tokens_clerk unique (clerk_id)
);

alter table public.pat_tokens enable row level security;

create policy "no direct client access"
  on public.pat_tokens for all using (false);

-- ─── Doc Shares ───────────────────────────────────────────────────────────────
-- path_prefix e.g. "projects/DOUBLELEAD" covers all docs under that path.
-- Owner retains full control; grantees get read or read+write.
create table public.doc_shares (
  id          uuid primary key default gen_random_uuid(),
  owner_id    text not null references public.profiles (clerk_id) on delete cascade,
  path_prefix text not null,
  grantee_id  text not null references public.profiles (clerk_id) on delete cascade,
  permission  text not null check (permission in ('read', 'write')) default 'read',
  created_at  timestamptz not null default now(),
  constraint uq_doc_share unique (owner_id, path_prefix, grantee_id)
);

alter table public.doc_shares enable row level security;

-- Owner can manage (create, update, delete) their own shares
create policy "owners manage shares"
  on public.doc_shares for all
  using ((auth.jwt() ->> 'sub') = owner_id);

-- Grantees can see shares they've received
create policy "grantees view own shares"
  on public.doc_shares for select
  using ((auth.jwt() ->> 'sub') = grantee_id);
