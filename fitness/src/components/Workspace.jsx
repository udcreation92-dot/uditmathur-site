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
  const [tab, setTab] = useState(initialTab)
  const [date, setDate] = useState(today())
  const c = data.client

  const tabs = [
    ['day', 'Daily log'],
    ['month', 'Month view'],
    ['checkin', 'Check-in'],
    ...(isTrainer ? [['plan', 'Meal plan'], ['profile', 'Profile']] : []),
  ]
  const daysLeft = c?.target_date ? Math.ceil((parse(c.target_date) - parse(today())) / 86400000) : null

  return (
    <>
      <div className="bg-ink text-white">
        <div className="max-w-5xl mx-auto px-4 pt-3 pb-1">
          <div className="flex items-center gap-2">
            {onBack && <button onClick={onBack} className="text-sm text-neutral-300 hover:text-white">← Clients</button>}
            <div className="flex-1" />
            <SaveBadge status={data.status} error={data.error} onRetry={data.retry} />
          </div>
          <div className="mt-1 flex flex-wrap items-end gap-x-6 gap-y-1">
            <h1 className="font-head text-3xl font-bold uppercase leading-tight">{c?.name || '…'}</h1>
            {c && (
              <div className="text-xs text-neutral-300 flex flex-wrap gap-x-4 gap-y-0.5 pb-1">
                {c.goal && <span>🎯 <b className="text-white">{c.goal}</b></span>}
                <span>Start <b className="text-white">{fmtShort(c.start_date)}</b></span>
                <span>Target <b className="text-white">{fmtShort(c.target_date)}</b>{daysLeft != null && daysLeft >= 0 && ` · ${daysLeft} days left`}</span>
              </div>
            )}
          </div>
          <nav className="flex gap-1 overflow-x-auto no-scrollbar -mx-1 mt-2">
            {tabs.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={`tab ${tab === k ? 'tab-on !text-white' : 'hover:text-neutral-300'}`}>{label}</button>
            ))}
          </nav>
        </div>
      </div>

      <main className="max-w-5xl mx-auto px-3 sm:px-4 py-4 pb-safe">
        {data.status === 'error' && !c && <p className="text-sm text-brand">{data.error}</p>}
        {c && tab === 'day' && <DayView date={date} setDate={setDate} data={data} isTrainer={isTrainer} />}
        {c && tab === 'month' && <MonthGrid data={data} openDay={(d) => { setDate(d); setTab('day') }} />}
        {c && tab === 'checkin' && <CheckIn data={data} />}
        {c && tab === 'plan' && isTrainer && <MealPlanEditor data={data} />}
        {c && tab === 'profile' && isTrainer && (
          <ProfileTab code={code} client={c} onSaved={(nc) => data.setClient(nc)} onDeleted={onDeleted} />
        )}
      </main>
    </>
  )
}
