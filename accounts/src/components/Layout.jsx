import React, { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import toast from 'react-hot-toast'

const nav = [
  { to: '/',               label: 'Dashboard',      icon: '⊞' },
  { to: '/books',          label: 'Books',           icon: '📚' },
  { to: '/accounts',       label: 'Chart of Accounts', icon: '🗂' },
  { to: '/entry/new',      label: 'New Entry',       icon: '✏️' },
  { to: '/ledger',         label: 'Ledger',          icon: '📋' },
  { to: '/trial-balance',  label: 'Trial Balance',   icon: '⚖️' },
  { to: '/reconciliation', label: 'Reconciliation',  icon: '🔄' },
  { to: '/reports',        label: 'Reports',         icon: '📊' },
  { to: '/avg-balance',     label: 'Avg Balance',     icon: '📈' },
  { to: '/commitments',    label: 'Commitments',     icon: '📅' },
  { to: '/fund-optimizer', label: 'Fund Optimizer',  icon: '💰' },
  { to: '/import',         label: 'Bulk Import',     icon: '📥' },
]

export default function Layout({ session }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  async function signOut() {
    await supabase.auth.signOut()
    toast.success('Signed out')
    navigate('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-30 w-56 bg-brand-900 text-white flex flex-col transform transition-transform lg:relative lg:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="px-5 py-4 border-b border-brand-700">
          <p className="font-bold text-lg leading-none">Accounts</p>
          <p className="text-xs text-brand-100 mt-0.5 truncate">{session?.user?.email}</p>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {nav.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                  isActive ? 'bg-brand-700 font-semibold' : 'hover:bg-brand-800'
                }`
              }
            >
              <span className="text-base">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
        <button onClick={signOut} className="px-5 py-3 text-sm text-brand-200 hover:text-white hover:bg-brand-800 text-left border-t border-brand-700">
          Sign out
        </button>
      </aside>

      {/* Overlay for mobile */}
      {open && <div className="fixed inset-0 z-20 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200">
          <button onClick={() => setOpen(true)} className="text-xl">☰</button>
          <span className="font-semibold">Accounts</span>
        </header>
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
