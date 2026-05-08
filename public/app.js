/* ── Push Notification + In-Page Toast client logic ─────────────────────────
   Handles:
   • Service Worker registration
   • Permission popup / subscribe / unsubscribe
   • SSE stream for real-time in-page notification toasts
   • SW→page postMessage bridge (OS notification fires even when tab focused)
   • Notification bell badge + drawer
   ─────────────────────────────────────────────────────────────────────────── */

'use strict';

let swReg        = null;
let subscribed   = false;
let sseSource    = null;
let unreadCount  = 0;
let sseRetryDelay = 5000;
const SEEN_KEY   = 'nf-last-seen-id';
const seenNotifIds = new Set(); // deduplicates SW + SSE delivering the same push

// ─── Feature detection ────────────────────────────────────────────────────────
const pushSupported =
  'serviceWorker' in navigator &&
  'PushManager'   in window     &&
  'Notification'  in window;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function getVapidPublicKey() {
  const res  = await fetch('/api/vapid-public-key');
  const data = await res.json();
  return data.publicKey;
}

// ─── HTML escape ──────────────────────────────────────────────────────────────
function esc(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
  return d.innerHTML;
}

function relativeTime(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

// ─── In-page toast ────────────────────────────────────────────────────────────
function showToast(title, body, url) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'notif-toast';
  toast.innerHTML = `
    <div class="toast-bell">🔔</div>
    <div class="toast-content">
      <div class="toast-title">${esc(title)}</div>
      <div class="toast-body">${esc(body)}</div>
    </div>
    <button class="toast-close" aria-label="Close notification">✕</button>
  `;

  toast.addEventListener('click', (e) => {
    if (!e.target.classList.contains('toast-close')) {
      window.location.href = url || '/';
    }
  });
  toast.querySelector('.toast-close').addEventListener('click', (e) => {
    e.stopPropagation();
    dismissToast(toast);
  });

  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => dismissToast(toast), 7000);
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.remove('toast-visible');
  toast.classList.add('toast-hiding');
  setTimeout(() => toast.remove(), 350);
}

// ─── Bell badge ───────────────────────────────────────────────────────────────
function incrementBadge() {
  unreadCount++;
  const badge = document.getElementById('bell-badge');
  if (badge) {
    badge.textContent    = unreadCount > 9 ? '9+' : unreadCount;
    badge.style.display  = '';
  }
}
function clearBadge() {
  unreadCount = 0;
  const badge = document.getElementById('bell-badge');
  if (badge) badge.style.display = 'none';
}

// ─── Notification drawer ──────────────────────────────────────────────────────
async function openDrawer() {
  clearBadge();
  const drawer = document.getElementById('notif-drawer');
  const list   = document.getElementById('drawer-list');
  if (!drawer || !list) return;

  if (drawer.classList.contains('drawer-open')) {
    drawer.classList.remove('drawer-open');
    return;
  }

  drawer.classList.add('drawer-open');
  list.innerHTML = '<p class="drawer-state">Loading…</p>';

  try {
    const res    = await fetch('/api/feed');
    const notifs = await res.json();

    if (notifs.length === 0) {
      list.innerHTML = '<p class="drawer-state">No notifications yet.</p>';
      return;
    }

    list.innerHTML = '';
    notifs.forEach((n) => {
      const item = document.createElement('a');
      item.className = 'drawer-item';
      item.href = n.url || '/';
      item.innerHTML = `
        <div class="drawer-item-title">${esc(n.title)}</div>
        <div class="drawer-item-body">${esc(n.body)}</div>
        <div class="drawer-item-time">${relativeTime(n.createdAt)}</div>
      `;
      list.appendChild(item);
    });
  } catch {
    list.innerHTML = '<p class="drawer-state">Failed to load notifications.</p>';
  }
}

// ─── Handle incoming notification ────────────────────────────────────────────
// A single push can arrive via both SSE (open tab) and SW postMessage (focused
// tab). Deduplicate by ID so the user never sees the same toast/badge twice.
function onNewNotification(data) {
  if (!data || !data.title) return;
  if (data.id) {
    if (seenNotifIds.has(data.id)) return;
    seenNotifIds.add(data.id);
    setTimeout(() => seenNotifIds.delete(data.id), 30000);
  }
  showToast(data.title, data.body || '', data.url || '/');
  incrementBadge();
  if (data.id) localStorage.setItem(SEEN_KEY, data.id);
}

