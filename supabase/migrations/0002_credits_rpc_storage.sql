-- ===== Server-only RPCs (require service_role OR the server secret) =====
create or replace function public.start_generation(
  p_secret text, p_user uuid, p_prompt text, p_model text, p_endpoint text,
  p_length int, p_quality text, p_aspect text, p_cost int, p_daily_limit int,
  p_character_id uuid default null
) returns json language plpgsql security definer set search_path = '' as $$
declare bal int; used int; cid uuid;
begin
  if not private.is_server(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_cost < 0 then raise exception 'bad cost'; end if;
  -- lock the user's balance row: serialises concurrent generations per user
  select balance into bal from public.credit_balances where user_id = p_user for update;
  if bal is null then
    insert into public.credit_balances(user_id, balance) values (p_user, 0) on conflict do nothing;
    select balance into bal from public.credit_balances where user_id = p_user for update;
  end if;
  select count(*) into used from public.clips where owner_id = p_user and created_at > now() - interval '24 hours';
  if used >= p_daily_limit then
    return json_build_object('ok', false, 'error', 'rate_limited', 'used_24h', used, 'limit', p_daily_limit, 'balance', bal);
  end if;
  if bal < p_cost then
    return json_build_object('ok', false, 'error', 'insufficient_reels', 'balance', bal, 'cost', p_cost);
  end if;
  insert into public.clips(owner_id, character_id, prompt, model, fal_endpoint, length_s, quality, aspect_ratio, status, cost)
    values (p_user, p_character_id, p_prompt, p_model, p_endpoint, p_length, p_quality, p_aspect, 'queued', p_cost)
    returning id into cid;
  update public.credit_balances set balance = balance - p_cost, updated_at = now() where user_id = p_user;
  insert into public.credit_ledger(user_id, delta, reason, clip_id, balance_after) values (p_user, -p_cost, 'generation', cid, bal - p_cost);
  return json_build_object('ok', true, 'clip_id', cid, 'balance', bal - p_cost, 'used_24h', used + 1, 'limit', p_daily_limit);
end $$;

create or replace function public.set_clip_request(p_secret text, p_clip uuid, p_request_id text, p_status text default 'queued')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_server(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.clips set fal_request_id = coalesce(p_request_id, fal_request_id), status = p_status
   where id = p_clip and status in ('queued','running');
end $$;

-- Marks a clip done/failed exactly once. Failed => refund (once).
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
    -- allow upgrading a done clip's URL (e.g. fal URL -> storage URL)
    if c.status = 'done' and p_status = 'done' and p_video_url is not null then
      update public.clips set video_url = p_video_url, storage_path = coalesce(p_storage_path, storage_path) where id = p_clip;
    end if;
    return json_build_object('ok', true, 'already', true, 'status', c.status);
  end if;
  update public.clips set status = p_status, video_url = coalesce(p_video_url, video_url),
    storage_path = coalesce(p_storage_path, storage_path), error = p_error where id = p_clip;
  if p_status = 'failed' and not c.refunded and c.cost > 0 then
    update public.credit_balances set balance = balance + c.cost, updated_at = now()
      where user_id = c.owner_id returning balance into newbal;
    insert into public.credit_ledger(user_id, delta, reason, clip_id, balance_after) values (c.owner_id, c.cost, 'refund', c.id, newbal);
    update public.clips set refunded = true where id = p_clip;
    return json_build_object('ok', true, 'status', 'failed', 'refunded', c.cost, 'balance', newbal);
  end if;
  return json_build_object('ok', true, 'status', p_status);
end $$;

-- Server read of a clip (used by webhook / status without user context)
create or replace function public.get_clip_server(p_secret text, p_clip uuid)
returns public.clips language plpgsql security definer set search_path = '' stable as $$
declare c public.clips;
begin
  if not private.is_server(p_secret) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into c from public.clips where id = p_clip;
  return c;
end $$;

-- ===== User RPC: +50 reels once per UTC day =====
create or replace function public.claim_daily()
returns json language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); b public.credit_balances; today date := (now() at time zone 'utc')::date;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select * into b from public.credit_balances where user_id = uid for update;
  if b.user_id is null then
    insert into public.credit_balances(user_id, balance) values (uid, 0);
    select * into b from public.credit_balances where user_id = uid for update;
  end if;
  if b.last_daily_claim = today then
    return json_build_object('ok', false, 'error', 'already_claimed', 'balance', b.balance,
      'next_claim_at', ((today + 1)::timestamp at time zone 'utc'));
  end if;
  update public.credit_balances set balance = balance + 50, last_daily_claim = today, updated_at = now()
    where user_id = uid returning * into b;
  insert into public.credit_ledger(user_id, delta, reason, balance_after) values (uid, 50, 'daily_claim', b.balance);
  return json_build_object('ok', true, 'granted', 50, 'balance', b.balance,
    'next_claim_at', ((today + 1)::timestamp at time zone 'utc'));
end $$;

revoke execute on function public.claim_daily() from public, anon;
grant execute on function public.claim_daily() to authenticated;
-- server RPCs are callable over PostgREST but useless without the secret
grant execute on function public.start_generation(text,uuid,text,text,text,int,text,text,int,int,uuid) to anon, authenticated;
grant execute on function public.set_clip_request(text,uuid,text,text) to anon, authenticated;
grant execute on function public.finish_clip(text,uuid,text,text,text,text) to anon, authenticated;
grant execute on function public.get_clip_server(text,uuid) to anon, authenticated;

-- ===== Storage =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('portraits', 'portraits', true, 5242880, array['image/png','image/jpeg','image/webp']),
  ('clips', 'clips', true, 52428800, array['video/mp4','video/webm','video/quicktime'])
on conflict (id) do nothing;

-- Files live under "<user id>/..." ; owners write, everyone reads (buckets are public)
create policy "media owner insert" on storage.objects for insert to authenticated
  with check (bucket_id in ('portraits','clips') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "media owner update" on storage.objects for update to authenticated
  using (bucket_id in ('portraits','clips') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "media owner delete" on storage.objects for delete to authenticated
  using (bucket_id in ('portraits','clips') and (storage.foldername(name))[1] = (select auth.uid())::text);
