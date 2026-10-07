import { useEffect, useState } from 'react'
import { Card, Check, YesNo, Rating, Row } from './ui'
import { MEALS, MACROS, TRAINING_TYPES, DEFAULT_SPLIT, num } from '../lib/constants'
import { addDays, dow, fmtDay, monthOf, today, weekDays, DOW, parse, sleepHours } from '../lib/dates'

export default function DayView({ date, setDate, data, isTrainer }) {
  const { days, plans, client, ensureMonth, setDaySection } = data
  const week = weekDays(date)

  useEffect(() => {
    ensureMonth(monthOf(week[0]))
    ensureMonth(monthOf(week[6]))
  }, [week[0], ensureMonth]) // eslint-disable-line react-hooks/exhaustive-deps

  const day = days[date] || {}
  const set = (section) => (value) => setDaySection(date, section, value)

  return (
    <div className="space-y-4">
      {/* date navigator */}
      <div className="card p-3">
        <div className="flex items-center gap-2">
          <button className="btn-ghost px-3" onClick={() => setDate(addDays(date, -1))}>◀</button>
          <div className="flex-1 text-center">
            <div className="font-head text-xl font-semibold uppercase">{fmtDay(date)}</div>
            {date !== today() && (
              <button className="text-xs text-brand font-semibold" onClick={() => setDate(today())}>Jump to today</button>
            )}
          </div>
          <button className="btn-ghost px-3" onClick={() => setDate(addDays(date, 1))}>▶</button>
        </div>
        <div className="grid grid-cols-7 gap-1 mt-3">
          {week.map((d) => {
            const filled = days[d] && Object.keys(days[d]).length > 0
            return (
              <button
                key={d}
                onClick={() => setDate(d)}
                className={`rounded-lg py-1.5 text-center ${d === date ? 'bg-ink text-white' : d === today() ? 'bg-red-50' : 'bg-neutral-50'}`}
              >
                <div className="text-[0.65rem] uppercase opacity-70">{DOW[dow(d)]}</div>
                <div className="text-sm font-bold">{parse(d).getDate()}</div>
                <div className={`mx-auto mt-0.5 w-1.5 h-1.5 rounded-full ${filled ? 'bg-emerald-500' : 'bg-transparent'}`} />
              </button>
            )
          })}
        </div>
      </div>

      <MealsCard date={date} meals={day.meals || {}} plan={plans[date] || {}} onChange={set('meals')} isTrainer={isTrainer} data={data} />
      <MacrosCard macros={day.macros || {}} onChange={set('macros')} />
      <HabitsCard habits={day.habits || {}} onChange={set('habits')} client={client} />
      <SleepCard sleep={day.sleep || {}} onChange={set('sleep')} />
      <TrainingCard date={date} training={day.training || {}} onChange={set('training')} />
    </div>
  )
}

