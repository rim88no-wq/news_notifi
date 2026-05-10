/* ── Admin Panel JavaScript ──────────────────────────────────────────────────
   Handles: login, send notifications, history list, delete, stats
   ─────────────────────────────────────────────────────────────────────────── */

'use strict';

const API_BASE = window.API_BASE || '';

let token = null; // Bearer token (= admin password) stored in sessionStorage

// ─── Auth headers ─────────────────────────────────────────────────────────────
const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

// ─── Show / hide screens ─────────────────────────────────────────────────────
function showLogin()  {
  document.getElementById('login-screen').style.display = '';
  document.getElementById('admin-panel').style.display  = 'none';
}
function showPanel()  {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('admin-panel').style.display  = '';
  loadSubscriberCount();
  loadHistory();
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function handleLogin(password) {
  const errEl = document.getElementById('login-error');
  const btn   = document.getElementById('login-btn');

  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res  = await fetch(API_BASE + '/api/admin/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password }),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      token = data.token;
      sessionStorage.setItem('admin-token', token);
      showPanel();
    } else {
      errEl.textContent    = data.error || 'Invalid password.';
      errEl.style.display  = '';
    }
  } catch {
    errEl.textContent   = 'Could not connect to server.';
    errEl.style.display = '';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Sign In';
  }
}

