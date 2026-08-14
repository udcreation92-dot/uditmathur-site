import { isToday, parseISO, startOfDay, isAfter } from 'date-fns'

export function isRecurringTaskDue(task) {
  if (!task.is_recurring || !task.recurrence) return false

  const now = new Date()
  const rec = task.recurrence
  const lastCompleted = task.last_completed_at ? new Date(task.last_completed_at) : null

  // Already completed today — hide it
  if (lastCompleted && isToday(lastCompleted)) return false

  // Check if today is a scheduled day (no time check — time handled by isCurrentlyActive/isOverdueNow)
  switch (rec.frequency) {
    case 'daily':   return true
    case 'weekly':  return (rec.days || []).includes(now.getDay())
    case 'monthly': return now.getDate() === rec.day
    case 'yearly':  return now.getMonth() + 1 === rec.month && now.getDate() === rec.day
    default:        return false
  }
}

// The most recent scheduled occurrence of a recurring task, on or before today (startOfDay), or null.
function lastScheduledOccurrence(task) {
  const rec = task.recurrence
  if (!rec) return null
  const now = new Date()
  const today = startOfDay(now)

  switch (rec.frequency) {
    case 'daily':
      return today
    case 'weekly': {
      const days = rec.days || []
      if (!days.length) return null
      for (let back = 0; back < 7; back++) {
        const d = new Date(today)
        d.setDate(today.getDate() - back)
        if (days.includes(d.getDay())) return startOfDay(d)
      }
      return null
    }
    case 'monthly': {
      const day = rec.day
      const occ = now.getDate() >= day
        ? new Date(now.getFullYear(), now.getMonth(), day)
        : new Date(now.getFullYear(), now.getMonth() - 1, day)
      return startOfDay(occ)
    }
    case 'yearly': {
      const month = (rec.month || 1) - 1
      let occ = new Date(now.getFullYear(), month, rec.day)
      if (isAfter(startOfDay(occ), today)) occ = new Date(now.getFullYear() - 1, month, rec.day)
      return startOfDay(occ)
    }
    default:
      return null
  }
}

// A recurring task is "missed" if its most recent scheduled occurrence was on a PAST day
// and it has not been completed on/after that occurrence. It keeps nagging (overdue + visible)
// until the user completes it, or until the next occurrence arrives (which resets it).
export function isRecurringMissed(task) {
  if (!task.is_recurring || !task.recurrence) return false
  const occ = lastScheduledOccurrence(task)
  if (!occ) return false
  const today = startOfDay(new Date())
  // Occurrence is today (or future) -> handled by normal due-today / end_time logic, not "missed".
  if (!isAfter(today, occ)) return false
  // Completed on or after the occurrence day -> done, not missed.
  const lastCompleted = task.last_completed_at ? startOfDay(new Date(task.last_completed_at)) : null
  if (lastCompleted && !isAfter(occ, lastCompleted)) return false
  return true
}

// ---- Goals / sub-tasks -------------------------------------------------------
// A "goal" is any task that has at least one sub-task (child pointing to it via parent_id).

export function getSubtasks(task, allTasks) {
  return allTasks.filter(t => t.parent_id === task.id)
}

export function isGoal(task, allTasks) {
  return allTasks.some(t => t.parent_id === task.id)
}

export function isSubtask(task) {
  return !!task.parent_id
}

// { done, total } across a goal's sub-tasks (ignoring cancelled ones).
export function goalProgress(task, allTasks) {
  const subs = getSubtasks(task, allTasks).filter(t => t.status !== 'cancelled')
  const done = subs.filter(t => t.status === 'completed').length
  return { done, total: subs.length }
}

export function isTaskDoneForToday(task) {
  if (!task) return false
  if (task.is_recurring) {
    // Recurring task is "done" if completed today
    return task.last_completed_at ? isToday(new Date(task.last_completed_at)) : false
  }
  return task.status === 'completed'
}

