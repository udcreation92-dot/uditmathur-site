import { useState } from 'react'
import { useClientData } from '../lib/useClientData'
import { fmtShort, parse, today } from '../lib/dates'
import { SaveBadge } from './ui'
import DayView from './DayView'
import MonthGrid from './MonthGrid'
import CheckIn from './CheckIn'
import MealPlanEditor from './MealPlanEditor'
import ProfileTab from './ProfileTab'

// One client's tracker. Used by the client themself, and by the trainer (with extra tabs).
export default function Workspace({ code, clientId, isTrainer, initialTab = 'day', onBack, onDeleted }) {
  const data = useClientData(code, clientId)
  const [tab, setTabRaw] = useState(initialTab)
  const [date, setDate] = useState(today())
  const c = data.client

  const setTab = (k) => { setTabRaw(k); window.scrollTo({ top: 0 }) }

  const tabs = [
    ['day', 'Daily log', '📝'],
    ['month', 'Month', '📅'],
    ['checkin', 'Check-in', '📏'],
    ...(isTrainer ? [['plan', 'Meal plan', '🍽️'], ['profile', 'Profile', '👤']] : []),
  ]
  const daysLeft = c?.target_date ? Math.ceil((parse(c.target_date) - parse(today())) / 86400000) : null

  return (
    <>
      <div className="bg-ink text-white">
        <div className="max-w-5xl mx-auto px-4 pt-2 pb-3 md:pb-1">
          {onBack && <button onClick={onBack} className="-ml-1 px-1 py-1 text-sm text-neutral-300 hover:text-white">← All clients</button>}
          <div className="flex items-center gap-3">
            <h1 className="flex-1 min-w-0 truncate font-head text-2xl sm:text-3xl font-bold uppercase leading-tight">{c?.name || '…'}</h1>
            <SaveBadge status={data.status} error={data.error} onRetry={data.retry} />
          </div>
          {c && (
            <div className="mt-0.5 text-xs text-neutral-300 flex flex-wrap gap-x-3 gap-y-0.5">
              {c.goal && <span className="truncate max-w-full">🎯 <b className="text-white">{c.goal}</b></span>}
              {c.start_date && <span>Start <b className="text-white">{fmtShort(c.start_date)}</b></span>}
              {c.target_date && (
                <span>Target <b className="text-white">{fmtShort(c.target_date)}</b>{daysLeft != null && daysLeft >= 0 && <> · <b className="text-brand">{daysLeft}d left</b></>}</span>
              )}
            </div>
          )}
          {/* top tabs on tablets / desktop */}
          <nav className="hidden md:flex gap-1 -mx-1 mt-2">
            {tabs.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={`tab ${tab === k ? 'tab-on !text-white' : 'hover:text-neutral-300'}`}>{label}</button>
            ))}
          </nav>
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-3 sm:px-4 py-3 sm:py-4 pb-nav">
        {data.status === 'error' && !c && <p className="text-sm text-brand">{data.error}</p>}
        {c && tab === 'day' && <DayView date={date} setDate={setDate} data={data} isTrainer={isTrainer} />}
        {c && tab === 'month' && <MonthGrid data={data} openDay={(d) => { setDate(d); setTab('day') }} />}
        {c && tab === 'checkin' && <CheckIn data={data} />}
        {c && tab === 'plan' && isTrainer && <MealPlanEditor data={data} />}
        {c && tab === 'profile' && isTrainer && (
          <ProfileTab code={code} client={c} onSaved={(nc) => data.setClient(nc)} onDeleted={onDeleted} />
        )}
      </main>

      {/* bottom tab bar on phones */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur border-t border-neutral-200 bottom-nav">
        <div className="flex">
          {tabs.map(([k, label, icon]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-1 flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[0.68rem] font-semibold ${tab === k ? 'text-brand' : 'text-neutral-500'}`}>
              <span className={`text-xl leading-none ${tab === k ? '' : 'grayscale opacity-60'}`}>{icon}</span>
              {label}
            </button>
          ))}
        </div>
      </nav>
    </>
  )
}