// ─── SSE — real-time in-page updates from server ─────────────────────────────
function connectSSE() {
  if (sseSource || !window.EventSource) return;
  sseSource = new EventSource('/api/notifications/stream');

  sseSource.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'notification' && msg.notification) {
        onNewNotification(msg.notification);
      }
    } catch { /* ignore */ }
  });

  sseSource.addEventListener('open', () => {
    sseRetryDelay = 5000; // reset backoff on successful connection
  });

  sseSource.onerror = () => {
    sseSource.close();
    sseSource = null;
    setTimeout(connectSSE, sseRetryDelay);
    sseRetryDelay = Math.min(sseRetryDelay * 2, 60000); // exponential backoff, cap at 60s
  };
}

// ─── SW→Page message bridge ──────────────────────────────────────────────────
// Chrome suppresses OS notifications when the tab is in the foreground.
// The service worker posts a message instead, so we show an in-page toast.
function setupSWMessageListener() {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'push-notification' && msg.data) {
      onNewNotification(msg.data);
    }
  });
}

// ─── UI helpers ──────────────────────────────────────────────────────────────
function setUI(state) {
  const toggleBtn  = document.getElementById('notif-toggle-btn');
  const label      = document.getElementById('notif-label');
  const invite     = document.getElementById('notif-invite');

  if (!toggleBtn) return;

  switch (state) {
    case 'subscribed':
      toggleBtn.textContent  = '🔔 Subscribed';
      toggleBtn.className    = 'notif-btn unsubscribe';
      toggleBtn.disabled     = false;
      if (label)  label.textContent = 'Notifications on';
      if (invite) invite.style.display = 'none';
      break;

    case 'unsubscribed':
      toggleBtn.textContent  = 'Enable Alerts';
      toggleBtn.className    = 'notif-btn subscribe';
      toggleBtn.disabled     = false;
      if (label)  label.textContent = '';
      if (invite) invite.style.display = '';
      break;

    case 'blocked':
      toggleBtn.textContent  = '🔕 Blocked';
      toggleBtn.className    = 'notif-btn blocked';
      toggleBtn.disabled     = true;
      if (label)  label.textContent = '';
      if (invite) invite.style.display = 'none';
      break;

    case 'loading':
      toggleBtn.textContent  = '…';
      toggleBtn.className    = 'notif-btn';
      toggleBtn.disabled     = true;
      break;
  }
}

// ─── Popup ───────────────────────────────────────────────────────────────────
function showPopup() {
  const popup = document.getElementById('notif-popup');
  if (popup) popup.classList.add('visible');
}

function hidePopup() {
  const popup = document.getElementById('notif-popup');
  if (popup) popup.classList.remove('visible');
}

// ─── Subscribe ───────────────────────────────────────────────────────────────
async function subscribe() {
  let browserSub = null;
  try {
    setUI('loading');
    const publicKey = await getVapidPublicKey();
    browserSub = await swReg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const res = await fetch('/api/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(browserSub),
    });

    if (!res.ok) {
      // Server failed to save — roll back the browser-side subscription so the
      // user isn't left in a state where the browser thinks they're subscribed
      // but the server has no record of them (they'd never receive notifications).
      await browserSub.unsubscribe();
      throw new Error('Server failed to save subscription');
    }

    subscribed = true;
    setUI('subscribed');
  } catch (err) {
    console.error('[Push] subscribe failed:', err);
    setUI(Notification.permission === 'denied' ? 'blocked' : 'unsubscribed');
  }
}

// ─── Unsubscribe ─────────────────────────────────────────────────────────────
async function unsubscribe() {
  try {
    const sub = await swReg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/unsubscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
    subscribed = false;
    setUI('unsubscribed');
  } catch (err) {
    console.error('[Push] unsubscribe failed:', err);
  }
}

