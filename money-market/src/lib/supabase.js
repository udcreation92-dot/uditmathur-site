import { createClient } from '@supabase/supabase-js'

// Defaults point at the "account" Supabase project (swxfxjtnospxnkhznyal) that hosts the
// money_market_daily / repo_rate_history tables. The publishable key is public by design
// (all tables are RLS read-only), so shipping it in the bundle is safe. Env vars override
// the defaults when present — but note the sibling apps on this site reuse the same
// VITE_SUPABASE_* names for DIFFERENT projects, so we default here rather than depend on them.
const url = import.meta.env.VITE_SUPABASE_URL || 'https://swxfxjtnospxnkhznyal.supabase.co'
const key = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_ua0WOb1oALsQ1JL0R8MJXw_pcasvw5B'

export const supabase = createClient(url, key)
