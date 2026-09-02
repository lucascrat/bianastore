// Real Web Push delivery (VAPID). Also inserts a row into `notifications` for
// every push sent, so the in-app Notificações screen and the OS push
// notification always agree — one call covers both.
const webpush = require('web-push');
const pool = require('../db/pool');

function isConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

if (isConfigured()) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:contato@appbr.pro',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function saveSubscription(userId, subscription) {
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
  );
}

async function removeSubscription(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

// Sends a real OS push to every device the user has subscribed on. Does NOT
// touch the notifications table — call this after you've already inserted
// the in-app notification yourself (e.g. inside a transaction), so a slow/
// failing network call to the push service never holds a DB transaction open.
async function sendPush(userId, { title, body, url }) {
  if (!isConfigured()) return;
  const { rows } = await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  const payload = JSON.stringify({ title, body, url: url || '/' });
  await Promise.all(rows.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      // 404/410 means the browser unsubscribed or the subscription expired — clean it up.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await removeSubscription(sub.endpoint).catch(() => {});
      } else {
        console.error('Push send failed:', err.statusCode, err.body || err.message);
      }
    }
  }));
}

// Convenience for call sites that haven't already inserted a notification
// row themselves: inserts it, then sends the real push. Safe to call outside
// a transaction (most notification-worthy events aren't part of one).
async function notifyUser(userId, { type, icon, title, body, url }) {
  await pool.query(
    `INSERT INTO notifications (user_id, type, icon, title, description, unread) VALUES ($1,$2,$3,$4,$5,true)`,
    [userId, type, icon, title, body]
  );
  await sendPush(userId, { title, body, url });
}

module.exports = { isConfigured, saveSubscription, removeSubscription, sendPush, notifyUser };
