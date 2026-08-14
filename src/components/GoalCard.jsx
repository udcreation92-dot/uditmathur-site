import { format, parseISO } from 'date-fns'
import { getSubtasks, goalProgress, isOverdueNow, isCurrentlyActive } from '../utils/taskUtils'
import TaskCard from './TaskCard'

// A goal = a task with sub-tasks. Renders a header with a live progress bar, then its
// sub-tasks nested underneath. The goal auto-completes (DB trigger) when all are done.
export default function GoalCard({ goal, tasks, locations = [], onEdit, onComplete, onDelete }) {
  const subs = getSubtasks(goal, tasks).filter(t => t.status !== 'cancelled')
  const { done, total } = goalProgress(goal, tasks)
  const pct = total ? Math.round((done / total) * 100) : 0

  // Show actionable sub-tasks first (available now), completed ones last.
  const ordered = [...subs].sort((a, b) => {
    const ad = a.status === 'completed' ? 1 : 0
    const bd = b.status === 'completed' ? 1 : 0
    if (ad !== bd) return ad - bd
    return 0
  })

  const bucketOf = (t) => {
    if (t.status === 'completed') return undefined
    if (isOverdueNow(t)) return 'overdue'
    if (isCurrentlyActive(t)) return 'current'
    return undefined
  }

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
                <span className="text-xs text-slate-500">
                  Goal due {format(parseISO(goal.due_date), 'MMM d')}
                </span>
              )}
            </div>
            {goal.description && (
              <p className="text-sm text-slate-500 mt-0.5 line-clamp-2">{goal.description}</p>
            )}
            {/* Progress bar */}
            <div className="mt-2 h-1.5 w-full rounded-full bg-indigo-100 overflow-hidden">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1 shrink-0 text-right">
            <button
              onClick={() => onEdit(goal)}
              className="text-xs text-slate-400 hover:text-slate-700 transition-colors py-0.5"
            >
              Edit
            </button>
            <button
              onClick={() => onDelete(goal.id)}
              className="text-xs text-slate-300 hover:text-red-500 transition-colors py-0.5"
            >
              Delete
            </button>
          </div>
        </div>
      </div>

      {/* Sub-tasks */}
      <div className="p-3 space-y-2">
        {ordered.map(t => (
          <TaskCard
            key={t.id}
            task={t}
            tasks={tasks}
            locations={locations}
            bucket={bucketOf(t)}
            nested
            onEdit={onEdit}
            onComplete={onComplete}
            onDelete={onDelete}
          />
        ))}
        {ordered.length === 0 && (
          <p className="text-sm text-slate-400 px-1 py-2">No sub-tasks yet — add tasks and set their “Part of goal” to this.</p>
        )}
      </div>
    </div>
  )
}
