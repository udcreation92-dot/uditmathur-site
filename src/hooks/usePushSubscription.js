import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const VAPID_PUBLIC_KEY = 'BOWxOCHHd61lEZsWg6KQOfdzijnfHko8TUQBwgxE3e1yHyz3mpeBTrcDTk5BzA7xk4OcXzS9imcGPjWQYbLprE8'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export function usePushSubscription() {
  const [status, setStatus] = useState('idle') // idle | requesting | subscribed | denied | unsupported

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus('unsupported')
      return
    }
    // Register service worker
    navigator.serviceWorker.register('/sw.js').catch(console.error)
    // Check existing permission
    if (Notification.permission === 'granted') subscribe()
    else if (Notification.permission === 'denied') setStatus('denied')
  }, [])

  async function subscribe() {
    try {
      setStatus('requesting')
      const reg = await navigator.serviceWorker.ready
      let sub = await reg.pushManager.getSubscription()
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        })
      }
      // Save subscription to Supabase
      const subJson = sub.toJSON()
      await supabase.from('push_subscriptions').upsert({
        endpoint: subJson.endpoint,
        p256dh: subJson.keys.p256dh,
        auth: subJson.keys.auth,
        user_agent: navigator.userAgent.substring(0, 200),
        updated_at: new Date().toISOString()
      }, { onConflict: 'endpoint' })
      setStatus('subscribed')
    } catch (err) {
      console.error('Push subscription error:', err)
      setStatus('denied')
    }
  }

  async function requestPermission() {
    const permission = await Notification.requestPermission()
    if (permission === 'granted') await subscribe()
    else setStatus('denied')
  }

  return { status, requestPermission }
}
