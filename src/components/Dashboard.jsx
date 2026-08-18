import { isDashboardVisible, isCurrentlyActive, isOverdueNow, sortDashboardTasks, matchesLocation, windowStartsLaterToday } from '../utils/taskUtils'
import TaskCard from './TaskCard'
import GoalsPanel from './GoalsPanel'
import LocationOverview from './LocationOverview'
import QuickAdd from './QuickAdd'

export default function Dashboard({ tasks, locations = [], currentLocationId = null, onArrive, onEdit, onComplete, onDelete, onQuickSave, onAddGoal, onAddStep }) {
  // Ids of tasks that are goals (have ≥1 sub-task). Goal PARENTS are excluded from the
  // matrix (they're containers); their sub-tasks stay in the matrix like any task.
  const goalIdSet = new Set(tasks.filter(t => t.parent_id).map(t => t.parent_id))

  const visible = tasks.filter(t => isDashboardVisible(t, tasks)).filter(t => !goalIdSet.has(t.id))

  // Presence: only tasks at the current location (+ location-less "anywhere" tasks).
  const present = visible.filter(t => matchesLocation(t, currentLocationId))

  const overdue = sortDashboardTasks(present.filter(t => isOverdueNow(t)))
  const now     = sortDashboardTasks(present.filter(t => !isOverdueNow(t) && isCurrentlyActive(t)))
  const later   = sortDashboardTasks(present.filter(t => !isOverdueNow(t) && !isCurrentlyActive(t) && windowStartsLaterToday(t)))

  const total = overdue.length + now.length + later.length
  const currentName = locations.find(l => l.id === currentLocationId)?.name || null

  const goalsProps = { tasks, locations, onEdit, onComplete, onDelete, onAddGoal, onAddStep }
  const overviewProps = { tasks, locations, currentLocationId, onArrive }

  return (
    <div className="lg:flex lg:gap-6 lg:items-start">
      {/* Left (desktop): always-on location overview */}
      <aside className="hidden lg:block w-[240px] shrink-0 lg:sticky lg:top-6">
        <LocationOverview {...overviewProps} />
      </aside>

      {/* Middle: the priority matrix */}
      <div className="flex-1 min-w-0 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800">
            {currentName ? `At: ${currentName}` : "Today's Dashboard"}
          </h2>
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

      {/* Location overview — mobile (horizontal scroll strip, always visible) */}
      <div className="lg:hidden">
        <LocationOverview {...overviewProps} />
      </div>

      {/* New goal — mobile only (desktop has the goals sidebar) */}
      <button
        onClick={onAddGoal}
        className="lg:hidden w-full py-2 rounded-xl border border-dashed border-indigo-300 text-indigo-600 text-sm font-medium hover:bg-indigo-50 transition-colors"
      >
        🎯 New Goal (multi-step)
      </button>

      {total === 0 && (
        <div className="text-center py-16 text-slate-400">
          <div className="text-4xl mb-3">✓</div>
          <p className="font-medium">{currentName ? `Nothing to do at ${currentName} right now` : 'All clear for today!'}</p>
          <p className="text-sm mt-1">{currentName ? 'Check the Locations panel for what’s waiting elsewhere.' : 'No pending tasks right now.'}</p>
        </div>
      )}

      {overdue.length > 0 && (
        <Section title="Overdue" count={overdue.length} accent="red" subtitle="Past deadline">
          {overdue.map(t => (
            <TaskCard key={t.id} task={t} tasks={tasks} locations={locations} bucket="overdue" onEdit={onEdit} onComplete={onComplete} onDelete={onDelete} />
          ))}
        </Section>
      )}

      {now.length > 0 && (
        <Section title="Now" count={now.length} accent="blue" dot="bg-green-400" subtitle="Do it here, now">
          {now.map(t => (
            <TaskCard key={t.id} task={t} tasks={tasks} locations={locations} bucket="current" onEdit={onEdit} onComplete={onComplete} onDelete={onDelete} />
          ))}
        </Section>
      )}

      {later.length > 0 && (
        <Section title="Later today" count={later.length} accent="slate" subtitle="Its time window opens later">
          {later.map(t => (
            <TaskCard key={t.id} task={t} tasks={tasks} locations={locations} onEdit={onEdit} onComplete={onComplete} onDelete={onDelete} />
          ))}
        </Section>
      )}
      </div>

      {/* Right: goals sidebar (desktop only; mobile uses the Goals tab) */}
      <aside className="hidden lg:block w-[300px] shrink-0 lg:sticky lg:top-6">
        <GoalsPanel {...goalsProps} />
      </aside>
    </div>
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
