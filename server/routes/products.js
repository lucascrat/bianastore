const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// Shapes a product row + aggregated images into the JSON the frontend expects
// (mirrors the old hardcoded PRODUCTS[] shape, plus an `images` array for the
// gallery UI that already exists in CSS but had no data before).
function serializeProduct(row) {
  return {
    id: row.id,
    name: row.name,
    sub: row.sub,
    price: Number(row.price),
    oldPrice: row.old_price !== null ? Number(row.old_price) : null,
    img: row.primary_image || null,
    images: row.images || [],
    cat: row.category_name,
    colors: row.colors,
    sizes: row.sizes,
    desc: row.description,
    rating: row.rating !== null ? Number(row.rating) : 0,
    reviews: row.reviews_count,
  };
}

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name,
    (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) AS primary_image,
    COALESCE((SELECT json_agg(pi.url ORDER BY pi.sort_order ASC) FROM product_images pi WHERE pi.product_id = p.id), '[]') AS images
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
`;

router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM categories ORDER BY sort_order ASC');
    res.json(rows.map((r) => r.name));
  } catch (err) {
    next(err);
  }
});

router.get('/products', async (req, res, next) => {
  try {
    const { category } = req.query;
    let sql = `${PRODUCT_SELECT} WHERE p.is_active = true`;
    const params = [];
    if (category && category !== 'Todos') {
      params.push(category);
      sql += ` AND c.name = $${params.length}`;
    }
    sql += ' ORDER BY p.id ASC';
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(serializeProduct));
  } catch (err) {
    next(err);
  }
});

router.get('/products/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(serializeProduct(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.get('/feed', async (req, res, next) => {
  try {
    const sql = `
      SELECT f.id, f.media_url, f.media_type, f.likes_count, f.comments_count, f.sale_badge,
        p.*, c.name AS category_name,
        (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) AS primary_image,
        COALESCE((SELECT json_agg(pi.url ORDER BY pi.sort_order ASC) FROM product_images pi WHERE pi.product_id = p.id), '[]') AS images
      FROM feed_items f
      JOIN products p ON p.id = f.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = true
      ORDER BY f.sort_order ASC, f.id ASC
    `;
    const { rows } = await pool.query(sql);
    res.json(rows.map((row) => ({
      id: row.id,
      product: serializeProduct(row),
      bg: row.media_url,
      mediaType: row.media_type,
      likes: formatCount(row.likes_count),
      comments: String(row.comments_count),
      sale: row.sale_badge,
    })));
  } catch (err) {
    next(err);
  }
});

function formatCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

module.exports = router;