// ── Meals ────────────────────────────────────────────────────────────────────
function MealsCard({ date, meals, plan, onChange, isTrainer, data }) {
  const setMeal = (no, patch) => onChange({ ...meals, [no]: { ...(meals[no] || {}), ...patch } })
  return (
    <Card icon="🍴" title="Nutrition">
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
                      <div className="text-sm mt-1">
                        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-neutral-500">Planned meal: </span>
                        {plan[m.no]?.trim() ? <span className="whitespace-pre-wrap">{plan[m.no]}</span> : <span className="italic text-neutral-400">Not set by trainer</span>}
                      </div>
                    )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMeal(m.no, { taken: v.taken === true ? null : true })}
                  className={`btn border ${v.taken === true ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-neutral-300'}`}
                >✓ Taken as planned</button>
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
                  placeholder="If not taken, what did you eat?"
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
    <Card icon="📊" title="Daily macros & summary">
      <div className="p-4 grid grid-cols-2 sm:grid-cols-5 gap-3">
        {MACROS.map((m) => (
          <label key={m.k} className="block">
            <span className="lbl">{m.icon} {m.label} ({m.unit})</span>
            <input className="inp" type="number" inputMode="decimal" min="0"
              value={macros[m.k] ?? ''} onChange={(e) => set(m.k, e.target.value)} />
          </label>
        ))}
        <label className="block col-span-2 sm:col-span-5">
          <span className="lbl">💊 Supplementation</span>
          <input className="inp" placeholder="e.g. Whey 1 scoop, Creatine 5g, Multivitamin"
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
  const stepsHit = stepsTarget && num(habits.steps) >= stepsTarget
  const waterHit = num(habits.water) >= waterTarget
  return (
    <Card icon="✅" title="Daily habits">
      <Row label="👟 Steps" hint={stepsTarget ? `Target: ${stepsTarget.toLocaleString('en-IN')}` : 'No target set'}>
        <div className="flex items-center gap-2">
          <input className="inp w-28" type="number" inputMode="numeric" min="0" placeholder="0"
            value={habits.steps ?? ''} onChange={(e) => set('steps', e.target.value)} />
          <span className={`text-lg ${stepsHit ? '' : 'opacity-20'}`}>✅</span>
        </div>
      </Row>
      <Row label="💧 Water (litres)" hint={`Target: ${waterTarget}+ L`}>
        <div className="flex items-center gap-2">
          <input className="inp w-28" type="number" inputMode="decimal" min="0" step="0.25" placeholder="0"
            value={habits.water ?? ''} onChange={(e) => set('water', e.target.value)} />
          <span className={`text-lg ${waterHit ? '' : 'opacity-20'}`}>✅</span>
        </div>
      </Row>
      <Row label="💊 Supplements taken"><YesNo value={habits.supplements ?? null} onChange={(v) => set('supplements', v)} /></Row>
      <Row label="🚫 No cheat meal"><YesNo value={habits.no_cheat ?? null} onChange={(v) => set('no_cheat', v)} /></Row>
      <Row label="🪷 Stress under control"><YesNo value={habits.stress_ok ?? null} onChange={(v) => set('stress_ok', v)} /></Row>
      <Row label="🙂 Mood / energy" hint="1 = low, 5 = great"><Rating value={habits.mood ?? null} onChange={(v) => set('mood', v)} /></Row>
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
    <Card icon="🛏️" title="Sleep tracker">
      <div className="p-4 grid grid-cols-3 gap-3 border-b border-neutral-100">
        <label className="block"><span className="lbl">🕙 Bed time</span>
          <input className="inp" type="time" value={sleep.bed || ''} onChange={(e) => set('bed', e.target.value)} /></label>
        <label className="block"><span className="lbl">⏰ Wake time</span>
          <input className="inp" type="time" value={sleep.wake || ''} onChange={(e) => set('wake', e.target.value)} /></label>
        <div>
          <span className="lbl">Total sleep</span>
          <div className={`rounded-lg px-3 py-2 text-sm font-bold ${hrs == null ? 'bg-neutral-50 text-neutral-400' : goal ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
            {hrs == null ? '—' : `${hrs} h ${goal ? '✓' : ''}`}
          </div>
        </div>
      </div>
      <Row label="🎯 Sleep goal (7–9 hrs)"><span className="text-sm font-semibold">{hrs == null ? '—' : goal ? '✅ Met' : '❌ Missed'}</span></Row>
      <Row label="📶 Sleep quality" hint="1–5"><Rating value={sleep.quality ?? null} onChange={(v) => set('quality', v)} /></Row>
      <Row label="🌙 Felt refreshed"><YesNo value={sleep.refreshed ?? null} onChange={(v) => set('refreshed', v)} /></Row>
      <Row label="🔋 Energy level" hint="1–5"><Rating value={sleep.energy ?? null} onChange={(v) => set('energy', v)} /></Row>
      <Row label="🧠 Stress level" hint="1–5"><Rating value={sleep.stress ?? null} onChange={(v) => set('stress', v)} /></Row>
    </Card>
  )
}

// ── Training ─────────────────────────────────────────────────────────────────
function TrainingCard({ date, training, onChange }) {
  const type = training.type || DEFAULT_SPLIT[dow(date)]
  const meta = TRAINING_TYPES.find((t) => t.k === type)
  const exercises = training.exercises || []
  const set = (patch) => onChange({ ...training, type, ...patch })
  const setEx = (i, patch) => set({ exercises: exercises.map((x, j) => (j === i ? { ...x, ...patch } : x)) })

  return (
    <Card icon="🏋️" title="Training">
      <div className="p-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          {TRAINING_TYPES.map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => set({ type: t.k })}
              className={`btn border ${type === t.k ? 'bg-ink border-ink text-white' : 'bg-white border-neutral-300'}`}
            >{t.icon} {t.label}</button>
          ))}
        </div>
        <Check checked={!!training.done} onChange={(v) => set({ done: v })} label="Done" />

        {meta?.sets && (
          <div>
            <div className="grid grid-cols-[1fr_3.5rem_3.5rem_4.5rem_1.75rem] gap-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-neutral-500 mb-1">
              <span>Exercise</span><span>Sets</span><span>Reps</span><span>Weight kg</span><span />
            </div>
            <div className="space-y-1.5">
              {exercises.map((x, i) => (
                <div key={i} className="grid grid-cols-[1fr_3.5rem_3.5rem_4.5rem_1.75rem] gap-1.5">
                  <input className="inp px-2" placeholder="e.g. Bench press" value={x.name || ''} onChange={(e) => setEx(i, { name: e.target.value })} />
                  <input className="inp px-2" inputMode="numeric" value={x.sets || ''} onChange={(e) => setEx(i, { sets: e.target.value })} />
                  <input className="inp px-2" inputMode="text" placeholder="10" value={x.reps || ''} onChange={(e) => setEx(i, { reps: e.target.value })} />
                  <input className="inp px-2" inputMode="decimal" value={x.weight || ''} onChange={(e) => setEx(i, { weight: e.target.value })} />
                  <button type="button" className="text-neutral-400 hover:text-brand" title="Remove"
                    onClick={() => set({ exercises: exercises.filter((_, j) => j !== i) })}>✕</button>
                </div>
              ))}
            </div>
            <button type="button" className="btn-ghost mt-2" onClick={() => set({ exercises: [...exercises, {}] })}>+ Add exercise</button>
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
