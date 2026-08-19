-- RBI Money Market Monitor — schema (applied to project swxfxjtnospxnkhznyal / "account")
-- Mirrors the migration applied via Supabase MCP on 2026-08-19. Kept here for version control.

create table if not exists public.money_market_daily (
  report_date       date primary key,
  call_money_vol    numeric, call_money_rate   numeric,
  triparty_vol      numeric, triparty_rate     numeric,
  market_repo_vol   numeric, market_repo_rate  numeric,
  corp_bond_vol     numeric, corp_bond_rate    numeric,
  gsec_war          numeric, corp_bond_war     numeric, corp_spread_bps numeric,
  sdf_rate          numeric, msf_rate          numeric,
  net_liquidity     numeric,
  corridor_ok       boolean default true,
  source_prid       text,
  ingested_at       timestamptz default now()
);

create table if not exists public.repo_rate_history (
  effective_from date primary key,
  repo_rate      numeric not null,
  note           text
);

-- Seed: repo = SDF+0.25 corridor midpoint (SDF 5.00 / MSF 5.50 => 5.25).
-- TODO(Udit) verify the exact MPC effective_from date against the RBI resolution history.
insert into public.repo_rate_history (effective_from, repo_rate, note)
values ('2025-06-06', 5.25, 'PLACEHOLDER date — verify the effective_from against the RBI MPC resolution history.')
on conflict (effective_from) do nothing;

create or replace view public.money_market_enriched as
select
  d.*,
  r.repo_rate                                as repo_rate,
  r.effective_from                           as repo_effective_from,
  round((d.gsec_war - r.repo_rate) * 100, 1) as gsec_vs_repo_bps
from public.money_market_daily d
left join lateral (
  select rh.repo_rate, rh.effective_from
  from public.repo_rate_history rh
  where rh.effective_from <= d.report_date
  order by rh.effective_from desc
  limit 1
) r on true;
alter view public.money_market_enriched set (security_invoker = on);

alter table public.money_market_daily enable row level security;
alter table public.repo_rate_history  enable row level security;

drop policy if exists mm_daily_public_read on public.money_market_daily;
create policy mm_daily_public_read on public.money_market_daily for select using (true);
drop policy if exists repo_history_public_read on public.repo_rate_history;
create policy repo_history_public_read on public.repo_rate_history for select using (true);

grant select on public.money_market_daily, public.repo_rate_history, public.money_market_enriched
  to anon, authenticated;

-- Daily ingestion cron (04:15 UTC = 09:45 IST). Requires pg_cron + pg_net.
-- select cron.schedule('rbi-mm-daily-ingest', '15 4 * * *', $$
--   select net.http_post(
--     url := 'https://swxfxjtnospxnkhznyal.supabase.co/functions/v1/rbi-mm-ingest?secret=<SHARED_SECRET>',
--     headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 120000);
-- $$);
