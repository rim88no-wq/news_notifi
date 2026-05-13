require('dotenv').config();

const express = require('express');
const webpush = require('web-push');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./firebase');
const {
  collection, doc, getDoc, getDocs, addDoc, setDoc,
  deleteDoc, updateDoc, query, where, orderBy, limit,
} = require('firebase/firestore');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';

// ─── Data directory setup (VAPID keys only — data now stored in Firestore) ────
const DATA_DIR = path.join(__dirname, 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid-keys.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── VAPID keys — env vars take priority (required for deployment) ────────────
// VAPID keys must stay the same across restarts/deploys or all existing push
// subscriptions become invalid. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY in
// your deployment environment. The file fallback is for local dev only.
let vapidKeys;
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidKeys = {
    publicKey:  process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  };
} else if (fs.existsSync(VAPID_FILE)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  console.warn('⚠️  VAPID keys loaded from file. Set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars before deploying.');
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapidKeys, null, 2));
  console.log('✅ Generated new VAPID keys (saved to data/vapid-keys.json)');
  console.warn('⚠️  Add these to your deployment env vars so push subscriptions survive restarts:');
  console.warn(`   VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
  console.warn(`   VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
}

webpush.setVapidDetails(
  `mailto:${ADMIN_EMAIL}`,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);


// ─── CORS — allow GitHub Pages and custom domain to call the API ──────────────
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // If no CORS_ORIGIN is configured, allow all origins (open)
  // If configured, only allow listed origins
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Admin auth middleware — checks Authorization: Bearer <password>
const adminAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ─── Public routes ────────────────────────────────────────────────────────────

