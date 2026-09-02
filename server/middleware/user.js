const pool = require('../db/pool');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Anonymous-user identification: the frontend generates a UUID client-side
// (crypto.randomUUID()) and sends it as X-User-Id on every request. We lazily
// create the row on first sight and touch last_seen_at on every request.
// There is no password/auth for storefront users by design (see plan).
async function requireUserId(req, res, next) {
  const userId = req.header('X-User-Id');
  if (!userId || !UUID_RE.test(userId)) {
    return res.status(400).json({ error: 'Missing or invalid X-User-Id header' });
  }
  try {
    await pool.query(
      `INSERT INTO users (id) VALUES ($1)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now()`,
      [userId]
    );
    req.userId = userId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireUserId };
