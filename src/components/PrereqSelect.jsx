import { getSubtasks } from '../utils/taskUtils'

// Prerequisite picker grouped by goal. Shows: (optional) the sibling steps of the goal
// currently being built, then existing tasks grouped under their goal (🎯 heading), then
// standalone "Other tasks". Only open (not completed/cancelled) tasks are offered.
export default function PrereqSelect({
  allTasks = [], excludeIds = [],
  selectedTaskIds = [], onToggleTask,
  siblings = [], selectedSiblingKeys = [], onToggleSibling,
}) {
  const exclude = new Set(excludeIds)
  const usable = (t) => !exclude.has(t.id) && t.status !== 'cancelled' && t.status !== 'completed'

  const childParentIds = new Set(allTasks.filter(t => t.parent_id).map(t => t.parent_id))
  const goals = allTasks.filter(t => childParentIds.has(t.id) && t.status !== 'cancelled')

  const goalGroups = goals
    .map(g => ({ goal: g, items: getSubtasks(g, allTasks).filter(usable) }))
    .filter(grp => grp.items.length)

  const standalone = allTasks.filter(t => usable(t) && !t.parent_id && !childParentIds.has(t.id))

  if (!siblings.length && !goalGroups.length && !standalone.length) {
    return <p className="text-xs text-slate-400">No other tasks to depend on yet.</p>
  }

  const Row = ({ checked, onChange, label }) => (
    <label className="flex items-center gap-2 cursor-pointer py-0.5">
      <input type="checkbox" checked={checked} onChange={onChange} className="rounded" />
      <span className="text-sm text-slate-700 truncate">{label}</span>
    </label>
  )

  return (
    <div className="max-h-44 overflow-y-auto space-y-2 border border-slate-200 rounded-lg p-2 bg-slate-50">
      {siblings.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-indigo-600 mb-0.5">This goal’s steps</p>
          {siblings.map(s => (
            <Row key={s.key} checked={selectedSiblingKeys.includes(s.key)} onChange={() => onToggleSibling(s.key)} label={s.label} />
          ))}
        </div>
      )}
      {goalGroups.map(grp => (
        <div key={grp.goal.id}>
          <p className="text-xs font-semibold text-indigo-600 mb-0.5">🎯 {grp.goal.title}</p>
          {grp.items.map(t => (
            <Row key={t.id} checked={selectedTaskIds.includes(t.id)} onChange={() => onToggleTask(t.id)} label={t.title} />
          ))}
        </div>
      ))}
      {standalone.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-500 mb-0.5">Other tasks</p>
          {standalone.map(t => (
            <Row key={t.id} checked={selectedTaskIds.includes(t.id)} onChange={() => onToggleTask(t.id)} label={t.title} />
          ))}
        </div>
      )}
    </div>
  )
}
