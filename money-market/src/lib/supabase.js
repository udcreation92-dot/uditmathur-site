import { createClient } from '@supabase/supabase-js'

// This app is permanently tied to the "account" Supabase project (swxfxjtnospxnkhznyal),
// which hosts money_market_daily / repo_rate_history / money_market_enriched.
//
// We DO NOT read the shared VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY here: the sibling
// apps on this site (Task, Accounts) reuse those same var names for DIFFERENT projects, and
// the Cloudflare Pages build injects them globally — so reading them points this app at the
// wrong database. Instead we hardcode the account project (its publishable key is public by
// design; all tables are RLS read-only) and allow ONLY dedicated VITE_MM_* overrides.
const url = import.meta.env.VITE_MM_SUPABASE_URL || 'https://swxfxjtnospxnkhznyal.supabase.co'
const key = import.meta.env.VITE_MM_SUPABASE_ANON_KEY || 'sb_publishable_ua0WOb1oALsQ1JL0R8MJXw_pcasvw5B'

export const supabase = createClient(url, key)
