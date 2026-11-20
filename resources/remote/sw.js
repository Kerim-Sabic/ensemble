// The phone page's service worker: it only shows notifications Ensemble sends (and opens the page
// when one is tapped). No caching, no fetch handling: the page always comes fresh from its server.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = {}
  }
  const title = typeof d.title === 'string' ? d.title.slice(0, 60) : 'Ensemble'
  const body = typeof d.body === 'string' ? d.body.slice(0, 140) : ''
  e.waitUntil(self.registration.showNotification(title, { body, tag: typeof d.tag === 'string' ? d.tag : 'ensemble', renotify: true, icon: '/icon.png', badge: '/icon.png', data: { url: '/' } }))
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus()
      return self.clients.openWindow('/')
    }),
  )
})