// ─── Request permission then subscribe ───────────────────────────────────────
async function requestAndSubscribe() {
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    await subscribe();
  } else {
    setUI(perm === 'denied' ? 'blocked' : 'unsubscribed');
  }
}

// ─── Toggle (header button) ───────────────────────────────────────────────────
async function onToggle() {
  if (!swReg) return;
  if (subscribed) {
    await unsubscribe();
  } else {
    await requestAndSubscribe();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // SSE works for everyone — no permission needed
  connectSSE();

  if (!pushSupported) {
    const btn = document.getElementById('notif-toggle-btn');
    if (btn) { btn.textContent = 'Not supported'; btn.disabled = true; }
    return;
  }

  try {
    swReg = await navigator.serviceWorker.register('/sw.js');
    setupSWMessageListener(); // catch push events when tab is in foreground

    const permission = Notification.permission;

    if (permission === 'denied') {
      setUI('blocked');
      return;
    }

    const existing = await swReg.pushManager.getSubscription();
    if (existing) {
      subscribed = true;
      setUI('subscribed');
    } else {
      setUI('unsubscribed');
      // Show popup only once if browser hasn't been asked yet
      if (permission === 'default' && !localStorage.getItem('popup-dismissed')) {
        setTimeout(showPopup, 2500);
      }
    }
  } catch (err) {
    console.error('[SW] registration failed:', err);
    const btn = document.getElementById('notif-toggle-btn');
    if (btn) { btn.textContent = 'Unavailable'; btn.disabled = true; }
  }
}

// ─── Wire up events after DOM ready ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();

  // Popup — Allow
  document.getElementById('popup-allow-btn')?.addEventListener('click', async () => {
    hidePopup();
    await requestAndSubscribe();
  });

  // Popup — Dismiss
  document.getElementById('popup-dismiss-btn')?.addEventListener('click', () => {
    hidePopup();
    localStorage.setItem('popup-dismissed', 'true');
  });

  // Header toggle button
  document.getElementById('notif-toggle-btn')?.addEventListener('click', onToggle);

  // Banner subscribe button
  document.getElementById('banner-subscribe-btn')?.addEventListener('click', async () => {
    await requestAndSubscribe();
  });

  // Bell icon → notification drawer
  document.getElementById('bell-btn')?.addEventListener('click', openDrawer);

  // Drawer close button
  document.getElementById('drawer-close-btn')?.addEventListener('click', () => {
    document.getElementById('notif-drawer')?.classList.remove('drawer-open');
  });

  // Close drawer when clicking outside
  document.addEventListener('click', (e) => {
    const drawer = document.getElementById('notif-drawer');
    if (!drawer?.classList.contains('drawer-open')) return;
    if (!drawer.contains(e.target) && e.target.id !== 'bell-btn') {
      drawer.classList.remove('drawer-open');
    }
  });

  // Highlight active nav link based on ?category=
  const activeCategory = new URLSearchParams(window.location.search).get('category') || '';
  document.querySelectorAll('.main-nav a').forEach((link) => {
    const linkCat = link.dataset.category || '';
    link.classList.toggle('nav-active', linkCat === activeCategory);
  });

  // Load dynamic news articles
  loadArticles(activeCategory);
});

// ═══════════════════════════════════════════════════════════════════════════════
// DYNAMIC NEWS ARTICLES
// ═══════════════════════════════════════════════════════════════════════════════

const CATEGORY_COLORS = {
  politics: 'linear-gradient(135deg,#92400e,#f59e0b)',
  tech:     'linear-gradient(135deg,#1e40af,#3b82f6)',
  sports:   'linear-gradient(135deg,#065f46,#10b981)',
  economy:  'linear-gradient(135deg,#9d174d,#ec4899)',
  science:  'linear-gradient(135deg,#5b21b6,#8b5cf6)',
  health:   'linear-gradient(135deg,#14532d,#22c55e)',
  world:    'linear-gradient(135deg,#0c4a6e,#0ea5e9)',
};

