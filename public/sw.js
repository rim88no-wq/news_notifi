// Service Worker — handles push notifications in the background

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));

// ─── Receive push message ─────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'NewsFlash', body: event.data.text() };
  }

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/', id: data.id },
    vibrate: [200, 100, 200],
    requireInteraction: false,
    tag: data.id || 'newsflash',
  };

  event.waitUntil(
    Promise.all([
      // Show OS-level browser notification (works when tab is in background / closed)
      self.registration.showNotification(data.title || 'NewsFlash', options),

      // Also message every open page tab so they can show an in-page toast
      // (Chrome suppresses OS notifications when the tab is focused, so this is needed)
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
        tabs.forEach((tab) =>
          tab.postMessage({ type: 'push-notification', data })
        );
      }),
    ])
  );
});

// ─── Notification clicked ─────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  const siteOrigin = new URL(self.registration.scope).origin;

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Only reuse a tab that belongs to this site — never navigate an
        // unrelated tab that happens to be open in the browser.
        const siteClient = windowClients.find(
          (c) => new URL(c.url).origin === siteOrigin
        );
        if (siteClient) {
          siteClient.focus();
          return siteClient.navigate(targetUrl);
        }
        if (clients.openWindow) return clients.openWindow(targetUrl);
      })
  );
});