export function prerequisitesMet(task, allTasks) {
  if (!task.prerequisite_ids || task.prerequisite_ids.length === 0) return true
  return task.prerequisite_ids.every(id => {
    const prereq = allTasks.find(t => t.id === id)
    return isTaskDoneForToday(prereq)
  })
}

export function isDashboardVisible(task, allTasks) {
  if (task.is_recurring) return (isRecurringTaskDue(task) || isRecurringMissed(task)) && prerequisitesMet(task, allTasks)

  if (task.status === 'completed' || task.status === 'cancelled') return false

  const now = new Date()
  const today = startOfDay(now)

  // Start date must be today or past
  if (task.start_date) {
    const start = startOfDay(parseISO(task.start_date))
    if (isAfter(start, today)) return false
  }

  if (!prerequisitesMet(task, allTasks)) return false

  return true
}

function getCurrentMins() {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

function toMins(timeStr) {
  const [h, m] = timeStr.split(':').map(Number)
  return h * 60 + m
}

// Task is active right now: start_time passed AND end_time not yet passed
export function isCurrentlyActive(task) {
  const cur = getCurrentMins()
  const started = !task.start_time || cur >= toMins(task.start_time)
  const notEnded = !task.end_time || cur <= toMins(task.end_time)
  return started && notEnded
}

// Task time window has passed, or due_date is in the past
export function isOverdueNow(task) {
  const now = new Date()
  const today = startOfDay(now)
  const cur = getCurrentMins()

  if (task.is_recurring) {
    // Missed on a previous scheduled day and not completed since -> stays overdue.
    if (isRecurringMissed(task)) return true
    // Otherwise overdue if today's time window has fully passed.
    if (task.start_time && task.end_time) {
      return cur > toMins(task.end_time)
    }
    return false
  }

  // Non-recurring with a due date: overdue requires the DEADLINE DATE to have arrived.
  // A future due date is never overdue, even if today's end_time has already passed.
  if (task.due_date) {
    const due = startOfDay(parseISO(task.due_date))
    if (isAfter(due, today)) return false                 // deadline still in the future
    if (isAfter(today, due)) return true                  // deadline date fully passed
    // Deadline is today -> overdue only once the end_time has passed.
    if (task.start_time && task.end_time) return cur > toMins(task.end_time)
    return false
  }

  // No due date: fall back to today's time window.
  if (task.start_time && task.end_time) {
    return cur > toMins(task.end_time)
  }

  return false
}

export function sortDashboardTasks(tasks) {
  return [...tasks].sort((a, b) => {
    // 1. Recurring first
    if (a.is_recurring !== b.is_recurring) return a.is_recurring ? -1 : 1

    // 2. Least duration first
    const durDiff = (a.duration_minutes || 0) - (b.duration_minutes || 0)
    if (durDiff !== 0) return durDiff

    // 3. Closest due time / date first (overdue = highest priority)
    const aDate = a.due_date ? parseISO(a.due_date) : null
    const bDate = b.due_date ? parseISO(b.due_date) : null
    if (aDate && bDate) {
      if (aDate < bDate) return -1
      if (aDate > bDate) return 1
    } else if (aDate) return -1
    else if (bDate) return 1

    return 0
  })
}

export function formatTime(time) {
  if (!time) return null
  const [h, m] = time.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 || 12
  return `${hour}:${m.toString().padStart(2, '0')} ${period}`
}

export function formatDuration(minutes) {
  if (!minutes) return null
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function ordinal(n) {
  const s = ['th','st','nd','rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

export function getRecurrenceLabel(recurrence) {
  if (!recurrence) return 'Recurring'
  switch (recurrence.frequency) {
    case 'daily': return 'Daily'
    case 'weekly': return `Weekly · ${(recurrence.days || []).map(d => DAYS[d]).join(', ')}`
    case 'monthly': return `Monthly · ${ordinal(recurrence.day)}`
    case 'yearly': return `Yearly · ${MONTHS[(recurrence.month || 1) - 1]} ${recurrence.day}`
    default: return 'Recurring'
  }
}
