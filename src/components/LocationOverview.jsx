import { isDashboardVisible, isOverdueNow, dueDateTime, formatTime } from '../utils/taskUtils'

// Always-on overview: per location, how many tasks are waiting there (due = started &
// not overdue), how many are overdue, and the nearest deadline. Tap a location to
// "arrive" there (sets it as the current location and filters the dashboard).
export default function LocationOverview({ tasks, locations = [], currentLocationId, onArrive }) {
  const visible = tasks.filter(t => isDashboardVisible(t, tasks))
  const goalIdSet = new Set(tasks.filter(t => t.parent_id).map(t => t.parent_id))
  const inPlay = visible.filter(t => !goalIdSet.has(t.id))

  function statsFor(predicate) {
    const list = inPlay.filter(predicate)
    const overdue = list.filter(isOverdueNow)
    const due = list.filter(t => !isOverdueNow(t))
    const deadlines = list.map(dueDateTime).filter(Boolean).sort((a, b) => a - b)
    return { total: list.length, overdue: overdue.length, due: due.length, nearest: deadlines[0] || null }
  }

  const anywhere = statsFor(t => !t.location_id)
  const rows = locations
    .map(loc => ({ loc, s: statsFor(t => t.location_id === loc.id) }))
    .filter(r => r.s.total > 0)
    // most urgent first: overdue, then soonest deadline, then most tasks
    .sort((a, b) => (b.s.overdue - a.s.overdue)
      || ((a.s.nearest?.getTime() ?? Infinity) - (b.s.nearest?.getTime() ?? Infinity))
      || (b.s.total - a.s.total))

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">📍 Locations</h3>
        {currentLocationId && (
          <button onClick={() => onArrive(null)} className="text-xs text-slate-400 hover:text-slate-600">Show all</button>
        )}
      </div>

      {rows.length === 0 && anywhere.total === 0 && (
        <p className="text-xs text-slate-400">No located tasks pending.</p>
      )}

      {rows.map(({ loc, s }) => {
        const active = loc.id === currentLocationId
        return (
          <button
            key={loc.id}
            onClick={() => onArrive(active ? null : loc.id)}
            className={`w-full text-left rounded-xl border px-3 py-2 transition-colors ${
              active ? 'border-teal-500 bg-teal-50' : 'bg-white border-slate-200 hover:border-teal-300'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-800 text-sm truncate">{loc.name}</span>
              <span className="flex items-center gap-1.5 shrink-0">
                {s.overdue > 0 && (
                  <span className="text-[11px] font-bold text-red-700 bg-red-100 rounded-full px-1.5 py-0.5">{s.overdue} overdue</span>
                )}
                <span className="text-[11px] font-bold text-slate-600 bg-slate-100 rounded-full px-1.5 py-0.5">{s.due} due</span>
              </span>
            </div>
            {s.nearest && (
              <div className="text-[11px] text-slate-400 mt-0.5">next {nearestLabel(s.nearest)}</div>
            )}
          </button>
        )
      })}

      {anywhere.total > 0 && (
        <div className="rounded-xl border border-dashed border-slate-200 px-3 py-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-500">Anywhere</span>
            <span className="flex items-center gap-1.5">
              {anywhere.overdue > 0 && (
                <span className="text-[11px] font-bold text-red-700 bg-red-100 rounded-full px-1.5 py-0.5">{anywhere.overdue} overdue</span>
              )}
              <span className="text-[11px] font-bold text-slate-500 bg-slate-100 rounded-full px-1.5 py-0.5">{anywhere.due} due</span>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function nearestLabel(d) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const day = new Date(d); day.setHours(0, 0, 0, 0)
  const diff = Math.round((day - today) / 86400000)
  const time = formatTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
  const when = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : diff < 0 ? `${-diff}d ago` : `in ${diff}d`
  return `${when} ${time}`
}
