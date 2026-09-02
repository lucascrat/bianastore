const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const pool = require('../db/pool');
const r2 = require('../lib/r2');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype) || /^video\/(mp4|webm)$/.test(file.mimetype);
    cb(ok ? null : new Error('Unsupported file type'), ok);
  },
});

// Simple brute-force guard: 5 attempts / 15 min / IP, in-memory (single instance).
const loginAttempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  const recent = entry.filter((t) => now - t < 15 * 60 * 1000);
  loginAttempts.set(ip, recent);
  return recent.length >= 5;
}
function recordAttempt(ip) {
  const entry = loginAttempts.get(ip) || [];
  entry.push(Date.now());
  loginAttempts.set(ip, entry);
}

router.post('/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const { password } = req.body;
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not configured on server' });
  }
  const expected = Buffer.from(process.env.ADMIN_PASSWORD);
  const given = Buffer.from(String(password || ''));
  const match = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!match) {
    recordAttempt(ip);
    return res.status(401).json({ error: 'Invalid password' });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/session', (req, res) => {
  res.json({ isAdmin: Boolean(req.session && req.session.isAdmin) });
});

router.use(requireAdmin);

// ---- Products ----
router.get('/products', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*, c.name AS category_name,
        COALESCE((SELECT json_agg(json_build_object('id',pi.id,'url',pi.url,'sortOrder',pi.sort_order,'isPrimary',pi.is_primary) ORDER BY pi.sort_order) FROM product_images pi WHERE pi.product_id = p.id), '[]') AS images
      FROM products p LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY p.id DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/products', async (req, res, next) => {
  try {
    const { name, sub, price, oldPrice, categoryId, colors, sizes, description, rating, reviewsCount } = req.body;
    if (!name || price === undefined) return res.status(400).json({ error: 'name and price are required' });
    const { rows } = await pool.query(
      `INSERT INTO products (name, sub, price, old_price, category_id, colors, sizes, description, rating, reviews_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, sub || null, price, oldPrice || null, categoryId || null, JSON.stringify(colors || []), JSON.stringify(sizes || []), description || null, rating || 0, reviewsCount || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/products/:id', async (req, res, next) => {
  try {
    const { name, sub, price, oldPrice, categoryId, colors, sizes, description, rating, reviewsCount, isActive } = req.body;
    const { rows } = await pool.query(
      `UPDATE products SET name=$1, sub=$2, price=$3, old_price=$4, category_id=$5, colors=$6, sizes=$7, description=$8, rating=$9, reviews_count=$10, is_active=$11, updated_at=now()
       WHERE id=$12 RETURNING *`,
      [name, sub || null, price, oldPrice || null, categoryId || null, JSON.stringify(colors || []), JSON.stringify(sizes || []), description || null, rating || 0, reviewsCount || 0, isActive !== false, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/products/:id', async (req, res, next) => {
  try {
    // Soft delete: orders keep snapshots so hard-deleting products is never necessary.
    await pool.query('UPDATE products SET is_active=false, updated_at=now() WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/products/:id/images', async (req, res, next) => {
  try {
    const { url, isPrimary } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (isPrimary) {
      await pool.query('UPDATE product_images SET is_primary=false WHERE product_id=$1', [req.params.id]);
    }
    const { rows } = await pool.query(
      'INSERT INTO product_images (product_id, url, is_primary) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, url, Boolean(isPrimary)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/products/:id/images/:imageId', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM product_images WHERE id=$1 AND product_id=$2', [req.params.imageId, req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Categories ----
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM categories ORDER BY sort_order ASC');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/categories', async (req, res, next) => {
  try {
    const { name, sortOrder } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query('INSERT INTO categories (name, sort_order) VALUES ($1,$2) RETURNING *', [name, sortOrder || 0]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/categories/:id', async (req, res, next) => {
  try {
    const { name, sortOrder } = req.body;
    const { rows } = await pool.query('UPDATE categories SET name=$1, sort_order=$2 WHERE id=$3 RETURNING *', [name, sortOrder || 0, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Category not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/categories/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM categories WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Feed ----
router.get('/feed', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT f.*, p.name AS product_name FROM feed_items f JOIN products p ON p.id = f.product_id ORDER BY f.sort_order ASC, f.id ASC
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/feed', async (req, res, next) => {
  try {
    const { productId, mediaUrl, mediaType, likesCount, commentsCount, saleBadge, sortOrder } = req.body;
    if (!productId || !mediaUrl) return res.status(400).json({ error: 'productId and mediaUrl are required' });
    const { rows } = await pool.query(
      `INSERT INTO feed_items (product_id, media_url, media_type, likes_count, comments_count, sale_badge, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [productId, mediaUrl, mediaType || 'image', likesCount || 0, commentsCount || 0, saleBadge || null, sortOrder || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/feed/:id', async (req, res, next) => {
  try {
    const { productId, mediaUrl, mediaType, likesCount, commentsCount, saleBadge, sortOrder } = req.body;
    const { rows } = await pool.query(
      `UPDATE feed_items SET product_id=$1, media_url=$2, media_type=$3, likes_count=$4, comments_count=$5, sale_badge=$6, sort_order=$7 WHERE id=$8 RETURNING *`,
      [productId, mediaUrl, mediaType || 'image', likesCount || 0, commentsCount || 0, saleBadge || null, sortOrder || 0, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Feed item not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/feed/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM feed_items WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Media upload ----
router.post('/media/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    if (!r2.isConfigured()) {
      return res.status(503).json({ error: 'R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL_BASE.' });
    }
    const ext = path.extname(req.file.originalname) || '';
    const slug = path.basename(req.file.originalname, ext).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const key = `products/${Date.now()}-${slug}${ext}`;
    const url = await r2.uploadBuffer({ buffer: req.file.buffer, key, contentType: req.file.mimetype });
    await pool.query(
      'INSERT INTO media_assets (r2_key, url, content_type, size_bytes) VALUES ($1,$2,$3,$4)',
      [key, url, req.file.mimetype, req.file.size]
    );
    res.status(201).json({ url });
  } catch (err) {
    if (err.code === 'R2_NOT_CONFIGURED') return res.status(503).json({ error: 'R2 not configured' });
    next(err);
  }
});

router.get('/media', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM media_assets ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  } catch (err) { next(err); }
});

// ---- Orders ----
router.get('/orders', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT o.*, COUNT(oi.id)::int AS items_count
      FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY o.id ORDER BY o.created_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id=$1', [req.params.id]);
    res.json({ ...rows[0], items });
  } catch (err) { next(err); }
});

router.patch('/orders/:id', async (req, res, next) => {
  try {
    const { status, statusLabel } = req.body;
    const { rows } = await pool.query(
      'UPDATE orders SET status=COALESCE($1,status), status_label=COALESCE($2,status_label), updated_at=now() WHERE id=$3 RETURNING *',
      [status || null, statusLabel || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
