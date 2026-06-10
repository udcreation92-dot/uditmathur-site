import { useEffect, useRef } from 'react'
import { isDashboardVisible, isCurrentlyActive, isOverdueNow } from '../utils/taskUtils'
import { formatTime } from '../utils/taskUtils'

// Store notified task keys in localStorage keyed by today's date
// so notifications reset each day
function todayKey() {
  return `notified_${new Date().toDateString()}`
}
function getNotified() {
  try { return new Set(JSON.parse(localStorage.getItem(todayKey()) || '[]')) }
  catch { return new Set() }
}
function saveNotified(set) {
  localStorage.setItem(todayKey(), JSON.stringify([...set]))
  // Clean up yesterday's key
  const yesterday = new Date(Date.now() - 86400000).toDateString()
  localStorage.removeItem(`notified_${yesterday}`)
}

function sendNotification(title, body, tag) {
  if (Notification.permission !== 'granted') return
  try {
    new Notification(title, {
      body,
      tag,          // prevents duplicate popups for same task
      renotify: false,
      icon: '/icon-192.png',
    })
  } catch (e) {
    // Some browsers restrict Notification outside service worker
    console.warn('Notification error:', e)
  }
}

export function useNotifications(tasks) {
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  // Request permission once on mount
  useEffect(() => {
    if (!('Notification' in window)) return
    if (Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [])

  // Check every 30 seconds
  useEffect(() => {
    if (!('Notification' in window)) return

    function check() {
      if (Notification.permission !== 'granted') return
      const tasks = tasksRef.current
      if (!tasks.length) return

      const notified = getNotified()
      let changed = false

      const visible = tasks.filter(t => isDashboardVisible(t, tasks))

      visible.forEach(task => {
        const active  = isCurrentlyActive(task) && !isOverdueNow(task)
        const overdue = isOverdueNow(task)

        const currentKey = `${task.id}:current`
        const overdueKey = `${task.id}:overdue`

        if (active && !notified.has(currentKey)) {
          notified.add(currentKey)
          changed = true
          const timeInfo = task.start_time && task.end_time
            ? `${formatTime(task.start_time)} – ${formatTime(task.end_time)}`
            : 'Now'
          sendNotification(
            `⏰ ${task.title}`,
            `Task window started · ${timeInfo}`,
            currentKey
          )
        }

        if (overdue && !notified.has(overdueKey)) {
          notified.add(overdueKey)
          changed = true
          sendNotification(
            `⚠️ Overdue: ${task.title}`,
            task.end_time
              ? `Time window ended at ${formatTime(task.end_time)}`
              : 'This task is now overdue',
            overdueKey
          )
        }
      })

      if (changed) saveNotified(notified)
    }

    check() // run immediately on load
    const interval = setInterval(check, 30_000) // then every 30s
    return () => clearInterval(interval)
  }, []) // tasks read via ref — no re-subscribe needed
}
