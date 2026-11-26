// Langırt Ligi servis çalışanı: web/iPhone bildirimlerini gösterir
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Langırt Ligi', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Langırt Ligi', {
      body: data.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'langirt',
      renotify: true,
      data: { tab: data.tab || 'match' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const tab = (event.notification.data && event.notification.data.tab) || 'match';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        c.postMessage({ type: 'open-tab', tab });
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(`./?tab=${tab}`);
    })(),
  );
});
