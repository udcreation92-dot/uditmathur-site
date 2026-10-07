import { createClient } from '@supabase/supabase-js'

// Lives in the "Task" Supabase project (lfooawfktudshkatyqdi), tables fit_*.
// Like money-market, we do NOT read the shared VITE_SUPABASE_* vars (sibling apps point them at
// other projects). The publishable key is public by design: every fit_* table is locked
// (RLS, no grants) and all access goes through fit_* RPCs that verify the access code server-side.
const url = import.meta.env.VITE_FIT_SUPABASE_URL || 'https://lfooawfktudshkatyqdi.supabase.co'
const key = import.meta.env.VITE_FIT_SUPABASE_ANON_KEY || 'sb_publishable_lwTnuIqiCxBbufKToYNqQg_hZpA-fXT'

const supabase = createClient(url, key, { auth: { persistSession: false } })

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw new Error(error.message)
  if (data && data.ok === false) throw new Error(data.error || 'Request failed')
  return data
}

export const api = {
  login: (code) => rpc('fit_login', { p_code: code }),
  listClients: (code) => rpc('fit_list_clients', { p_code: code }),
  saveClient: (code, client, regen = false) => rpc('fit_save_client', { p_code: code, p_client: client, p_regen: regen }),
  deleteClient: (code, id) => rpc('fit_delete_client', { p_code: code, p_client: id }),
  load: (code, clientId, from, to) => rpc('fit_load', { p_code: code, p_client: clientId, p_from: from, p_to: to }),
  saveDay: (code, clientId, day, patch) => rpc('fit_save_day', { p_code: code, p_client: clientId, p_day: day, p_patch: patch }),
  saveMonth: (code, clientId, month, patch) => rpc('fit_save_month', { p_code: code, p_client: clientId, p_month: month, p_patch: patch }),
  savePlans: (code, clientId, plans) => rpc('fit_save_plans', { p_code: code, p_client: clientId, p_plans: plans }),
}
