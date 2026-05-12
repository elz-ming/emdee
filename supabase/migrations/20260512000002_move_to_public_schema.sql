-- Drop emdee schema objects and recreate in public (dedicated DB, no schema separation needed).

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists emdee.handle_new_user();
drop table if exists emdee.pat_tokens;
drop table if exists emdee.profiles;
drop schema if exists emdee;

-- ─── Profiles ─────────────────────────────────────────────────────────────────
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "users can read their own profile"
  on public.profiles for select using (auth.uid() = id);

create policy "users can update their own profile"
  on public.profiles for update using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── PAT Tokens ───────────────────────────────────────────────────────────────
create table public.pat_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  token_hash  text not null,
  created_at  timestamptz not null default now(),
  constraint uq_pat_tokens_user unique (user_id)
);

alter table public.pat_tokens enable row level security;

create policy "no direct client access"
  on public.pat_tokens for all using (false);