// ─── Load subscriber count ────────────────────────────────────────────────────
async function loadSubscriberCount() {
  try {
    const res  = await fetch(API_BASE + '/api/admin/subscribers', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('subscriber-count').textContent = data.count;
    document.getElementById('stat-subs')?.textContent != null &&
      (document.getElementById('stat-subs').textContent = data.count);
  } catch { /* silent */ }
}

// ─── Send notification ────────────────────────────────────────────────────────
async function handleSend(e) {
  e.preventDefault();

  const title    = document.getElementById('notif-title').value.trim();
  const body     = document.getElementById('notif-body').value.trim();
  const url      = document.getElementById('notif-url').value.trim() || '/';
  const successEl = document.getElementById('send-success');
  const errorEl   = document.getElementById('send-error');
  const sendBtn   = document.getElementById('send-btn');

  successEl.style.display = 'none';
  errorEl.style.display   = 'none';
  sendBtn.disabled         = true;
  sendBtn.innerHTML        = '⏳ Sending…';

  try {
    const res  = await fetch(API_BASE + '/api/notifications', {
      method:  'POST',
      headers: authHeaders(),
      body:    JSON.stringify({ title, body, url }),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      const n = data.notification;
      successEl.textContent   =
        `✅ Sent to ${n.sentCount} subscriber(s).` +
        (n.failedCount ? ` (${n.failedCount} failed)` : '') +
        (n.message ? ` — ${n.message}` : '');
      successEl.style.display = '';
      clearForm();
      loadHistory();
      loadSubscriberCount();
    } else {
      errorEl.textContent   = `❌ ${data.error || 'Failed to send.'}`;
      errorEl.style.display = '';
    }
  } catch {
    errorEl.textContent   = '❌ Connection error. Please try again.';
    errorEl.style.display = '';
  } finally {
    sendBtn.disabled   = false;
    sendBtn.innerHTML  = '<span aria-hidden="true">📤</span> Send to All Subscribers';
  }
}

// ─── Load notification history ────────────────────────────────────────────────
async function loadHistory() {
  const loadingEl = document.getElementById('history-loading');
  const emptyEl   = document.getElementById('history-empty');
  const listEl    = document.getElementById('history-list');
  if (!listEl) return;

  loadingEl.style.display = '';
  emptyEl.style.display   = 'none';
  listEl.innerHTML        = '';

  try {
    const res  = await fetch(API_BASE + '/api/notifications', { headers: authHeaders() });
    if (!res.ok) {
      loadingEl.textContent = 'Failed to load history.';
      return;
    }
    const notifications = await res.json(); // already newest-first from server

    loadingEl.style.display = 'none';

    // Update stats page numbers
    const statNotifs = document.getElementById('stat-notifs');
    const statDel    = document.getElementById('stat-delivered');
    const statLatest = document.getElementById('stat-latest');
    if (statNotifs) statNotifs.textContent = notifications.length;
    if (statDel) {
      const total = notifications.reduce((s, n) => s + (n.sentCount || 0), 0);
      statDel.textContent = total;
    }
    if (statLatest && notifications.length > 0) {
      statLatest.textContent = relativeTime(notifications[0].createdAt);
    }

    if (notifications.length === 0) {
      emptyEl.style.display = '';
      return;
    }

    notifications.forEach((n) => listEl.appendChild(buildHistoryItem(n)));
  } catch {
    loadingEl.textContent = 'Connection error.';
  }
}

// ─── Build history row ────────────────────────────────────────────────────────
function buildHistoryItem(notif) {
  const item = document.createElement('div');
  item.className  = 'history-item';
  item.dataset.id = notif.id;

  const urlBadge = notif.url && notif.url !== '/'
    ? `<span class="badge badge-url">🔗 ${esc(notif.url)}</span>`
    : '';

  item.innerHTML = `
    <div class="history-content">
      <div class="history-title">${esc(notif.title)}</div>
      <div class="history-body">${esc(notif.body)}</div>
      <div class="history-meta">
        <span>${formatDate(notif.createdAt)}</span>
        <span class="badge badge-success">✅ ${notif.sentCount || 0} delivered</span>
        ${notif.failedCount > 0 ? `<span class="badge badge-error">❌ ${notif.failedCount} failed</span>` : ''}
        ${urlBadge}
      </div>
    </div>
    <button class="btn-delete" data-id="${notif.id}" aria-label="Delete notification">🗑 Delete</button>
  `;

  item.querySelector('.btn-delete').addEventListener('click', () =>
    deleteNotification(notif.id)
  );
  return item;
}

// ─── Delete notification ──────────────────────────────────────────────────────
async function deleteNotification(id) {
  if (!confirm('Remove this notification from history?')) return;

  try {
    const res = await fetch(`${API_BASE}/api/notifications/${encodeURIComponent(id)}`, {
      method:  'DELETE',
      headers: authHeaders(),
    });

    if (res.ok) {
      const el = document.querySelector(`.history-item[data-id="${id}"]`);
      if (el) {
        el.style.transition = 'opacity .25s, transform .25s';
        el.style.opacity    = '0';
        el.style.transform  = 'translateX(16px)';
        setTimeout(() => {
          el.remove();
          if (!document.querySelector('.history-item')) {
            document.getElementById('history-empty').style.display = '';
          }
        }, 260);
      }
      loadSubscriberCount();
    }
  } catch {
    alert('Failed to delete notification.');
  }
}

// ─── Section navigation ───────────────────────────────────────────────────────
function switchSection(name) {
  const titles = {
    send:    'Send Notification',
    history: 'Notification History',
    stats:   'Statistics',
    news:    'Manage News',
  };

  document.querySelectorAll('.nav-link').forEach((a) =>
    a.classList.toggle('active', a.dataset.section === name)
  );
  document.querySelectorAll('.admin-section').forEach((sec) =>
    (sec.style.display = sec.id === `section-${name}` ? '' : 'none')
  );
  const h = document.getElementById('section-heading');
  if (h) h.textContent = titles[name] || name;

  if (name === 'history' || name === 'stats') {
    loadHistory();
    loadSubscriberCount();
  }
  if (name === 'stats') {
    loadArticleCount();
  }
  if (name === 'news') {
    loadAdminArticles();
  }
}

// ─── Clear form ───────────────────────────────────────────────────────────────
function clearForm() {
  ['notif-title', 'notif-body'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const urlEl = document.getElementById('notif-url');
  if (urlEl) urlEl.value = '/';
  document.getElementById('title-count').textContent  = '0';
  document.getElementById('body-count').textContent   = '0';
  document.getElementById('preview-title').textContent = 'Title will appear here';
  document.getElementById('preview-body').textContent  = 'Message body will appear here…';
  ['send-success', 'send-error'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

// ─── Date / text helpers ──────────────────────────────────────────────────────
function formatDate(iso) {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function relativeTime(iso) {
  const diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

function esc(text) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(text)));
  return d.innerHTML;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEWS ARTICLE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function loadAdminArticles() {
  const loadingEl = document.getElementById('articles-loading');
  const emptyEl   = document.getElementById('articles-empty');
  const listEl    = document.getElementById('article-list');
  if (!listEl) return;

  if (loadingEl) loadingEl.style.display = '';
  if (emptyEl)   emptyEl.style.display   = 'none';
  listEl.innerHTML = '';

  try {
    const res      = await fetch(API_BASE + '/api/articles', { headers: authHeaders() });
    const articles = await res.json();

    if (loadingEl) loadingEl.style.display = 'none';

    if (!articles.length) {
      if (emptyEl) emptyEl.style.display = '';
      return;
    }

    listEl.innerHTML = articles.map(buildAdminArticleRow).join('');

    listEl.querySelectorAll('.btn-edit-article').forEach((btn) =>
      btn.addEventListener('click', () => editArticle(btn.dataset.id))
    );
    listEl.querySelectorAll('.btn-delete-article').forEach((btn) =>
      btn.addEventListener('click', () => deleteArticle(btn.dataset.id))
    );
  } catch {
    if (loadingEl) loadingEl.textContent = 'Failed to load articles.';
  }
}

function buildAdminArticleRow(a) {
  const CATEGORY_COLORS = {
    politics: 'linear-gradient(135deg,#92400e,#f59e0b)',
    tech:     'linear-gradient(135deg,#1e40af,#3b82f6)',
    sports:   'linear-gradient(135deg,#065f46,#10b981)',
    economy:  'linear-gradient(135deg,#9d174d,#ec4899)',
    science:  'linear-gradient(135deg,#5b21b6,#8b5cf6)',
    health:   'linear-gradient(135deg,#14532d,#22c55e)',
    world:    'linear-gradient(135deg,#0c4a6e,#0ea5e9)',
  };
  const bg = a.imageColor || CATEGORY_COLORS[(a.category || '').toLowerCase()] || CATEGORY_COLORS.world;
  return `
    <div class="article-row" data-id="${esc(a.id)}">
      <div class="article-row-thumb" style="background:${bg}" aria-hidden="true">
        ${esc(a.imageEmoji || '📰')}
      </div>
      <div class="article-row-meta">
        <div class="article-row-title">${esc(a.title)}</div>
        <div class="article-row-sub">
          <span class="badge badge-${esc(a.category)}">${esc(a.category)}</span>
          ${a.featured ? '<span class="badge badge-featured">⭐ Featured</span>' : ''}
          <span class="badge-muted">${esc(a.author)}</span>
          <span class="badge-muted">${relativeTime(a.createdAt)}</span>
        </div>
        <div class="article-row-excerpt">${esc(a.excerpt)}</div>
      </div>
      <div class="article-row-actions">
        <button class="btn-edit-article btn-icon" data-id="${esc(a.id)}" title="Edit article" aria-label="Edit">✏️</button>
        <button class="btn-delete-article btn-del"  data-id="${esc(a.id)}" title="Delete article" aria-label="Delete">🗑</button>
      </div>
    </div>`;
}

async function handleArticleSave(e) {
  e.preventDefault();

  const successEl = document.getElementById('article-success');
  const errorEl   = document.getElementById('article-error');
  if (successEl) successEl.style.display = 'none';
  if (errorEl)   errorEl.style.display   = 'none';

  const editId = document.getElementById('article-edit-id')?.value.trim();

  const payload = {
    title:      document.getElementById('art-title')?.value.trim(),
    excerpt:    document.getElementById('art-excerpt')?.value.trim(),
    body:       document.getElementById('art-body')?.value.trim(),
    category:   document.getElementById('art-category')?.value,
    author:     document.getElementById('art-author')?.value.trim() || 'Staff Reporter',
    imageEmoji: document.getElementById('art-emoji')?.value.trim()  || '📰',
    imageColor: document.getElementById('art-color')?.value.trim()  || '',
    url:        document.getElementById('art-url')?.value.trim()    || '/',
    featured:   document.getElementById('art-featured')?.checked    || false,
  };

  if (!payload.title || !payload.excerpt || !payload.category) {
    if (errorEl) { errorEl.textContent = 'Headline, Excerpt, and Category are required.'; errorEl.style.display = ''; }
    return;
  }

  const saveBtn = document.getElementById('article-save-btn');
  if (saveBtn) saveBtn.disabled = true;

  try {
    const method = editId ? 'PUT' : 'POST';
    const url    = editId ? `${API_BASE}/api/articles/${encodeURIComponent(editId)}` : API_BASE + '/api/articles';

    const res = await fetch(url, {
      method,
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to save article.');

    if (successEl) {
      successEl.textContent = editId ? 'Article updated successfully.' : 'Article published successfully.';
      successEl.style.display = '';
      setTimeout(() => { successEl.style.display = 'none'; }, 4000);
    }
    clearArticleForm();
    loadAdminArticles();
  } catch (err) {
    if (errorEl) { errorEl.textContent = err.message; errorEl.style.display = ''; }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function editArticle(id) {
  fetch(API_BASE + '/api/articles', { headers: authHeaders() })
    .then((r) => r.json())
    .then((articles) => {
      const a = articles.find((x) => x.id === id);
      if (!a) return;

      document.getElementById('article-edit-id').value   = a.id;
      document.getElementById('art-title').value         = a.title;
      document.getElementById('art-excerpt').value       = a.excerpt;
      document.getElementById('art-body').value          = a.body || '';
      document.getElementById('art-category').value      = a.category;
      document.getElementById('art-author').value        = a.author;
      document.getElementById('art-emoji').value         = a.imageEmoji || '📰';
      document.getElementById('art-color').value         = a.imageColor || '';
      document.getElementById('art-url').value           = a.url || '/';
      document.getElementById('art-featured').checked   = !!a.featured;

      const formTitle = document.getElementById('article-form-title');
      if (formTitle) formTitle.textContent = 'Edit Article';

      const saveBtn = document.getElementById('article-save-btn');
      if (saveBtn) saveBtn.innerHTML = '<span aria-hidden="true">💾</span> Update Article';

      // Scroll to form
      document.getElementById('article-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
    .catch(() => alert('Could not load article data.'));
}

async function deleteArticle(id) {
  if (!confirm('Delete this article? This cannot be undone.')) return;
  try {
    const res = await fetch(`${API_BASE}/api/articles/${encodeURIComponent(id)}`, {
      method:  'DELETE',
      headers: authHeaders(),
    });
    if (res.ok) {
      const row = document.querySelector(`.article-row[data-id="${id}"]`);
      if (row) {
        row.style.transition = 'opacity .25s, transform .25s';
        row.style.opacity    = '0';
        row.style.transform  = 'translateX(16px)';
        setTimeout(() => {
          row.remove();
          if (!document.querySelector('.article-row')) {
            document.getElementById('articles-empty').style.display = '';
          }
        }, 260);
      }
    } else {
      alert('Failed to delete article.');
    }
  } catch {
    alert('Failed to delete article.');
  }
}

function clearArticleForm() {
  document.getElementById('article-edit-id').value = '';
  ['art-title', 'art-excerpt', 'art-body', 'art-color'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const cat = document.getElementById('art-category');
  if (cat) cat.value = '';
  const author = document.getElementById('art-author');
  if (author) author.value = 'Staff Reporter';
  const emoji = document.getElementById('art-emoji');
  if (emoji) emoji.value = '📰';
  const url = document.getElementById('art-url');
  if (url) url.value = '/';
  const featured = document.getElementById('art-featured');
  if (featured) featured.checked = false;

  const formTitle = document.getElementById('article-form-title');
  if (formTitle) formTitle.textContent = 'Add New Article';
  const saveBtn = document.getElementById('article-save-btn');
  if (saveBtn) saveBtn.innerHTML = '<span aria-hidden="true">💾</span> Save Article';
  ['article-success', 'article-error'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

async function loadArticleCount() {
  try {
    const res = await fetch(API_BASE + '/api/articles');
    const articles = await res.json();
    const el = document.getElementById('stat-articles');
    if (el) el.textContent = articles.length;
  } catch { /* ignore */ }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Restore session
  token = sessionStorage.getItem('admin-token');
  if (token) {
    showPanel();
  }

  // Login form
  document.getElementById('login-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleLogin(document.getElementById('admin-password').value);
  });

  // Logout
  document.getElementById('logout-btn')?.addEventListener('click', () => {
    token = null;
    sessionStorage.removeItem('admin-token');
    showLogin();
  });

  // Sidebar navigation
  document.querySelectorAll('.nav-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      switchSection(a.dataset.section);
    });
  });

  // Notification form
  document.getElementById('notification-form')?.addEventListener('submit', handleSend);

  // Character counters + live preview
  document.getElementById('notif-title')?.addEventListener('input', (e) => {
    document.getElementById('title-count').textContent = e.target.value.length;
    document.getElementById('preview-title').textContent = e.target.value || 'Title will appear here';
  });
  document.getElementById('notif-body')?.addEventListener('input', (e) => {
    document.getElementById('body-count').textContent = e.target.value.length;
    document.getElementById('preview-body').textContent = e.target.value || 'Message body will appear here…';
  });

  // Clear button
  document.getElementById('clear-form-btn')?.addEventListener('click', clearForm);

  // Refresh history button
  document.getElementById('refresh-btn')?.addEventListener('click', loadHistory);

  // Article form
  document.getElementById('article-form')?.addEventListener('submit', handleArticleSave);
  document.getElementById('article-cancel-btn')?.addEventListener('click', clearArticleForm);

  // Refresh articles button
  document.getElementById('refresh-articles-btn')?.addEventListener('click', loadAdminArticles);
});
