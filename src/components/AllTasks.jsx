import { useState } from 'react'
import TaskCard from './TaskCard'

const STATUS_ORDER = ['pending', 'in_progress', 'completed', 'cancelled']
const STATUS_LABELS = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

export default function AllTasks({ tasks, locations = [], onEdit, onComplete, onDelete }) {
  const [filter, setFilter] = useState('all')

  const filtered = filter === 'all'
    ? tasks
    : filter === 'recurring'
    ? tasks.filter(t => t.is_recurring)
    : tasks.filter(t => t.status === filter)

  const grouped = STATUS_ORDER.reduce((acc, status) => {
    const group = filtered.filter(t => t.status === status)
    if (group.length > 0) acc[status] = group
    return acc
  }, {})

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-800">All Tasks</h2>
        <span className="text-sm text-slate-500">{tasks.length} total</span>
      </div>

      {/* Filters */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {['all', 'pending', 'in_progress', 'completed', 'recurring'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-sm font-medium px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
              filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-white border border-slate-200 text-slate-600 hover:border-blue-300'
            }`}
          >
            {f === 'all' ? 'All' : f === 'in_progress' ? 'In Progress' : f === 'recurring' ? '↻ Recurring' : STATUS_LABELS[f]}
          </button>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-slate-400">No tasks found.</div>
      )}

      {filter === 'all' || filter === 'recurring'
        ? <div className="space-y-3">
            {filtered.map(t => (
              <TaskCard key={t.id} task={t} tasks={tasks} locations={locations} onEdit={onEdit} onComplete={onComplete} onDelete={onDelete} />
            ))}
          </div>
        : Object.entries(grouped).map(([status, group]) => (
            <div key={status}>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                {STATUS_LABELS[status]} ({group.length})
              </h3>
              <div className="space-y-3">
                {group.map(t => (
                  <TaskCard key={t.id} task={t} tasks={tasks} locations={locations} onEdit={onEdit} onComplete={onComplete} onDelete={onDelete} />
                ))}
              </div>
            </div>
          ))
      }
    </div>
  )
}
