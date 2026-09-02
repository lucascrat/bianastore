const express = require('express');
const pool = require('../db/pool');
const { requireUserId } = require('../middleware/user');

const router = express.Router();
router.use(requireUserId);

router.get('/', async (req, res, next) => {
  try {
    const sql = `
      SELECT p.*, c.name AS category_name,
        (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) AS primary_image,
        COALESCE((SELECT json_agg(pi.url ORDER BY pi.sort_order ASC) FROM product_images pi WHERE pi.product_id = p.id), '[]') AS images
      FROM favorites f
      JOIN products p ON p.id = f.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE f.user_id = $1 AND p.is_active = true
      ORDER BY f.created_at DESC
    `;
    const { rows } = await pool.query(sql, [req.userId]);
    res.json(rows.map((row) => ({
      id: row.id,
      name: row.name,
      sub: row.sub,
      price: Number(row.price),
      oldPrice: row.old_price !== null ? Number(row.old_price) : null,
      img: row.primary_image,
      images: row.images,
      cat: row.category_name,
      colors: row.colors,
      sizes: row.sizes,
      desc: row.description,
      rating: row.rating !== null ? Number(row.rating) : 0,
      reviews: row.reviews_count,
    })));
  } catch (err) {
    next(err);
  }
});

router.post('/:productId/toggle', async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { rows } = await pool.query(
      'SELECT 1 FROM favorites WHERE user_id=$1 AND product_id=$2',
      [req.userId, productId]
    );
    if (rows.length) {
      await pool.query('DELETE FROM favorites WHERE user_id=$1 AND product_id=$2', [req.userId, productId]);
      return res.json({ favorited: false });
    }
    await pool.query('INSERT INTO favorites (user_id, product_id) VALUES ($1,$2)', [req.userId, productId]);
    res.json({ favorited: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
