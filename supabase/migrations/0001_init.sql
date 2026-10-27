-- Lone Keem Studios: core schema with RLS
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Server secret (only its SHA-256 hash is stored)
create table if not exists private.app_config (
  key text primary key,
  value text not null
);

create or replace function private.is_server(p_secret text)
returns boolean language plpgsql security definer set search_path = '' stable as $$
declare h text;
begin
  if coalesce(auth.role(), '') = 'service_role' then return true; end if;
  if p_secret is null or length(p_secret) < 32 then return false; end if;
  select value into h from private.app_config where key = 'server_secret_sha256';
  return h is not null and h = encode(extensions.digest(p_secret, 'sha256'), 'hex');
end $$;

-- ===== Tables =====
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text check (char_length(display_name) <= 60),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  age int check (age is null or age between 18 and 200),
  traits text[] not null default '{}',
  bio text check (char_length(bio) <= 1000),
  socials jsonb not null default '{}'::jsonb,
  collab_mode text not null default 'request' check (collab_mode in ('allow','request','private')),
  look_prompt text check (char_length(look_prompt) <= 2000),
  portrait_url text,
  voice_settings jsonb not null default '{}'::jsonb,
  lore jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.characters(owner_id);

create table public.series (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text check (char_length(description) <= 2000),
  cover_url text,
  character_ids uuid[] not null default '{}',
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.series(owner_id);

create table public.clips (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid references public.characters(id) on delete set null,
  prompt text not null,
  model text not null,
  fal_endpoint text not null,
  length_s int not null,
  quality text not null default '480p',
  aspect_ratio text not null default '9:16',
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  fal_request_id text,
  video_url text,
  storage_path text,
  cost int not null check (cost >= 0),
  refunded boolean not null default false,
  error text,
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.clips(owner_id, created_at desc);
create index on public.clips(fal_request_id);

create table public.episodes (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.series(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  number int not null default 1,
  title text check (char_length(title) <= 120),
  clip_ids uuid[] not null default '{}',   -- ordered
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (series_id, number)
);

-- Credits ("reels"): server-authoritative, clients can only read
create table public.credit_balances (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance int not null default 0 check (balance >= 0),
  last_daily_claim date,
  updated_at timestamptz not null default now()
);
create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  delta int not null,
  reason text not null check (reason in ('signup_bonus','daily_claim','generation','refund','admin','purchase')),
  clip_id uuid references public.clips(id) on delete set null,
  balance_after int not null,
  created_at timestamptz not null default now()
);
create index on public.credit_ledger(user_id, created_at desc);

create table public.likes (
  user_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('clip','episode','series','character')),
  target_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, target_type, target_id)
);
create index on public.likes(target_type, target_id);

create table public.follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index on public.follows(followee_id);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('clip','episode','series','character','profile')),
  target_id uuid not null,
  reason text not null check (char_length(reason) between 1 and 1000),
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  created_at timestamptz not null default now()
);

