const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const pool = require('../db/pool');
const r2 = require('../lib/r2');
const push = require('../lib/push');
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

// Keeps product_variants in sync with a product's current colors/sizes
// arrays: inserts a (color,size) row for every combination that doesn't
// already have one, defaulting new ones to 0 stock — the admin sets real
// numbers from the Estoque screen. Never touches stock_qty for a combo that
// already exists, and never deletes a now-unused combo (harmless leftover,
// simplest to reason about; see product_variants comment in schema.sql).
async function syncProductVariants(productId, colors, sizes) {
  const colorList = (colors && colors.length ? colors : ['']);
  const sizeList = (sizes && sizes.length ? sizes : ['']);
  for (const color of colorList) {
    for (const size of sizeList) {
      await pool.query(
        `INSERT INTO product_variants (product_id, color, size, stock_qty)
         VALUES ($1,$2,$3,0) ON CONFLICT (product_id, color, size) DO NOTHING`,
        [productId, color, size]
      );
    }
  }
}

router.post('/products', async (req, res, next) => {
  try {
    const { name, sub, price, oldPrice, categoryId, colors, sizes, description, rating, reviewsCount } = req.body;
    if (!name || price === undefined) return res.status(400).json({ error: 'name and price are required' });
    const { rows } = await pool.query(
      `INSERT INTO products (name, sub, price, old_price, category_id, colors, sizes, description, rating, reviews_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [name, sub || null, price, oldPrice || null, categoryId || null, JSON.stringify(colors || []), JSON.stringify(sizes || []), description || null, rating || 0, reviewsCount || 0]
    );
    await syncProductVariants(rows[0].id, colors, sizes);
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
    await syncProductVariants(req.params.id, colors, sizes);
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
    const { rows } = await pool.query(
      'DELETE FROM product_images WHERE id=$1 AND product_id=$2 RETURNING url',
      [req.params.imageId, req.params.id]
    );
    if (rows.length) await deleteFromR2IfOurs(rows[0].url);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Only deletes objects that actually live in our own R2 bucket (matched by
// the configured public base URL) — never touches externally-hosted images
// (e.g. the placeholder lh3.googleusercontent.com URLs from the initial seed).
async function deleteFromR2IfOurs(url) {
  const base = (process.env.R2_PUBLIC_URL_BASE || '').replace(/\/$/, '');
  if (!base || !url || !url.startsWith(base + '/')) return;
  const key = url.slice(base.length + 1);
  try {
    await r2.deleteObject(key);
    await pool.query('DELETE FROM media_assets WHERE r2_key = $1', [key]);
  } catch (err) {
    console.error('Failed to delete R2 object', key, err.message);
  }
}

// ---- Stock / Inventory ----
router.get('/products/:id/variants', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, color, size, stock_qty FROM product_variants WHERE product_id=$1 ORDER BY color, size',
      [req.params.id]
    );
    res.json(rows.map((r) => ({ id: r.id, color: r.color, size: r.size, stock: r.stock_qty })));
  } catch (err) { next(err); }
});

// Bulk-save every variant of one product at once (the stock grid on the
// product-edit screen sends its whole grid on "Salvar estoque").
router.put('/products/:id/variants', async (req, res, next) => {
  try {
    const { variants } = req.body;
    if (!Array.isArray(variants)) return res.status(400).json({ error: 'variants must be an array' });
    for (const v of variants) {
      await pool.query(
        `INSERT INTO product_variants (product_id, color, size, stock_qty)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (product_id, color, size) DO UPDATE SET stock_qty = EXCLUDED.stock_qty, updated_at = now()`,
        [req.params.id, v.color || '', v.size || '', Math.max(0, parseInt(v.stock, 10) || 0)]
      );
    }
    const { rows } = await pool.query(
      'SELECT id, color, size, stock_qty FROM product_variants WHERE product_id=$1 ORDER BY color, size',
      [req.params.id]
    );
    res.json(rows.map((r) => ({ id: r.id, color: r.color, size: r.size, stock: r.stock_qty })));
  } catch (err) { next(err); }
});

// Global stock manager: every variant across every product, joined with the
// product's name/thumbnail/category so admin can see what belongs to what,
// with optional filters — color AND size can be combined to answer things
// like "what do we have left in red, size M".
router.get('/inventory', async (req, res, next) => {
  try {
    const { color, size, q } = req.query;
    const params = [];
    let sql = `
      SELECT pv.id, pv.color, pv.size, pv.stock_qty, pv.updated_at,
        p.id AS product_id, p.name AS product_name, p.is_active,
        c.name AS category_name,
        (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) AS img
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE 1=1
    `;
    if (color) { params.push(color); sql += ` AND pv.color = $${params.length}`; }
    if (size) { params.push(size); sql += ` AND pv.size = $${params.length}`; }
    if (q) { params.push(`%${q}%`); sql += ` AND p.name ILIKE $${params.length}`; }
    sql += ' ORDER BY p.name ASC, pv.color ASC, pv.size ASC';
    const { rows } = await pool.query(sql, params);

    // Distinct color/size values across ALL variants (unfiltered) so the two
    // filter dropdowns always list every option that exists, not just the
    // ones in the current filtered result.
    const { rows: colorRows } = await pool.query(`SELECT DISTINCT color FROM product_variants WHERE color != '' ORDER BY color`);
    const { rows: sizeRows } = await pool.query(`SELECT DISTINCT size FROM product_variants WHERE size != '' ORDER BY size`);

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        color: r.color,
        size: r.size,
        stock: r.stock_qty,
        updatedAt: r.updated_at,
        productId: r.product_id,
        productName: r.product_name,
        isActive: r.is_active,
        category: r.category_name,
        img: r.img,
      })),
      filters: {
        colors: colorRows.map((r) => r.color),
        sizes: sizeRows.map((r) => r.size),
      },
    });
  } catch (err) { next(err); }
});

// Quick inline stock edit from the global inventory table (one variant at a time).
router.patch('/inventory/:variantId', async (req, res, next) => {
  try {
    const { stock } = req.body;
    if (stock === undefined || stock < 0) return res.status(400).json({ error: 'stock must be >= 0' });
    const { rows } = await pool.query(
      'UPDATE product_variants SET stock_qty=$1, updated_at=now() WHERE id=$2 RETURNING id, color, size, stock_qty',
      [Math.max(0, parseInt(stock, 10) || 0), req.params.variantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Variant not found' });
    res.json({ id: rows[0].id, color: rows[0].color, size: rows[0].size, stock: rows[0].stock_qty });
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

router.delete('/media/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM media_assets WHERE id=$1 RETURNING r2_key', [req.params.id]);
    if (rows.length) await r2.deleteObject(rows[0].r2_key).catch((err) => console.error('R2 delete failed:', err.message));
    res.json({ ok: true });
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

const STATUS_NOTIFICATIONS = {
  shipping: { icon: 'local_shipping', title: 'Pedido enviado! 📦', body: (n) => `Seu pedido ${n} está a caminho.` },
  delivered: { icon: 'check_circle', title: 'Pedido entregue!', body: (n) => `Seu pedido ${n} foi entregue. Aproveite!` },
  cancelled: { icon: 'cancel', title: 'Pedido cancelado', body: (n) => `Seu pedido ${n} foi cancelado.` },
};

router.patch('/orders/:id', async (req, res, next) => {
  try {
    const { status, statusLabel } = req.body;
    const { rows } = await pool.query(
      'UPDATE orders SET status=COALESCE($1,status), status_label=COALESCE($2,status_label), updated_at=now() WHERE id=$3 RETURNING *',
      [status || null, statusLabel || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = rows[0];
    const notif = status && STATUS_NOTIFICATIONS[status];
    if (notif) {
      push.notifyUser(order.user_id, {
        type: 'order', icon: notif.icon, title: notif.title, body: notif.body(order.order_number), url: '/?view=orders',
      }).catch((err) => console.error('Failed to notify order status change:', err.message));
    }
    res.json(order);
  } catch (err) { next(err); }
});

// ---- Customers ----
router.get('/customers', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.user_id, c.name, c.email, c.photo_url, c.created_at,
        (SELECT COUNT(*)::int FROM orders o WHERE o.user_id = c.user_id) AS orders_count,
        (SELECT COALESCE(SUM(o.total), 0) FROM orders o WHERE o.user_id = c.user_id AND o.payment_status = 'paid') AS total_spent
      FROM customers c
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

// Removes the customer account only (email/senha/foto) — order history stays
// intact under the same anonymous user_id, it just won't show a name/photo
// on comments anymore. Use for spam/test accounts, not real customers.
router.delete('/customers/:userId', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM customers WHERE user_id = $1', [req.params.userId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Orders ----
// Full delete (not soft) — for test/junk orders only. Real orders should be
// cancelled via PATCH status instead so the customer keeps their history.
router.delete('/orders/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM orders WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
