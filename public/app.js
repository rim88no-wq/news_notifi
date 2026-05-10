'use strict';

let swReg       = null;
let subscribed  = false;
let unreadCount = 0;
const SEEN_KEY      = 'nf-last-seen-id';
const seenNotifIds  = new Set();

const pushSupported =
  'serviceWorker' in navigator &&
  'PushManager'   in window    &&
  'Notification'  in window;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

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

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
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
    if (!e.target.classList.contains('toast-close')) window.location.href = url || '/';
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
  if (badge) { badge.textContent = unreadCount > 9 ? '9+' : unreadCount; badge.style.display = ''; }
}
function clearBadge() {
  unreadCount = 0;
  const badge = document.getElementById('bell-badge');
  if (badge) badge.style.display = 'none';
}

// ─── Notification drawer — reads Firestore directly ──────────────────────────
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
    const snapshot = await db.collection('notifications')
      .orderBy('createdAt', 'desc').limit(20).get();
    const notifs = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (notifs.length === 0) { list.innerHTML = '<p class="drawer-state">No notifications yet.</p>'; return; }
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

// ─── Handle incoming notification ─────────────────────────────────────────────
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

// ─── Real-time updates via Firestore onSnapshot (replaces SSE) ────────────────
function connectRealtime() {
  let firstLoad = true;
  const seenOnLoad = new Set();
  db.collection('notifications')
    .orderBy('createdAt', 'desc').limit(1)
    .onSnapshot((snapshot) => {
      if (firstLoad) {
        snapshot.docs.forEach((d) => seenOnLoad.add(d.id));
        firstLoad = false;
        return;
      }
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' && !seenOnLoad.has(change.doc.id)) {
          onNewNotification({ id: change.doc.id, ...change.doc.data() });
        }
      });
    });
}

// ─── SW → Page message bridge ─────────────────────────────────────────────────
function setupSWMessageListener() {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'push-notification' && msg.data) onNewNotification(msg.data);
  });
}

// ─── UI state ─────────────────────────────────────────────────────────────────
function setUI(state) {
  const toggleBtn = document.getElementById('notif-toggle-btn');
  const label     = document.getElementById('notif-label');
  const invite    = document.getElementById('notif-invite');
  if (!toggleBtn) return;
  switch (state) {
    case 'subscribed':
      toggleBtn.textContent = '🔔 Subscribed'; toggleBtn.className = 'notif-btn unsubscribe'; toggleBtn.disabled = false;
      if (label)  label.textContent    = 'Notifications on';
      if (invite) invite.style.display = 'none';
      break;
    case 'unsubscribed':
      toggleBtn.textContent = 'Enable Alerts'; toggleBtn.className = 'notif-btn subscribe'; toggleBtn.disabled = false;
      if (label)  label.textContent    = '';
      if (invite) invite.style.display = '';
      break;
    case 'blocked':
      toggleBtn.textContent = '🔕 Blocked'; toggleBtn.className = 'notif-btn blocked'; toggleBtn.disabled = true;
      if (label)  label.textContent    = '';
      if (invite) invite.style.display = 'none';
      break;
    case 'loading':
      toggleBtn.textContent = '…'; toggleBtn.className = 'notif-btn'; toggleBtn.disabled = true;
      break;
  }
}

function showPopup() { document.getElementById('notif-popup')?.classList.add('visible'); }
function hidePopup() { document.getElementById('notif-popup')?.classList.remove('visible'); }

// ─── Subscribe — writes subscription directly to Firestore ───────────────────
async function subscribe() {
  let browserSub = null;
  try {
    setUI('loading');
    browserSub = await swReg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: urlBase64ToUint8Array(window.VAPID_PUBLIC_KEY),
    });
    // Convert PushSubscription to plain object, then write to Firestore
    const subJson   = JSON.parse(JSON.stringify(browserSub));
    const existing  = await db.collection('subscriptions').where('endpoint', '==', subJson.endpoint).get();
    if (existing.empty) {
      await db.collection('subscriptions').add({ ...subJson, subscribedAt: new Date().toISOString() });
    }
    subscribed = true;
    setUI('subscribed');
  } catch (err) {
    console.error('[Push] subscribe failed:', err);
    if (browserSub) await browserSub.unsubscribe().catch(() => {});
    setUI(Notification.permission === 'denied' ? 'blocked' : 'unsubscribed');
  }
}

// ─── Unsubscribe — deletes from Firestore ────────────────────────────────────
async function unsubscribe() {
  try {
    const sub = await swReg.pushManager.getSubscription();
    if (sub) {
      const snapshot = await db.collection('subscriptions').where('endpoint', '==', sub.endpoint).get();
      await Promise.all(snapshot.docs.map((d) => d.ref.delete()));
      await sub.unsubscribe();
    }
    subscribed = false;
    setUI('unsubscribed');
  } catch (err) {
    console.error('[Push] unsubscribe failed:', err);
  }
}

