// Service Worker — handles background push notifications

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  const title = data.title || 'Task Reminder'
  const options = {
    body: data.body || 'You have a task due.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'task-reminder',
    renotify: true,
    data: { url: data.url || '/task/' }
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/task/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes('/task/') && 'focus' in client) return client.focus()
      }
      return clients.openWindow(url)
    })
  )
})

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
