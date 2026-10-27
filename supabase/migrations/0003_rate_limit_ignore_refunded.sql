-- Failed/refunded clips (provider errors, 'real generation not enabled') don't count toward the daily limit.
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
  select count(*) into used from public.clips where owner_id = p_user and created_at > now() - interval '24 hours' and not refunded;
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