// Serve the VAPID public key so the client can subscribe
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// Subscribe
app.post('/api/subscribe', async (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }
  try {
    const q        = query(collection(db, 'subscriptions'), where('endpoint', '==', subscription.endpoint));
    const existing = await getDocs(q);
    if (existing.empty) {
      await addDoc(collection(db, 'subscriptions'), { ...subscription, subscribedAt: new Date().toISOString() });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Unsubscribe
app.post('/api/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Endpoint required' });
  try {
    const q        = query(collection(db, 'subscriptions'), where('endpoint', '==', endpoint));
    const snapshot = await getDocs(q);
    await Promise.all(snapshot.docs.map((d) => deleteDoc(d.ref)));
    res.json({ success: true });
  } catch (err) {
    console.error('Unsubscribe error:', err);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// ─── Public notification feed (no auth) — for in-page display & polling ───────
// Returns last 20 notifications, newest first
app.get('/api/feed', async (req, res) => {
  try {
    const q        = query(collection(db, 'notifications'), orderBy('createdAt', 'desc'), limit(20));
    const snapshot = await getDocs(q);
    const items    = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(items);
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ error: 'Failed to load feed' });
  }
});

// ─── SSE — real-time stream for open tabs ─────────────────────────────────────
const sseClients = new Set();

app.get('/api/notifications/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('data: {"type":"connected"}\n\n');

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  sseClients.add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

function broadcastToSSE(notification) {
  const payload = `data: ${JSON.stringify({ type: 'notification', notification })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// ─── Admin routes ─────────────────────────────────────────────────────────────

// Login — returns the token (password itself acts as bearer token for simplicity)
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Subscriber count
app.get('/api/admin/subscribers', adminAuth, async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, 'subscriptions'));
    res.json({ count: snapshot.size });
  } catch (err) {
    console.error('Subscribers error:', err);
    res.status(500).json({ error: 'Failed to get subscriber count' });
  }
});

// List all sent notifications
app.get('/api/notifications', adminAuth, async (req, res) => {
  try {
    const q        = query(collection(db, 'notifications'), orderBy('createdAt', 'desc'));
    const snapshot = await getDocs(q);
    const items    = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(items);
  } catch (err) {
    console.error('List notifications error:', err);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// Create and send a notification
app.post('/api/notifications', adminAuth, async (req, res) => {
  const { title, body, url } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required' });
  }

  const notification = {
    id: uuidv4(),
    title: title.trim(),
    body: body.trim(),
    url: url || '/',
    createdAt: new Date().toISOString(),
    sentCount: 0,
    failedCount: 0,
  };

  try {
    const subsSnapshot = await getDocs(collection(db, 'subscriptions'));
    const subs = subsSnapshot.docs.map((d) => ({ _id: d.id, ...d.data() }));

    if (subs.length === 0) {
      await setDoc(doc(db, 'notifications', notification.id), notification);
      broadcastToSSE(notification);
      return res.json({ success: true, notification, message: 'Saved — no subscribers yet' });
    }

    const payload = JSON.stringify({
      title: notification.title,
      body:  notification.body,
      url:   notification.url,
      id:    notification.id,
    });

    const results = await Promise.allSettled(
      subs.map(({ _id, ...sub }) => webpush.sendNotification(sub, payload))
    );

    const invalidDocIds = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        notification.sentCount++;
      } else {
        notification.failedCount++;
        const code = result.reason?.statusCode;
        console.error(`[Push] send failed for sub ${subs[i]._id}: HTTP ${code} — ${result.reason?.body || result.reason?.message}`);
        // 410 Gone / 404 = subscription expired, clean it up
        if (code === 410 || code === 404) {
          invalidDocIds.push(subs[i]._id);
        }
      }
    });

    if (invalidDocIds.length > 0) {
      await Promise.all(invalidDocIds.map((id) => deleteDoc(doc(db, 'subscriptions', id))));
    }

    await setDoc(doc(db, 'notifications', notification.id), notification);
    broadcastToSSE(notification);

    res.json({ success: true, notification });
  } catch (err) {
    console.error('Send notification error:', err);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Delete a notification from history
app.delete('/api/notifications/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const notifRef = doc(db, 'notifications', id);
    const snap     = await getDoc(notifRef);
    if (!snap.exists()) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    await deleteDoc(notifRef);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete notification error:', err);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});
// ─── Articles (News) ──────────────────────────────────────────────────────────────

// Public: list all articles (newest first)
app.get('/api/articles', async (req, res) => {
  try {
    const category = (req.query.category || '').trim().toLowerCase();
    const constraints = [orderBy('createdAt', 'desc')];
    if (category) constraints.unshift(where('category', '==', category));
    const q        = query(collection(db, 'articles'), ...constraints);
    const snapshot = await getDocs(q);
    const articles = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json(articles);
  } catch (err) {
    console.error('Articles list error:', err);
    res.status(500).json({ error: 'Failed to get articles' });
  }
});

// Admin: create article
app.post('/api/articles', adminAuth, async (req, res) => {
  const { title, excerpt, body, category, author, imageEmoji, imageColor, url, featured } = req.body;
  if (!title || !excerpt || !category) {
    return res.status(400).json({ error: 'title, excerpt and category are required' });
  }
  const article = {
    id: uuidv4(),
    title: title.trim(),
    excerpt: excerpt.trim(),
    body: (body || '').trim(),
    category: category.trim(),
    author: (author || 'Staff Reporter').trim(),
    imageEmoji: imageEmoji || '📰',
    imageColor: imageColor || 'linear-gradient(135deg,#1e3a5f,#2d6a9f)',
    url: (url || '/').trim(),
    featured: !!featured,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    await setDoc(doc(db, 'articles', article.id), article);
    res.status(201).json({ success: true, article });
  } catch (err) {
    console.error('Create article error:', err);
    res.status(500).json({ error: 'Failed to create article' });
  }
});

// Admin: update article
app.put('/api/articles/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const articleRef = doc(db, 'articles', id);
    const snap       = await getDoc(articleRef);
    if (!snap.exists()) return res.status(404).json({ error: 'Article not found' });

    const { title, excerpt, body, category, author, imageEmoji, imageColor, url, featured } = req.body;
    const updates = { updatedAt: new Date().toISOString() };
    if (title      !== undefined) updates.title      = title.trim();
    if (excerpt    !== undefined) updates.excerpt    = excerpt.trim();
    if (body       !== undefined) updates.body       = body.trim();
    if (category   !== undefined) updates.category   = category.trim();
    if (author     !== undefined) updates.author     = author.trim();
    if (imageEmoji !== undefined) updates.imageEmoji = imageEmoji;
    if (imageColor !== undefined) updates.imageColor = imageColor;
    if (url        !== undefined) updates.url        = url.trim();
    if (featured   !== undefined) updates.featured   = !!featured;

    await updateDoc(articleRef, updates);
    res.json({ success: true, article: { ...snap.data(), ...updates } });
  } catch (err) {
    console.error('Update article error:', err);
    res.status(500).json({ error: 'Failed to update article' });
  }
});

// Admin: delete article
app.delete('/api/articles/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const articleRef = doc(db, 'articles', id);
    const snap       = await getDoc(articleRef);
    if (!snap.exists()) return res.status(404).json({ error: 'Article not found' });
    await deleteDoc(articleRef);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete article error:', err);
    res.status(500).json({ error: 'Failed to delete article' });
  }
});
// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  NewsFlash server running at http://localhost:${PORT}`);
  console.log(`🔑  Admin panel : http://localhost:${PORT}/admin.html`);
  console.log(`🔒  Admin password: ${ADMIN_PASSWORD}\n`);
});
