import { format, parseISO, startOfDay, isAfter } from 'date-fns'
import { formatTime, formatDuration, getRecurrenceLabel, isTaskDoneForToday } from '../utils/taskUtils'

export default function TaskCard({ task, tasks, locations = [], onComplete, onEdit, onDelete }) {
  const today = startOfDay(new Date())
  const isOverdue = !task.is_recurring && task.due_date && isAfter(today, startOfDay(parseISO(task.due_date)))

  const prereqTasks = (task.prerequisite_ids || [])
    .map(id => tasks.find(t => t.id === id))
    .filter(Boolean)
  const unmetPrereqs = prereqTasks.filter(t => !isTaskDoneForToday(t))
  const isBlocked = unmetPrereqs.length > 0

  const location = locations.find(l => l.id === task.location_id)

  const timeRange = task.start_time && task.end_time
    ? `${formatTime(task.start_time)} – ${formatTime(task.end_time)}`
    : null

  return (
    <div
      className={`bg-white rounded-xl border p-4 transition-shadow hover:shadow-md ${
        isOverdue ? 'border-red-200' : isBlocked ? 'border-orange-200' : 'border-slate-100'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Round complete button */}
        <button
          onClick={() => onComplete(task)}
          title="Mark done"
          className="mt-1 w-6 h-6 shrink-0 rounded-full border-2 border-slate-300 hover:border-green-500 hover:bg-green-50 flex items-center justify-center transition-colors group"
        >
          <svg className="w-3 h-3 text-transparent group-hover:text-green-500 transition-colors" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          {/* Badges */}
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {task.is_recurring && (
              <Badge color="purple">↻ {getRecurrenceLabel(task.recurrence)}</Badge>
            )}
            {location && <Badge color="teal">📍 {location.name}</Badge>}
            {isOverdue && <Badge color="red">Overdue</Badge>}
            {isBlocked && <Badge color="orange">Blocked</Badge>}
            {task.status === 'in_progress' && <Badge color="blue">In Progress</Badge>}
          </div>

          <h3 className="font-semibold text-slate-900 leading-snug">{task.title}</h3>

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

function Badge({ color, children }) {
  const styles = {
    purple: 'bg-purple-100 text-purple-700',
    red: 'bg-red-100 text-red-700',
    orange: 'bg-orange-100 text-orange-700',
    blue: 'bg-blue-100 text-blue-700',
    green: 'bg-green-100 text-green-700',
    teal: 'bg-teal-100 text-teal-700',
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
