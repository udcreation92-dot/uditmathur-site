import { createClient } from '@supabase/supabase-js'

const url  = import.meta.env.VITE_ACCOUNTS_SUPABASE_URL
const key  = import.meta.env.VITE_ACCOUNTS_SUPABASE_ANON_KEY

if (!url || !key) {
  console.warn('Accounts Supabase env vars missing — set VITE_ACCOUNTS_SUPABASE_URL and VITE_ACCOUNTS_SUPABASE_ANON_KEY in Cloudflare dashboard')
}

// Use placeholder values so createClient does not throw during module evaluation
// when env vars are absent (CI build without secrets configured).
export const supabase = createClient(
  url  ?? 'https://placeholder.supabase.co',
  key  ?? 'placeholder-anon-key',
)
