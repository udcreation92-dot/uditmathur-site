import { useState, useEffect } from 'react'
import { format, parseISO, startOfDay, isAfter } from 'date-fns'
import { formatTime, formatDuration, getRecurrenceLabel, isTaskDoneForToday, taskLocationIds, recurringDeadline, isActiveToday } from '../utils/taskUtils'

export default function TaskCard({ task, tasks, locations = [], bucket, nested = false, onComplete, onEdit, onDelete }) {
  const today = startOfDay(new Date())
  const isOverdue = !task.is_recurring && task.due_date && isAfter(today, startOfDay(parseISO(task.due_date)))
  const isDone = isTaskDoneForToday(task)
  const parentGoal = task.parent_id ? tasks.find(t => t.id === task.parent_id) : null

  const prereqTasks = (task.prerequisite_ids || [])
    .map(id => tasks.find(t => t.id === id))
    .filter(Boolean)
  // Only prerequisites that are active TODAY and not yet done actually block this task.
  const unmetPrereqs = prereqTasks.filter(t => !isTaskDoneForToday(t) && isActiveToday(t))
  const isBlocked = unmetPrereqs.length > 0

  const taskLocs = taskLocationIds(task).map(id => locations.find(l => l.id === id)).filter(Boolean)

  const timeRange = task.start_time && task.end_time
    ? `${formatTime(task.start_time)} – ${formatTime(task.end_time)}`
    : null

  return (
    <div
      className={`rounded-xl border transition-shadow hover:shadow-md ${nested ? 'p-3' : 'p-4'} ${
        isDone ? 'bg-slate-50 border-slate-100' :
        isOverdue ? 'bg-white border-red-200' : isBlocked ? 'bg-white border-orange-200' : 'bg-white border-slate-100'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Round complete button */}
        <button
          onClick={() => onComplete(task)}
          title={isDone ? 'Completed' : 'Mark done'}
          className={`mt-1 w-6 h-6 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors group ${
            isDone ? 'border-green-500 bg-green-500' : 'border-slate-300 hover:border-green-500 hover:bg-green-50'
          }`}
        >
          <svg className={`w-3 h-3 ${isDone ? 'text-white' : 'text-transparent group-hover:text-green-500'} transition-colors`} fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          {/* Badges */}
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {!isDone && (bucket === 'current' || bucket === 'overdue') && (
              <Countdown task={task} overdue={bucket === 'overdue'} />
            )}
            {parentGoal && !nested && <Badge color="indigo">🎯 {parentGoal.title}</Badge>}
            {task.is_recurring && (
              <Badge color="purple">↻ {getRecurrenceLabel(task.recurrence)}</Badge>
            )}
            {taskLocs.map(l => <Badge key={l.id} color="teal">📍 {l.name}</Badge>)}
            {isOverdue && !isDone && <Badge color="red">Overdue</Badge>}
            {isBlocked && !isDone && <Badge color="orange">Blocked</Badge>}
            {task.status === 'in_progress' && <Badge color="blue">In Progress</Badge>}
          </div>

          <h3 className={`font-semibold leading-snug ${isDone ? 'text-slate-400 line-through' : 'text-slate-900'}`}>{task.title}</h3>

          {task.description && (
            <p className="text-sm text-slate-500 mt-0.5 line-clamp-2">{task.description}</p>
          )}

          {/* Meta info */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm text-slate-600">
            {timeRange && (
              <span className="flex items-center gap-1">
                <ClockIcon /> {timeRange}
              </span>
            )}
            {task.start_date && (
              <span className="flex items-center gap-1">
                <CalIcon /> Start {format(parseISO(task.start_date), 'MMM d')}
              </span>
            )}
            {task.due_date && (
              <span className={`flex items-center gap-1 ${isOverdue ? 'text-red-600 font-medium' : ''}`}>
                <CalIcon /> Due {format(parseISO(task.due_date), 'MMM d')}
              </span>
            )}
            {task.duration_minutes > 0 && (
              <span className="flex items-center gap-1">
                <TimerIcon /> {formatDuration(task.duration_minutes)}
              </span>
            )}
          </div>

          {/* Blocked by */}
          {unmetPrereqs.length > 0 && (
            <p className="mt-1.5 text-xs text-orange-600">
              Waiting on: {unmetPrereqs.map(t => t.title).join(', ')}
            </p>
          )}

          {/* Met prerequisites */}
          {prereqTasks.length > 0 && unmetPrereqs.length === 0 && (
            <p className="mt-1.5 text-xs text-green-600">
              Prerequisites met
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1 shrink-0 text-right">
          <button
            onClick={() => onEdit(task)}
            className="text-xs text-slate-400 hover:text-slate-700 transition-colors py-0.5"
          >
            Edit
          </button>
          <button
            onClick={() => onDelete(task.id)}
            className="text-xs text-slate-300 hover:text-red-500 transition-colors py-0.5"
          >
            Delete
          </button>
        </div>
      </div>

    </div>
  )
}

// The absolute deadline moment for a task: its deadline date at end_time.
// Recurring -> today; else due_date, then start_date, then today. Null if no end_time.
function deadlineFor(task) {
  if (task.is_recurring) return recurringDeadline(task) // occurrence-based (handles day-range)
  if (!task.end_time) return null
  let datePart
  if (task.due_date) datePart = startOfDay(parseISO(task.due_date))
  else if (task.start_date) datePart = startOfDay(parseISO(task.start_date))
  else datePart = startOfDay(new Date())
  const [h, m] = task.end_time.split(':').map(Number)
  const d = new Date(datePart)
  d.setHours(h, m, 0, 0)
  return d
}

function fmtSpan(ms) {
  const s = Math.floor(Math.abs(ms) / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

// Live countdown pill. Ticks every second. Shows "time left" for current tasks and
// "overdue by ..." for overdue tasks.
function Countdown({ task, overdue }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const deadline = deadlineFor(task)

  // Overdue purely by date (no usable end_time): count from end of the due day.
  if (!deadline) {
    if (overdue && task.due_date) {
      const eod = startOfDay(parseISO(task.due_date))
      eod.setHours(23, 59, 0, 0)
      return <CountChip overdue text={`overdue by ${fmtSpan(now - eod.getTime())}`} />
    }
    return null
  }

  const diff = deadline.getTime() - now
  if (diff <= 0) return <CountChip overdue text={`overdue by ${fmtSpan(diff)}`} />

  const urgent = diff < 30 * 60 * 1000 // under 30 min left
  return <CountChip urgent={urgent} text={`${fmtSpan(diff)} left`} />
}

function CountChip({ text, overdue, urgent }) {
  const cls = overdue
    ? 'bg-red-600 text-white'
    : urgent
      ? 'bg-amber-500 text-white'
      : 'bg-emerald-600 text-white'
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full tabular-nums ${cls}`}>
      <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 3h6"/></svg>
      {text}
    </span>
  )
}

function Badge({ color, children }) {
  const styles = {
    purple: 'bg-purple-100 text-purple-700',
    red: 'bg-red-100 text-red-700',
    orange: 'bg-orange-100 text-orange-700',
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    teal: 'bg-teal-100 text-teal-700',
    indigo: 'bg-indigo-100 text-indigo-700',
  }
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${styles[color]}`}>
      {children}
    </span>
  )
}

function ClockIcon() {
  return <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
}

function CalIcon() {
  return <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
}

function TimerIcon() {
  return <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 3M9 3h6"/></svg>
}
