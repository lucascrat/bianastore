const express = require('express');
const pool = require('../db/pool');
const { requireUserId, requireCustomer } = require('../middleware/user');

const router = express.Router();

// ---- Likes (any anonymous or logged-in user id can like) ----
router.post('/:id/like/toggle', requireUserId, async (req, res, next) => {
  try {
    const feedItemId = req.params.id;
    const { rows: existing } = await pool.query(
      'SELECT 1 FROM likes WHERE user_id = $1 AND feed_item_id = $2',
      [req.userId, feedItemId]
    );
    let liked;
    if (existing.length) {
      await pool.query('DELETE FROM likes WHERE user_id = $1 AND feed_item_id = $2', [req.userId, feedItemId]);
      liked = false;
    } else {
      await pool.query('INSERT INTO likes (user_id, feed_item_id) VALUES ($1,$2)', [req.userId, feedItemId]);
      liked = true;
    }
    const { rows } = await pool.query(
      `SELECT f.likes_count AS base_likes, (SELECT COUNT(*)::int FROM likes l WHERE l.feed_item_id = f.id) AS real_likes
       FROM feed_items f WHERE f.id = $1`,
      [feedItemId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Feed item not found' });
    res.json({ liked, likesCount: rows[0].base_likes + rows[0].real_likes });
  } catch (err) {
    next(err);
  }
});

// ---- Comments (require a real customer account, so name+photo are real) ----
router.get('/:id/comments', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.body, c.created_at, cu.name, cu.photo_url
       FROM comments c JOIN customers cu ON cu.user_id = c.user_id
       WHERE c.feed_item_id = $1 ORDER BY c.created_at ASC`,
      [req.params.id]
    );
    res.json(rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at, name: r.name, photoUrl: r.photo_url })));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/comments', requireUserId, requireCustomer, async (req, res, next) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Escreva algo para comentar' });
    if (body.length > 500) return res.status(400).json({ error: 'Comentário muito longo (máx 500 caracteres)' });
    const { rows } = await pool.query(
      'INSERT INTO comments (feed_item_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at',
      [req.params.id, req.userId, body.trim()]
    );
    res.status(201).json({
      id: rows[0].id,
      body: rows[0].body,
      createdAt: rows[0].created_at,
      name: req.customer.name,
      photoUrl: req.customer.photoUrl,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