create table public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table public.remix_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  message text check (char_length(message) <= 1000),
  status text not null default 'pending' check (status in ('pending','approved','denied','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.remix_requests(owner_id, status);

-- ===== updated_at trigger =====
create or replace function private.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['profiles','characters','series','clips','episodes','remix_requests'] loop
    execute format('create trigger touch_%1$s before update on public.%1$I for each row execute function private.touch_updated_at()', t);
  end loop;
end $$;

-- ===== New user bootstrap: profile + 500 reels =====
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare base text; h text; n int := 0;
begin
  base := lower(regexp_replace(coalesce(new.raw_user_meta_data->>'handle', split_part(coalesce(new.email,''),'@',1), 'user'), '[^a-zA-Z0-9_]', '', 'g'));
  if char_length(base) < 3 then base := 'user' || base; end if;
  base := left(base, 18);
  h := base;
  while exists (select 1 from public.profiles where handle = h) loop
    n := n + 1; h := base || '_' || substr(md5(random()::text), 1, 4);
    exit when n > 20;
  end loop;
  insert into public.profiles(id, handle, display_name)
    values (new.id, h, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', h));
  insert into public.credit_balances(user_id, balance) values (new.id, 500);
  insert into public.credit_ledger(user_id, delta, reason, balance_after) values (new.id, 500, 'signup_bonus', 500);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ===== RLS =====
alter table public.profiles enable row level security;
alter table public.characters enable row level security;
alter table public.series enable row level security;
alter table public.clips enable row level security;
alter table public.episodes enable row level security;
alter table public.credit_balances enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.likes enable row level security;
alter table public.follows enable row level security;
alter table public.reports enable row level security;
alter table public.blocks enable row level security;
alter table public.remix_requests enable row level security;

-- profiles: public read, self update (insert done by trigger)
create policy profiles_read on public.profiles for select using (true);
create policy profiles_update on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- characters: non-private visible to all; owner full control
create policy characters_read on public.characters for select
  using (collab_mode <> 'private' or owner_id = (select auth.uid()));
create policy characters_insert on public.characters for insert to authenticated with check (owner_id = (select auth.uid()));
create policy characters_update on public.characters for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy characters_delete on public.characters for delete to authenticated using (owner_id = (select auth.uid()));

-- series
create policy series_read on public.series for select using (is_public or owner_id = (select auth.uid()));
create policy series_insert on public.series for insert to authenticated with check (owner_id = (select auth.uid()));
create policy series_update on public.series for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy series_delete on public.series for delete to authenticated using (owner_id = (select auth.uid()));

-- episodes
create policy episodes_read on public.episodes for select using (is_public or owner_id = (select auth.uid()));
create policy episodes_insert on public.episodes for insert to authenticated with check (
  owner_id = (select auth.uid()) and exists (select 1 from public.series s where s.id = series_id and s.owner_id = (select auth.uid())));
create policy episodes_update on public.episodes for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy episodes_delete on public.episodes for delete to authenticated using (owner_id = (select auth.uid()));

-- clips: read public or own; clients may only toggle is_public / delete. Creation and status are server-only.
create policy clips_read on public.clips for select using (is_public or owner_id = (select auth.uid()));
create policy clips_delete on public.clips for delete to authenticated using (owner_id = (select auth.uid()));
revoke insert, update on public.clips from anon, authenticated;
grant update (is_public, character_id) on public.clips to authenticated;
create policy clips_update_own on public.clips for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- credits: read own only, no client writes
create policy balances_read on public.credit_balances for select to authenticated using (user_id = (select auth.uid()));
create policy ledger_read on public.credit_ledger for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.credit_balances, public.credit_ledger from anon, authenticated;

-- likes / follows: public read, self write
create policy likes_read on public.likes for select using (true);
create policy likes_insert on public.likes for insert to authenticated with check (user_id = (select auth.uid()));
create policy likes_delete on public.likes for delete to authenticated using (user_id = (select auth.uid()));
create policy follows_read on public.follows for select using (true);
create policy follows_insert on public.follows for insert to authenticated with check (follower_id = (select auth.uid()));
create policy follows_delete on public.follows for delete to authenticated using (follower_id = (select auth.uid()));

-- reports: insert own, read own
create policy reports_insert on public.reports for insert to authenticated with check (reporter_id = (select auth.uid()));
create policy reports_read on public.reports for select to authenticated using (reporter_id = (select auth.uid()));

-- blocks: own only
create policy blocks_read on public.blocks for select to authenticated using (blocker_id = (select auth.uid()));
create policy blocks_insert on public.blocks for insert to authenticated with check (blocker_id = (select auth.uid()));
create policy blocks_delete on public.blocks for delete to authenticated using (blocker_id = (select auth.uid()));

-- remix requests: requester or character owner can see; requester creates; owner approves/denies; requester cancels
create policy remix_read on public.remix_requests for select to authenticated
  using (requester_id = (select auth.uid()) or owner_id = (select auth.uid()));
create policy remix_insert on public.remix_requests for insert to authenticated with check (
  requester_id = (select auth.uid()) and status = 'pending'
  and exists (select 1 from public.characters c where c.id = character_id and c.owner_id = remix_requests.owner_id and c.collab_mode = 'request'));
create policy remix_update on public.remix_requests for update to authenticated
  using (requester_id = (select auth.uid()) or owner_id = (select auth.uid()))
  with check (requester_id = (select auth.uid()) or owner_id = (select auth.uid()));
