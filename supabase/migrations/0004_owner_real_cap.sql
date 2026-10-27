-- Owner-only real generations with a hard daily cap.
-- private.real_generations is a server-only log (no client access, survives clip deletion) used to
-- enforce "max N real (paid fal) generations per owner per 24h". Refunded (failed) ones don't count.
create table if not exists private.real_generations (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  clip_id uuid not null unique,
  model text not null,
  fal_endpoint text not null,
  refunded boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists real_generations_user_time on private.real_generations(user_id, created_at desc);
revoke all on private.real_generations from public, anon, authenticated;

-- Replace start_generation: same contract + optional p_real / p_real_cap.
drop function if exists public.start_generation(text,uuid,text,text,text,int,text,text,int,int,uuid);
create or replace function public.start_generation(
  p_secret text, p_user uuid, p_prompt text, p_model text, p_endpoint text,
  p_length int, p_quality text, p_aspect text, p_cost int, p_daily_limit int,
  p_character_id uuid default null, p_real boolean default false, p_real_cap int default 5
) returns json language plpgsql security definer set search_path = '' as $$
declare bal int; used int; real_used int := 0; cid uuid;
begin
  if not private.is_server(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_cost < 0 then raise exception 'bad cost'; end if;
  if p_real and p_length > 5 then raise exception 'real clips are limited to 5 seconds'; end if;
  -- lock the user's balance row: serialises concurrent generations per user
  select balance into bal from public.credit_balances where user_id = p_user for update;
  if bal is null then
    insert into public.credit_balances(user_id, balance) values (p_user, 0) on conflict do nothing;
    select balance into bal from public.credit_balances where user_id = p_user for update;
  end if;
  select count(*) into used from public.clips where owner_id = p_user and created_at > now() - interval '24 hours' and not refunded;
  if used >= p_daily_limit then
    return json_build_object('ok', false, 'error', 'rate_limited', 'used_24h', used, 'limit', p_daily_limit, 'balance', bal);
  end if;
  if p_real then
    select count(*) into real_used from private.real_generations
      where user_id = p_user and created_at > now() - interval '24 hours' and not refunded;
    if real_used >= coalesce(p_real_cap, 0) then
      return json_build_object('ok', false, 'error', 'owner_real_cap_reached', 'real_used_24h', real_used,
        'real_cap', coalesce(p_real_cap, 0), 'balance', bal,
        'message', format('Daily cap of %s real AI clips reached. Try again later (rolling 24h) or use demo clips.', coalesce(p_real_cap, 0)));
    end if;
  end if;
  if bal < p_cost then
    return json_build_object('ok', false, 'error', 'insufficient_reels', 'balance', bal, 'cost', p_cost);
  end if;
  insert into public.clips(owner_id, character_id, prompt, model, fal_endpoint, length_s, quality, aspect_ratio, status, cost)
    values (p_user, p_character_id, p_prompt, p_model, p_endpoint, p_length, p_quality, p_aspect, 'queued', p_cost)
    returning id into cid;
  if p_real then
    insert into private.real_generations(user_id, clip_id, model, fal_endpoint) values (p_user, cid, p_model, p_endpoint);
    real_used := real_used + 1;
  end if;
  update public.credit_balances set balance = balance - p_cost, updated_at = now() where user_id = p_user;
  insert into public.credit_ledger(user_id, delta, reason, clip_id, balance_after) values (p_user, -p_cost, 'generation', cid, bal - p_cost);
  return json_build_object('ok', true, 'clip_id', cid, 'balance', bal - p_cost, 'used_24h', used + 1, 'limit', p_daily_limit,
    'real', p_real, 'real_used_24h', case when p_real then real_used else null end, 'real_cap', case when p_real then p_real_cap else null end);
end $$;
revoke execute on function public.start_generation(text,uuid,text,text,text,int,text,text,int,int,uuid,boolean,int) from public;
grant execute on function public.start_generation(text,uuid,text,text,text,int,text,text,int,int,uuid,boolean,int) to anon, authenticated;

-- finish_clip: unchanged behaviour, plus a failed (refunded) real clip no longer counts toward the owner cap.
create or replace function public.finish_clip(p_secret text, p_clip uuid, p_status text,
  p_video_url text default null, p_storage_path text default null, p_error text default null)
returns json language plpgsql security definer set search_path = '' as $$
declare c public.clips; newbal int;
begin
  if not private.is_server(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('done','failed') then raise exception 'bad status'; end if;
  select * into c from public.clips where id = p_clip for update;
  if c.id is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if c.status in ('done','failed') then
    if c.status = 'done' and p_status = 'done' and p_video_url is not null then
      update public.clips set video_url = p_video_url, storage_path = coalesce(p_storage_path, storage_path) where id = p_clip;
    end if;
    return json_build_object('ok', true, 'already', true, 'status', c.status);
  end if;
  update public.clips set status = p_status, video_url = coalesce(p_video_url, video_url),
    storage_path = coalesce(p_storage_path, storage_path), error = p_error where id = p_clip;
  if p_status = 'failed' then
    update private.real_generations set refunded = true where clip_id = p_clip;
  end if;
  if p_status = 'failed' and not c.refunded and c.cost > 0 then
    update public.credit_balances set balance = balance + c.cost, updated_at = now()
      where user_id = c.owner_id returning balance into newbal;
    insert into public.credit_ledger(user_id, delta, reason, clip_id, balance_after) values (c.owner_id, c.cost, 'refund', c.id, newbal);
    update public.clips set refunded = true where id = p_clip;
    return json_build_object('ok', true, 'status', 'failed', 'refunded', c.cost, 'balance', newbal);
  end if;
  return json_build_object('ok', true, 'status', p_status);
end $$;

-- Server-side read of an owner's real usage (for /api/me)
create or replace function public.real_usage(p_secret text, p_user uuid)
returns int language plpgsql security definer set search_path = '' stable as $$
begin
  if not private.is_server(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select count(*) from private.real_generations
          where user_id = p_user and created_at > now() - interval '24 hours' and not refunded);
end $$;
revoke execute on function public.real_usage(text,uuid) from public;
grant execute on function public.real_usage(text,uuid) to anon, authenticated;
