import GoalCard from './GoalCard'

// The goals column: "New Goal" button + the list of active goal boxes.
// Rendered as a right sidebar on desktop and as a dedicated tab on mobile.
export default function GoalsPanel({ tasks = [], locations = [], onEdit, onComplete, onDelete, onAddGoal, onAddStep }) {
  const goalIdSet = new Set(tasks.filter(t => t.parent_id).map(t => t.parent_id))
  const goals = tasks.filter(t =>
    goalIdSet.has(t.id) && !t.parent_id && t.status !== 'completed' && t.status !== 'cancelled'
  )

  return (
    <div className="space-y-3">
      <button
        onClick={onAddGoal}
        className="w-full py-2 rounded-xl border border-dashed border-indigo-300 text-indigo-600 text-sm font-medium hover:bg-indigo-50 transition-colors"
      >
        🎯 New Goal (multi-step)
      </button>

      {goals.length > 0 ? (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">Goals</h3>
            <span className="text-xs font-bold px-2 py-0.5 rounded-full border text-indigo-700 bg-indigo-50 border-indigo-200">{goals.length}</span>
            <span className="text-xs text-slate-400">Multi-step</span>
          </div>
          <div className="space-y-3">
            {goals.map(g => (
              <GoalCard key={g.id} goal={g} tasks={tasks} locations={locations}
                onEdit={onEdit} onComplete={onComplete} onDelete={onDelete} onAddStep={onAddStep} />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-400 text-center py-8">No goals yet.<br />Create one to break a big task into steps.</p>
      )}
    </div>
  )
}
