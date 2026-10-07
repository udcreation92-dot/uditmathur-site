import { useEffect, useState } from 'react'
import { Card, Check, YesNo, Rating, Row } from './ui'
import { MEALS, MACROS, TRAINING_TYPES, DEFAULT_SPLIT, num } from '../lib/constants'
import { addDays, addMonths, dow, fmtDay, monthOf, today, weekDays, DOW, parse, sleepHours } from '../lib/dates'

const hasAny = (o) => !!o && Object.values(o).some((v) =>
  v !== null && v !== '' && v !== undefined && !(typeof v === 'object' && !Array.isArray(v) && !hasAny(v)) && !(Array.isArray(v) && !v.length))

const SECTIONS = [
  { id: 'meals', label: 'Meals', icon: '🍴' },
  { id: 'macros', label: 'Macros', icon: '📊' },
  { id: 'habits', label: 'Habits', icon: '✅' },
  { id: 'sleep', label: 'Sleep', icon: '🛏️' },
  { id: 'training', label: 'Training', icon: '🏋️' },
]

export default function DayView({ date, setDate, data, isTrainer }) {
  const { days, plans, client, ensureMonth, setDaySection } = data
  const week = weekDays(date)

  useEffect(() => {
    ensureMonth(monthOf(week[0]))
    ensureMonth(monthOf(week[6]))
    ensureMonth(addMonths(monthOf(date), -1)) // for "copy last session"
  }, [week[0], ensureMonth]) // eslint-disable-line react-hooks/exhaustive-deps

  const day = days[date] || {}
  const set = (section) => (value) => setDaySection(date, section, value)
  const jump = (id) => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* sticky date + section bar */}
      <div className="sticky top-0 z-20 -mx-3 sm:mx-0 px-3 sm:px-0 pt-2 pb-2 bg-neutral-100/95 backdrop-blur">
        <div className="card p-1.5 flex items-center gap-1">
          <button aria-label="Previous day" className="btn-ghost border-0 w-11 px-0 text-lg" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <div className="flex-1 text-center leading-tight">
            <div className="font-head text-lg font-semibold uppercase">{date === today() ? 'Today · ' : ''}{fmtDay(date)}</div>
            {date !== today() && (
              <button className="text-xs text-brand font-semibold" onClick={() => setDate(today())}>Back to today</button>
            )}
          </div>
          <button aria-label="Next day" className="btn-ghost border-0 w-11 px-0 text-lg" onClick={() => setDate(addDays(date, 1))}>›</button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar mt-2">
          {SECTIONS.map((s) => {
            const done = s.id === 'training'
              ? !!(day.training?.done || day.training?.notes?.trim() || day.training?.exercises?.some((x) => x.name?.trim()))
              : hasAny(day[s.id])
            return (
              <button key={s.id} onClick={() => jump(s.id)} className={`chip ${done ? '!border-emerald-500 !text-emerald-700 !bg-emerald-50' : ''}`}>
                {done ? '✓' : s.icon} {s.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* week strip */}
      <div className="grid grid-cols-7 gap-1">
        {week.map((d) => {
          const filled = days[d] && Object.keys(days[d]).length > 0
          return (
            <button
              key={d}
              onClick={() => setDate(d)}
              className={`rounded-xl py-1.5 text-center border ${d === date ? 'bg-ink text-white border-ink' : d === today() ? 'bg-red-50 border-red-200' : 'bg-white border-neutral-200'}`}
            >
              <div className="text-[0.62rem] uppercase opacity-70">{DOW[dow(d)]}</div>
              <div className="text-base font-bold leading-tight">{parse(d).getDate()}</div>
              <div className={`mx-auto mt-0.5 w-1.5 h-1.5 rounded-full ${filled ? 'bg-emerald-500' : 'bg-transparent'}`} />
            </button>
          )
        })}
      </div>

      <MealsCard date={date} meals={day.meals || {}} plan={plans[date] || {}} onChange={set('meals')} isTrainer={isTrainer} data={data} />
      <MacrosCard macros={day.macros || {}} onChange={set('macros')} />
      <HabitsCard habits={day.habits || {}} onChange={set('habits')} client={client} />
      <SleepCard sleep={day.sleep || {}} onChange={set('sleep')} />
      <TrainingCard date={date} training={day.training || {}} onChange={set('training')} days={days} />
    </div>
  )
}

// ── Meals ────────────────────────────────────────────────────────────────────
function MealsCard({ date, meals, plan, onChange, isTrainer, data }) {
  const setMeal = (no, patch) => onChange({ ...meals, [no]: { ...(meals[no] || {}), ...patch } })
  return (
    <Card id="sec-meals" icon="🍴" title="Nutrition">
      <div className="divide-y divide-neutral-200">
        {MEALS.map((m) => {
          const v = meals[m.no] || {}
          return (
            <div key={m.no} className={`${m.bg} p-4 space-y-3`}>
              <div className="flex items-start gap-3">
                <div className="text-2xl leading-none pt-0.5">{m.icon}</div>
                <div className="flex-1 min-w-0">
                  <div className="font-head text-lg font-semibold uppercase leading-tight">
                    {m.name} <span className="text-xs font-sans font-normal normal-case text-neutral-500">({m.eg})</span>
                  </div>
                  {isTrainer
                    ? <PlanInput date={date} no={m.no} plan={plan} data={data} />
                    : (
                      <div className="mt-1 rounded-xl bg-white/70 px-3 py-2 text-[0.95rem]">
                        <div className="text-[0.62rem] font-bold uppercase tracking-wider text-neutral-500">Planned meal</div>
                        {plan[m.no]?.trim() ? <div className="whitespace-pre-wrap">{plan[m.no]}</div> : <div className="italic text-neutral-400">Not set by trainer</div>}
                      </div>
                    )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setMeal(m.no, { taken: v.taken === true ? null : true })}
                  className={`btn border ${v.taken === true ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-neutral-300'}`}
                >✓ Taken</button>
                <button
                  type="button"
                  onClick={() => setMeal(m.no, { taken: v.taken === false ? null : false })}
                  className={`btn border ${v.taken === false ? 'bg-brand border-brand text-white' : 'bg-white border-neutral-300'}`}
                >✗ Not taken</button>
              </div>
              {v.taken === false && (
                <textarea
                  className="inp"
                  rows={2}
                  placeholder="What did you eat instead?"
                  value={v.ate || ''}
                  onChange={(e) => setMeal(m.no, { ate: e.target.value })}
                />
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// Trainer edits the planned meal for this date inline; saved on blur.
function PlanInput({ date, no, plan, data }) {
  const [v, setV] = useState(plan[no] || '')
  useEffect(() => setV(plan[no] || ''), [plan[no], date]) // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    if ((plan[no] || '') === v) return
    data.savePlans({ [date]: { ...plan, [no]: v } }).catch(() => {})
  }
  return (
    <textarea
      className="inp mt-1 bg-white/80"
      rows={2}
      placeholder="Planned meal (trainer)"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
    />
  )
}

// ── Macros ───────────────────────────────────────────────────────────────────
function MacrosCard({ macros, onChange }) {
  const set = (k, val) => onChange({ ...macros, [k]: val })
  return (
    <Card id="sec-macros" icon="📊" title="Daily macros">
      <div className="p-4 grid grid-cols-2 sm:grid-cols-5 gap-3">
        {MACROS.map((m, i) => (
          <label key={m.k} className={`block ${i === 0 ? 'col-span-2 sm:col-span-1' : ''}`}>
            <span className="lbl">{m.icon} {m.label} ({m.unit})</span>
            <input className="inp" type="number" inputMode="decimal" min="0" enterKeyHint="next"
              value={macros[m.k] ?? ''} onChange={(e) => set(m.k, e.target.value)} />
          </label>
        ))}
        <label className="block col-span-2 sm:col-span-5">
          <span className="lbl">💊 Supplementation</span>
          <input className="inp" placeholder="e.g. Whey 1 scoop, Creatine 5g"
            value={macros.supp || ''} onChange={(e) => set('supp', e.target.value)} />
        </label>
      </div>
    </Card>
  )
}

// ── Habits ───────────────────────────────────────────────────────────────────
function HabitsCard({ habits, onChange, client }) {
  const set = (k, val) => onChange({ ...habits, [k]: val })
  const stepsTarget = client?.steps_target
  const waterTarget = Number(client?.water_target || 3)
  const water = num(habits.water) || 0
  const stepsHit = stepsTarget && num(habits.steps) >= stepsTarget
  const waterHit = water >= waterTarget
  const addWater = (l) => set('water', String(Math.round((water + l) * 100) / 100))
  return (
    <Card id="sec-habits" icon="✅" title="Daily habits">
      <Row label="👟 Steps" hint={stepsTarget ? `target ${stepsTarget.toLocaleString('en-IN')}` : ''}>
        <div className="flex items-center gap-2">
          <input className="inp w-32 text-right" type="number" inputMode="numeric" min="0" placeholder="0"
            value={habits.steps ?? ''} onChange={(e) => set('steps', e.target.value)} />
          <span className={`text-xl ${stepsHit ? '' : 'opacity-20'}`}>✅</span>
        </div>
      </Row>
      <div className="px-4 py-3 border-t border-neutral-100 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold">💧 Water <span className="ml-1 text-xs font-normal text-neutral-500">target {waterTarget}+ L</span></div>
          <div className="flex items-center gap-2">
            <input className="inp w-24 text-right" type="number" inputMode="decimal" min="0" step="0.25" placeholder="0"
              value={habits.water ?? ''} onChange={(e) => set('water', e.target.value)} />
            <span className="text-sm text-neutral-500">L</span>
            <span className={`text-xl ${waterHit ? '' : 'opacity-20'}`}>✅</span>
          </div>
        </div>
        <div className="flex gap-2">
          {[0.25, 0.5, 1].map((l) => (
            <button key={l} type="button" className="chip flex-1 justify-center" onClick={() => addWater(l)}>+{l < 1 ? `${l * 1000} ml` : '1 L'}</button>
          ))}
        </div>
        <div className="h-1.5 rounded-full bg-neutral-100 overflow-hidden">
          <div className="h-full bg-sky-500 transition-all" style={{ width: `${Math.min(100, (water / waterTarget) * 100)}%` }} />
        </div>
      </div>
      <Row label="💊 Supplements taken"><YesNo value={habits.supplements ?? null} onChange={(v) => set('supplements', v)} /></Row>
      <Row label="🚫 No cheat meal"><YesNo value={habits.no_cheat ?? null} onChange={(v) => set('no_cheat', v)} /></Row>
      <Row label="🪷 Stress under control"><YesNo value={habits.stress_ok ?? null} onChange={(v) => set('stress_ok', v)} /></Row>
      <Row stack label="🙂 Mood / energy" hint="1 low – 5 great"><Rating value={habits.mood ?? null} onChange={(v) => set('mood', v)} /></Row>
      <div className="px-4 pb-4 pt-1">
        <span className="lbl">📝 Daily notes</span>
        <textarea className="inp" rows={2} value={habits.notes || ''} onChange={(e) => set('notes', e.target.value)} />
      </div>
    </Card>
  )
}

// ── Sleep ────────────────────────────────────────────────────────────────────
function SleepCard({ sleep, onChange }) {
  const set = (k, val) => onChange({ ...sleep, [k]: val })
  const hrs = sleepHours(sleep.bed, sleep.wake)
  const goal = hrs != null && hrs >= 7 && hrs <= 9
  return (
    <Card id="sec-sleep" icon="🛏️" title="Sleep">
      <div className="p-4 grid grid-cols-2 gap-3">
        <label className="block"><span className="lbl">🕙 Bed time</span>
          <input className="inp" type="time" value={sleep.bed || ''} onChange={(e) => set('bed', e.target.value)} /></label>
        <label className="block"><span className="lbl">⏰ Wake time</span>
          <input className="inp" type="time" value={sleep.wake || ''} onChange={(e) => set('wake', e.target.value)} /></label>
        <div className={`col-span-2 flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-semibold
          ${hrs == null ? 'bg-neutral-50 text-neutral-400' : goal ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
          <span>Total sleep: {hrs == null ? '—' : `${hrs} h`}</span>
          <span>{hrs == null ? 'Goal 7–9 h' : goal ? '🎯 Goal met' : '❌ Outside 7–9 h'}</span>
        </div>
      </div>
      <Row stack label="📶 Sleep quality" hint="1–5"><Rating value={sleep.quality ?? null} onChange={(v) => set('quality', v)} /></Row>
      <Row label="🌙 Felt refreshed"><YesNo value={sleep.refreshed ?? null} onChange={(v) => set('refreshed', v)} /></Row>
      <Row stack label="🔋 Energy level" hint="1–5"><Rating value={sleep.energy ?? null} onChange={(v) => set('energy', v)} /></Row>
      <Row stack label="🧠 Stress level" hint="1–5"><Rating value={sleep.stress ?? null} onChange={(v) => set('stress', v)} /></Row>
    </Card>
  )
}

// ── Training ─────────────────────────────────────────────────────────────────
function TrainingCard({ date, training, onChange, days }) {
  const type = training.type || DEFAULT_SPLIT[dow(date)]
  const meta = TRAINING_TYPES.find((t) => t.k === type)
  const exercises = training.exercises || []
  const set = (patch) => onChange({ ...training, type, ...patch })
  const setEx = (i, patch) => set({ exercises: exercises.map((x, j) => (j === i ? { ...x, ...patch } : x)) })

  // most recent earlier session of the same type that has exercises
  const last = Object.keys(days)
    .filter((d) => d < date && days[d]?.training?.type === type && days[d].training.exercises?.some((x) => x.name))
    .sort().pop()
  const copyLast = () => set({ exercises: days[last].training.exercises.filter((x) => x.name).map((x) => ({ ...x })) })

  return (
    <Card id="sec-training" icon="🏋️" title="Training">
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
          {TRAINING_TYPES.map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => set({ type: t.k })}
              className={`btn border ${type === t.k ? 'bg-ink border-ink text-white' : 'bg-white border-neutral-300'}`}
            >{t.icon} {t.label}</button>
          ))}
        </div>
        <Check checked={!!training.done} onChange={(v) => set({ done: v })} label={<span className="text-base">Session done</span>} />

        {meta?.sets && (
          <div className="space-y-2">
            {exercises.map((x, i) => (
              <div key={i} className="rounded-xl border border-neutral-200 bg-neutral-50 p-2.5 sm:p-2 sm:grid sm:grid-cols-[1fr_4rem_4rem_5rem_2.5rem] sm:gap-2 sm:items-end">
                <div className="flex items-center gap-2 sm:contents">
                  <label className="flex-1 sm:block">
                    <span className="lbl sm:hidden">Exercise {i + 1}</span>
                    <input className="inp" placeholder="e.g. Bench press" value={x.name || ''} onChange={(e) => setEx(i, { name: e.target.value })} />
                  </label>
                  <button type="button" aria-label="Remove exercise" className="self-end sm:order-last w-10 h-11 sm:h-9 grid place-items-center rounded-xl text-neutral-400 hover:text-brand"
                    onClick={() => set({ exercises: exercises.filter((_, j) => j !== i) })}>✕</button>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2 sm:mt-0 sm:contents">
                  <label className="block"><span className="lbl">Sets</span>
                    <input className="inp text-center" inputMode="numeric" value={x.sets || ''} onChange={(e) => setEx(i, { sets: e.target.value })} /></label>
                  <label className="block"><span className="lbl">Reps</span>
                    <input className="inp text-center" inputMode="text" placeholder="10" value={x.reps || ''} onChange={(e) => setEx(i, { reps: e.target.value })} /></label>
                  <label className="block"><span className="lbl">Kg</span>
                    <input className="inp text-center" inputMode="decimal" value={x.weight || ''} onChange={(e) => setEx(i, { weight: e.target.value })} /></label>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost flex-1 sm:flex-none" onClick={() => set({ exercises: [...exercises, {}] })}>+ Add exercise</button>
              {last && !exercises.some((x) => x.name) && (
                <button type="button" className="btn-ghost flex-1 sm:flex-none" onClick={copyLast}>↺ Copy last {meta.label.toLowerCase()} ({fmtDay(last)})</button>
              )}
            </div>
          </div>
        )}

        <label className="block">
          <span className="lbl">{meta?.sets ? 'Notes' : 'Activity / notes'}</span>
          <textarea className="inp" rows={2} value={training.notes || ''} onChange={(e) => set({ notes: e.target.value })} />
        </label>
      </div>
    </Card>
  )
}