async function requestAndSubscribe() {
  const perm = await Notification.requestPermission();
  if (perm === 'granted') await subscribe();
  else setUI(perm === 'denied' ? 'blocked' : 'unsubscribed');
}

async function onToggle() {
  if (!swReg) return;
  if (subscribed) await unsubscribe();
  else await requestAndSubscribe();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  connectRealtime();
  if (!pushSupported) {
    const btn = document.getElementById('notif-toggle-btn');
    if (btn) { btn.textContent = 'Not supported'; btn.disabled = true; }
    return;
  }
  try {
    swReg = await navigator.serviceWorker.register('./sw.js');
    setupSWMessageListener();
    const permission = Notification.permission;
    if (permission === 'denied') { setUI('blocked'); return; }
    const existing = await swReg.pushManager.getSubscription();
    if (existing) {
      subscribed = true;
      setUI('subscribed');
    } else {
      setUI('unsubscribed');
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

// ─── DOM ready ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  init();

  document.getElementById('popup-allow-btn')?.addEventListener('click', async () => {
    hidePopup(); await requestAndSubscribe();
  });
  document.getElementById('popup-dismiss-btn')?.addEventListener('click', () => {
    hidePopup(); localStorage.setItem('popup-dismissed', 'true');
  });
  document.getElementById('notif-toggle-btn')?.addEventListener('click', onToggle);
  document.getElementById('banner-subscribe-btn')?.addEventListener('click', async () => {
    await requestAndSubscribe();
  });
  document.getElementById('bell-btn')?.addEventListener('click', openDrawer);
  document.getElementById('drawer-close-btn')?.addEventListener('click', () => {
    document.getElementById('notif-drawer')?.classList.remove('drawer-open');
  });
  document.addEventListener('click', (e) => {
    const drawer = document.getElementById('notif-drawer');
    if (!drawer?.classList.contains('drawer-open')) return;
    if (!drawer.contains(e.target) && e.target.id !== 'bell-btn') drawer.classList.remove('drawer-open');
  });

  const activeCategory = new URLSearchParams(window.location.search).get('category') || '';
  document.querySelectorAll('.main-nav a').forEach((link) => {
    link.classList.toggle('nav-active', (link.dataset.category || '') === activeCategory);
  });
  loadArticles(activeCategory);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARTICLES — reads directly from Firestore
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
    let ref = db.collection('articles').orderBy('createdAt', 'desc');
    if (category) ref = db.collection('articles').where('category', '==', category).orderBy('createdAt', 'desc');
    const snapshot = await ref.get();
    const articles  = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));

    const featuredSec    = document.getElementById('featured-section');
    const topStoriesList = document.getElementById('top-stories-list');
    const latestList     = document.getElementById('latest-list');
    const noArticles     = document.getElementById('no-articles');
    const newsGrid       = document.getElementById('news-grid');

    if (category) {
      const label   = category.charAt(0).toUpperCase() + category.slice(1);
      const topHead = document.querySelector('#news-grid section:first-child .col-heading');
      const latHead = document.querySelector('#news-grid section:last-child .col-heading');
      if (topHead) topHead.textContent = `${label} Stories`;
      if (latHead) latHead.textContent = `More ${label}`;
    }

    if (!articles.length) {
      if (featuredSec) featuredSec.style.display = 'none';
      if (newsGrid)    newsGrid.style.display     = 'none';
      if (noArticles)  noArticles.style.display   = '';
      return;
    }

    if (noArticles) noArticles.style.display = 'none';

    const featured = articles.find((a) => a.featured) || articles[0];
    if (featuredSec) featuredSec.innerHTML = buildFeaturedCard(featured);

    const rest       = articles.filter((a) => a.id !== featured.id);
    const topStories = rest.slice(0, 4);
    const latest     = rest.slice(4, 10);

    if (topStoriesList) {
      topStoriesList.innerHTML = topStories.length
        ? topStories.map(buildTopCard).join('')
        : '<p class="empty-col">No more stories yet.</p>';
    }
    if (latestList) {
      latestList.innerHTML = latest.length
        ? latest.map(buildLatestCard).join('')
        : '<p class="empty-col">More stories coming soon.</p>';
    }
  } catch (err) {
    console.error('[Articles] failed to load:', err);
  }
}

function tagClass(category) { return `tag tag-${(category || 'world').toLowerCase()}`; }
function categoryColor(a) { return a.imageColor || CATEGORY_COLORS[(a.category || '').toLowerCase()] || CATEGORY_COLORS.world; }

function buildFeaturedCard(a) {
  return `
    <div class="featured-card">
      <div class="featured-img" style="background:${categoryColor(a)}" aria-hidden="true">${esc(a.imageEmoji || '📰')}</div>
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
        <div class="meta"><span>${esc(a.author)}</span><span>${relativeTime(a.createdAt)}</span></div>
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
