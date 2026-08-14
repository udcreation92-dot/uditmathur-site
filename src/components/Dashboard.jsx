import { useState } from 'react'
import { isDashboardVisible, isCurrentlyActive, isOverdueNow, sortDashboardTasks } from '../utils/taskUtils'
import TaskCard from './TaskCard'
import GoalsPanel from './GoalsPanel'
import QuickAdd from './QuickAdd'

export default function Dashboard({ tasks, locations = [], onEdit, onComplete, onDelete, onQuickSave, onAddGoal, onAddStep }) {
  const [locationFilter, setLocationFilter] = useState(null) // null = All

  // Ids of tasks that are goals (have ≥1 sub-task). Goal PARENTS are excluded from the
  // matrix (they're containers); their sub-tasks stay in the matrix like any task.
  const goalIdSet = new Set(tasks.filter(t => t.parent_id).map(t => t.parent_id))

  const visible = tasks.filter(t => isDashboardVisible(t, tasks))

  const filtered = (locationFilter
    ? visible.filter(t => t.location_id === locationFilter)
    : visible
  ).filter(t => !goalIdSet.has(t.id))

  const overdue  = sortDashboardTasks(filtered.filter(t => isOverdueNow(t)))
  const current  = sortDashboardTasks(filtered.filter(t => !isOverdueNow(t) && isCurrentlyActive(t)))
  const upcoming = sortDashboardTasks(filtered.filter(t => !isOverdueNow(t) && !isCurrentlyActive(t)))

  const total = overdue.length + current.length + upcoming.length

  // Only show locations that have visible tasks
  const activeLocations = locations.filter(loc =>
    visible.some(t => t.location_id === loc.id)
  )

  const goalsProps = { tasks, locations, onEdit, onComplete, onDelete, onAddGoal, onAddStep }

  return (
    <div className="lg:flex lg:gap-6 lg:items-start">
      {/* Left: the priority matrix */}
      <div className="flex-1 min-w-0 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">Today's Dashboard</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>
        <span className="text-sm font-medium text-slate-500">
          {total} task{total !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Quick add bar */}
      <QuickAdd locations={locations} onSaved={onQuickSave} />

      {/* New goal — mobile only (desktop has the goals sidebar) */}
      <button
        onClick={onAddGoal}
        className="lg:hidden w-full py-2 rounded-xl border border-dashed border-indigo-300 text-indigo-600 text-sm font-medium hover:bg-indigo-50 transition-colors"
      >
        🎯 New Goal (multi-step)
      </button>

      {/* Location filter chips */}
      {activeLocations.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          <FilterChip active={locationFilter === null} onClick={() => setLocationFilter(null)}>
            All
          </FilterChip>
          {activeLocations.map(loc => (
            <FilterChip
              key={loc.id}
              active={locationFilter === loc.id}
              onClick={() => setLocationFilter(loc.id === locationFilter ? null : loc.id)}
            >
              📍 {loc.name}
            </FilterChip>
          ))}
        </div>
      )}

      {total === 0 && (
        <div className="text-center py-16 text-slate-400">
          <div className="text-4xl mb-3">✓</div>
          <p className="font-medium">{locationFilter ? 'No tasks for this location' : 'All clear for today!'}</p>
          <p className="text-sm mt-1">No pending tasks right now.</p>
        </div>
      )}

      {overdue.length > 0 && (
        <Section title="Overdue" count={overdue.length} accent="red" subtitle="Missed time window">
          {overdue.map(t => (
            <TaskCard key={t.id} task={t} tasks={tasks} locations={locations} bucket="overdue" onEdit={onEdit} onComplete={onComplete} onDelete={onDelete} />
          ))}
        </Section>
      )}

      {current.length > 0 && (
        <Section title="Current" count={current.length} accent="blue" dot="bg-green-400" subtitle="Active now">
          {current.map(t => (
            <TaskCard key={t.id} task={t} tasks={tasks} locations={locations} bucket="current" onEdit={onEdit} onComplete={onComplete} onDelete={onDelete} />
          ))}
        </Section>
      )}

      {upcoming.length > 0 && (
        <Section title="Upcoming" count={upcoming.length} accent="slate" subtitle="Starting later today">
          {upcoming.map(t => (
            <TaskCard key={t.id} task={t} tasks={tasks} locations={locations} onEdit={onEdit} onComplete={onComplete} onDelete={onDelete} />
          ))}
        </Section>
      )}
      </div>

      {/* Right: goals sidebar (desktop only; mobile uses the Goals tab) */}
      <aside className="hidden lg:block w-[340px] shrink-0 lg:sticky lg:top-6">
        <GoalsPanel {...goalsProps} />
      </aside>
    </div>
  )
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`whitespace-nowrap text-sm font-medium px-3 py-1.5 rounded-full border transition-colors ${
        active
          ? 'bg-teal-600 text-white border-teal-600'
          : 'bg-white text-slate-600 border-slate-200 hover:border-teal-400'
      }`}
    >
      {children}
    </button>
  )
}

function Section({ title, count, accent, dot, subtitle, children }) {
  const badge = {
    red:    'text-red-700 bg-red-50 border-red-200',
    blue:   'text-blue-700 bg-blue-50 border-blue-200',
    slate:  'text-slate-600 bg-slate-100 border-slate-200',
    indigo: 'text-indigo-700 bg-indigo-50 border-indigo-200',
  }
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        {dot && <span className={`w-2 h-2 rounded-full ${dot} animate-pulse`} />}
        <h3 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">{title}</h3>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${badge[accent]}`}>{count}</span>
        {subtitle && <span className="text-xs text-slate-400">{subtitle}</span>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}
