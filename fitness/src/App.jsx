import { useEffect, useState } from 'react'
import { api } from './lib/api'
import Workspace from './components/Workspace'
import TrainerHome from './components/TrainerHome'

const STORE_KEY = 'fit_code'
const store = {
  get: () => { try { return localStorage.getItem(STORE_KEY) } catch { return null } },
  set: (v) => { try { localStorage.setItem(STORE_KEY, v) } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(STORE_KEY) } catch { /* private mode */ } },
}

export default function App() {
  const [session, setSession] = useState(null) // { code, role, client?, name? }
  const [booting, setBooting] = useState(!!store.get())
  const [open, setOpen] = useState(null)       // trainer: { client, tab }

  const login = async (code, remember = true) => {
    const r = await api.login(code)
    const clean = code.replace(/\s/g, '').toUpperCase()
    if (remember) store.set(clean)
    setSession({ ...r, code: clean })
  }

  useEffect(() => {
    const saved = store.get()
    if (!saved) return
    login(saved).catch(() => store.clear()).finally(() => setBooting(false))
  }, [])

  const logout = () => { store.clear(); setSession(null); setOpen(null) }

  if (booting) return <div className="min-h-screen grid place-items-center text-neutral-500 text-sm">Loading…</div>
  if (!session) return <Login onLogin={login} />

  return (
    <div className="min-h-screen">
      <TopBar role={session.role} onLogout={logout} />
      {session.role === 'client' && (
        <Workspace code={session.code} clientId={session.client_id} isTrainer={false} />
      )}
      {session.role === 'trainer' && !open && (
        <>
          <div className="bg-ink text-white">
            <div className="max-w-5xl mx-auto px-4 py-4">
              <h1 className="font-head text-3xl font-bold uppercase">Clients</h1>
              <p className="text-xs text-neutral-400">Open a client to view their tracker, plan their meals or edit their profile.</p>
            </div>
          </div>
          <main className="max-w-5xl mx-auto px-3 sm:px-4 py-4 pb-safe">
            <TrainerHome code={session.code} onOpen={(client, tab) => setOpen({ client, tab })} />
          </main>
        </>
      )}
      {session.role === 'trainer' && open && (
        <Workspace
          key={open.client.id}
          code={session.code}
          clientId={open.client.id}
          isTrainer
          initialTab={open.tab || 'day'}
          onBack={() => setOpen(null)}
          onDeleted={() => setOpen(null)}
        />
      )}
    </div>
  )
}

function TopBar({ role, onLogout }) {
  return (
    <header className="bg-ink text-white border-b border-neutral-800">
      <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-3">
        <span className="grid place-items-center w-8 h-8 rounded-lg bg-brand text-lg">💪</span>
        <span className="font-head text-lg font-bold uppercase tracking-wide">
          Fitness <span className="text-brand">Tracker</span>
        </span>
        <span className="ml-1 rounded bg-neutral-800 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-neutral-300">
          {role === 'trainer' ? 'Trainer' : 'Client'}
        </span>
        <div className="flex-1" />
        <button onClick={onLogout} className="text-xs text-neutral-400 hover:text-white">Log out</button>
      </div>
    </header>
  )
}

function Login({ onLogin }) {
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!code.trim()) return
    setBusy(true); setErr('')
    try { await onLogin(code, remember) } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen grid place-items-center px-4 bg-neutral-100">
      <form onSubmit={submit} className="w-full max-w-sm card">
        <div className="bg-ink text-white px-6 py-6 text-center">
          <div className="mx-auto grid place-items-center w-14 h-14 rounded-2xl bg-brand text-3xl">💪</div>
          <h1 className="mt-3 font-head text-3xl font-bold uppercase leading-none">
            Fitness <span className="text-brand">Tracker</span>
          </h1>
          <p className="mt-2 text-[0.65rem] tracking-[0.3em] uppercase text-neutral-400">Discipline × Consistency × Results</p>
        </div>
        <div className="p-6 space-y-4">
          <label className="block">
            <span className="lbl">Your code</span>
            <input
              className="inp text-center font-mono text-2xl font-bold tracking-[0.3em] uppercase py-3"
              autoFocus autoCapitalize="characters" autoComplete="off" spellCheck={false}
              value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="••••••••"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-600">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Keep me signed in on this device
          </label>
          {err && <p className="text-sm text-brand">{err}</p>}
          <button className="btn-primary w-full py-3 text-base" disabled={busy}>{busy ? 'Opening…' : 'Open my tracker'}</button>
          <p className="text-xs text-center text-neutral-400">Don’t have a code? Ask your trainer.</p>
        </div>
      </form>
    </div>
  )
}