async function loadArticles(category = '') {
  try {
    const url      = category ? `/api/articles?category=${encodeURIComponent(category)}` : '/api/articles';
    const res      = await fetch(url);
    const articles = await res.json();

    const featuredSec    = document.getElementById('featured-section');
    const topStoriesList = document.getElementById('top-stories-list');
    const latestList     = document.getElementById('latest-list');
    const noArticles     = document.getElementById('no-articles');
    const newsGrid       = document.getElementById('news-grid');

    // Update section headings when filtering by category
    if (category) {
      const label = category.charAt(0).toUpperCase() + category.slice(1);
      const topHead = document.querySelector('#news-grid section:first-child .col-heading');
      const latHead = document.querySelector('#news-grid section:last-child .col-heading');
      if (topHead) topHead.textContent = `${label} Stories`;
      if (latHead) latHead.textContent = `More ${label}`;
    }

    if (!articles.length) {
      if (featuredSec) featuredSec.style.display = 'none';
      if (newsGrid)    newsGrid.style.display    = 'none';
      if (noArticles)  noArticles.style.display  = '';
      return;
    }

    if (noArticles) noArticles.style.display = 'none';

    // ── Featured article ──────────────────────────────────────────────────────
    const featured = articles.find((a) => a.featured) || articles[0];
    if (featuredSec) {
      featuredSec.innerHTML = buildFeaturedCard(featured);
    }

    // ── Top Stories (non-featured articles, up to 4) ──────────────────────────
    const rest       = articles.filter((a) => a.id !== featured.id);
    const topStories = rest.slice(0, 4);
    const latest     = rest.slice(4, 10);

    if (topStoriesList) {
      topStoriesList.innerHTML = topStories.length
        ? topStories.map(buildTopCard).join('')
        : '<p class="empty-col">No more stories yet.</p>';
    }

    // ── Latest Updates (row cards) ────────────────────────────────────────────
    if (latestList) {
      latestList.innerHTML = latest.length
        ? latest.map(buildLatestCard).join('')
        : '<p class="empty-col">More stories coming soon.</p>';
    }
  } catch (err) {
    console.error('[Articles] failed to load:', err);
  }
}

function tagClass(category) {
  return `tag tag-${(category || 'world').toLowerCase()}`;
}

function categoryColor(article) {
  return article.imageColor || CATEGORY_COLORS[(article.category || '').toLowerCase()] || CATEGORY_COLORS.world;
}

function buildFeaturedCard(a) {
  return `
    <div class="featured-card">
      <div class="featured-img" style="background:${categoryColor(a)}" aria-hidden="true">
        ${esc(a.imageEmoji || '📰')}
      </div>
      <div class="featured-body">
        <span class="${tagClass(a.category)}">${esc(a.category)}</span>
        <h1 class="featured-title">${esc(a.title)}</h1>
        <p class="featured-desc">${esc(a.excerpt)}</p>
        <div class="meta">
          <span>By ${esc(a.author)}</span>
          <span>${formatDate(a.createdAt)}</span>
          <a href="${esc(a.url || '/')}" class="read-more">Read full story →</a>
        </div>
      </div>
    </div>`;
}

function buildTopCard(a) {
  return `
    <article class="news-card" onclick="location.href='${esc(a.url || '/')}'">
      <div class="card-img" style="background:${categoryColor(a)}" aria-hidden="true">
        <span style="font-size:48px;opacity:.65">${esc(a.imageEmoji || '📰')}</span>
      </div>
      <div class="card-body">
        <span class="${tagClass(a.category)}">${esc(a.category)}</span>
        <h3>${esc(a.title)}</h3>
        <p>${esc(a.excerpt)}</p>
        <div class="meta">
          <span>${esc(a.author)}</span>
          <span>${relativeTime(a.createdAt)}</span>
        </div>
      </div>
    </article>`;
}

function buildLatestCard(a) {
  return `
    <article class="news-card news-card--row" onclick="location.href='${esc(a.url || '/')}'">
      <div class="card-img-sm" style="background:${categoryColor(a)}" aria-hidden="true">
        <span style="font-size:26px;opacity:.65">${esc(a.imageEmoji || '📰')}</span>
      </div>
      <div class="card-body">
        <span class="${tagClass(a.category)}">${esc(a.category)}</span>
        <h3>${esc(a.title)}</h3>
        <div class="meta"><span>${relativeTime(a.createdAt)}</span></div>
      </div>
    </article>`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
}

