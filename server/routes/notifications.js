const express = require('express');
const pool = require('../db/pool');
const { requireUserId } = require('../middleware/user');

const router = express.Router();
router.use(requireUserId);

function relativeTime(date) {
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Agora';
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Ontem';
  return `${days} dias`;
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 OR user_id IS NULL ORDER BY created_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json(rows.map((n) => ({
      id: n.id,
      type: n.type,
      icon: n.icon,
      title: n.title,
      desc: n.description,
      time: relativeTime(n.created_at),
      unread: n.unread,
    })));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE notifications SET unread=false WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)',
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
