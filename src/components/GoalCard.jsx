import { format, parseISO } from 'date-fns'
import { getSubtasks, goalProgress, isTaskDoneForToday, prerequisitesMet, formatTime } from '../utils/taskUtils'

// Compact goal overview: progress bar + the full step list (including future/blocked steps
// that aren't in today's matrix yet). The actual prioritised, actionable copies of these
// sub-tasks also live in the Overdue/Current/Upcoming buckets — this is the plan view.
export default function GoalCard({ goal, tasks, locations = [], onEdit, onComplete, onDelete, onAddStep }) {
  const subs = getSubtasks(goal, tasks).filter(t => t.status !== 'cancelled')
  const { done, total } = goalProgress(goal, tasks)
  const pct = total ? Math.round((done / total) * 100) : 0

  const ordered = [...subs].sort((a, b) =>
    (a.status === 'completed' ? 1 : 0) - (b.status === 'completed' ? 1 : 0)
  )

  return (
    <div className="bg-white rounded-xl border border-indigo-200 overflow-hidden">
      {/* Goal header */}
      <div className="p-4 bg-indigo-50/60 border-b border-indigo-100">
        <div className="flex items-start gap-3">
          <span className="text-xl leading-none mt-0.5">🎯</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-slate-900 leading-snug">{goal.title}</h3>
              <span className="text-xs font-bold text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-full">
                {done}/{total} done
              </span>
              {goal.due_date && (
                <span className="text-xs text-slate-500">Goal due {format(parseISO(goal.due_date), 'MMM d')}</span>
              )}
            </div>
            <div className="mt-2 h-1.5 w-full rounded-full bg-indigo-100 overflow-hidden">
              <div className="h-full rounded-full bg-indigo-500 transition-all duration-500" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="flex flex-col gap-1 shrink-0 text-right">
            <button onClick={() => onEdit(goal)} className="text-xs text-slate-400 hover:text-slate-700 transition-colors py-0.5">Edit</button>
            <button onClick={() => onDelete(goal.id)} className="text-xs text-slate-300 hover:text-red-500 transition-colors py-0.5">Delete</button>
          </div>
        </div>
      </div>

      {/* Steps (compact) */}
      <div className="divide-y divide-slate-50">
        {ordered.map(t => {
          const isDone = isTaskDoneForToday(t)
          const blocked = !isDone && !prerequisitesMet(t, tasks)
          const location = locations.find(l => l.id === t.location_id)
          const timeRange = t.start_time && t.end_time ? `${formatTime(t.start_time)}–${formatTime(t.end_time)}` : null
          return (
            <div key={t.id} className="flex items-center gap-2.5 px-4 py-2">
              <button
                onClick={() => onComplete(t)}
                title={isDone ? 'Completed' : 'Mark done'}
                className={`w-5 h-5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors group ${
                  isDone ? 'border-green-500 bg-green-500' : 'border-slate-300 hover:border-green-500 hover:bg-green-50'
                }`}
              >
                <svg className={`w-2.5 h-2.5 ${isDone ? 'text-white' : 'text-transparent group-hover:text-green-500'}`} fill="none" stroke="currentColor" strokeWidth={3.5} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </button>
              <button onClick={() => onEdit(t)} className="flex-1 min-w-0 text-left">
                <span className={`text-sm ${isDone ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{t.title}</span>
                <span className="ml-2 text-xs text-slate-400 whitespace-nowrap">
                  {location ? `📍${location.name} ` : ''}{timeRange || ''}
                  {blocked && <span className="text-orange-500"> · waiting</span>}
                </span>
              </button>
            </div>
          )
        })}
      </div>

      {/* Add step */}
      <button
        onClick={() => onAddStep(goal.id)}
        className="w-full text-left px-4 py-2.5 text-sm text-indigo-600 hover:bg-indigo-50 transition-colors border-t border-slate-50"
      >
        + Add step
      </button>
    </div>
  )
}
