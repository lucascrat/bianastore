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

// Multi-facet product finder for the "Buscar" screen — every filter combines
// (AND). Free text hits name + subtitle + description (covers "model" words
// like midi / pantalona / alfaiataria). Stock is returned per product and
// filtered client-side. `filters` lists every distinct value that exists so
// the dropdowns/palette stay in sync with the real catalog.
router.get('/product-search', async (req, res, next) => {
  try {
    const { q, category, color, size, minPrice, maxPrice, active } = req.query;
    const params = [];
    let sql = `
      SELECT p.id, p.name, p.sub, p.price, p.old_price, p.colors, p.sizes, p.is_active,
        c.name AS category_name,
        (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) AS img,
        COALESCE((SELECT SUM(pv.stock_qty) FROM product_variants pv WHERE pv.product_id = p.id), 0) AS total_stock
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE 1=1
    `;
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      sql += ` AND (p.name ILIKE $${i} OR p.sub ILIKE $${i} OR p.description ILIKE $${i})`;
    }
    if (category) { params.push(category); sql += ` AND p.category_id = $${params.length}`; }
    if (color) { params.push(color); sql += ` AND p.colors ? $${params.length}`; }
    if (size) { params.push(size); sql += ` AND p.sizes ? $${params.length}`; }
    if (minPrice) { params.push(minPrice); sql += ` AND p.price >= $${params.length}`; }
    if (maxPrice) { params.push(maxPrice); sql += ` AND p.price <= $${params.length}`; }
    if (active === 'true') sql += ' AND p.is_active = true';
    if (active === 'false') sql += ' AND p.is_active = false';
    sql += ' ORDER BY p.id DESC';
    const { rows } = await pool.query(sql, params);

    const [colorRows, sizeRows, catRows] = await Promise.all([
      pool.query(`SELECT DISTINCT v AS val FROM products, jsonb_array_elements_text(colors) v ORDER BY 1`),
      pool.query(`SELECT DISTINCT v AS val FROM products, jsonb_array_elements_text(sizes) v ORDER BY 1`),
      pool.query(`SELECT id, name FROM categories ORDER BY sort_order ASC`),
    ]);

    res.json({
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        sub: r.sub,
        price: Number(r.price),
        oldPrice: r.old_price !== null ? Number(r.old_price) : null,
        colors: r.colors,
        sizes: r.sizes,
        category: r.category_name,
        img: r.img,
        totalStock: Number(r.total_stock),
        isActive: r.is_active,
      })),
      filters: {
        colors: colorRows.rows.map((r) => r.val),
        sizes: sizeRows.rows.map((r) => r.val),
        categories: catRows.rows,
      },
    });
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
    // Was missing entirely — a client-side bug (see product-edit.html) could
    // send name:undefined and this would previously just crash on the
    // column's NOT NULL constraint with a raw 500. Fail with a clear 400
    // instead, same as the create route already does.
    if (!name || price === undefined) return res.status(400).json({ error: 'name and price are required' });
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

// ---- Shipping zones ----
router.get('/shipping-zones', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM shipping_zones ORDER BY sort_order ASC');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/shipping-zones', async (req, res, next) => {
  try {
    const { name, states, standardCost, standardDays, expressCost, expressDays, sortOrder } = req.body;
    if (!name || !Array.isArray(states) || !states.length) {
      return res.status(400).json({ error: 'name and at least one state are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO shipping_zones (name, states, standard_cost, standard_days, express_cost, express_days, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, JSON.stringify(states.map((s) => s.toUpperCase())), standardCost || 0, standardDays || 5, expressCost || 0, expressDays || 2, sortOrder || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.put('/shipping-zones/:id', async (req, res, next) => {
  try {
    const { name, states, standardCost, standardDays, expressCost, expressDays, sortOrder } = req.body;
    const { rows } = await pool.query(
      `UPDATE shipping_zones SET name=$1, states=$2, standard_cost=$3, standard_days=$4, express_cost=$5, express_days=$6, sort_order=$7, updated_at=now()
       WHERE id=$8 RETURNING *`,
      [name, JSON.stringify((states || []).map((s) => s.toUpperCase())), standardCost || 0, standardDays || 5, expressCost || 0, expressDays || 2, sortOrder || 0, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Zone not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/shipping-zones/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM shipping_zones WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Coupons ----
router.get('/coupons', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/coupons', async (req, res, next) => {
  try {
    const { code, discountType, discountValue, minOrderValue, maxUses, active, expiresAt } = req.body;
    if (!code || !discountType || discountValue === undefined) {
      return res.status(400).json({ error: 'code, discountType and discountValue are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO coupons (code, discount_type, discount_value, min_order_value, max_uses, active, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [code.toUpperCase().trim(), discountType, discountValue, minOrderValue || 0, maxUses || null, active !== false, expiresAt || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um cupom com esse código' });
    next(err);
  }
});

router.put('/coupons/:code', async (req, res, next) => {
  try {
    const { discountType, discountValue, minOrderValue, maxUses, active, expiresAt } = req.body;
    const { rows } = await pool.query(
      `UPDATE coupons SET discount_type=$1, discount_value=$2, min_order_value=$3, max_uses=$4, active=$5, expires_at=$6
       WHERE code=$7 RETURNING *`,
      [discountType, discountValue, minOrderValue || 0, maxUses || null, active !== false, expiresAt || null, req.params.code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Coupon not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/coupons/:code', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM coupons WHERE code=$1', [req.params.code.toUpperCase()]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---- Dashboard ----
router.get('/dashboard', async (req, res, next) => {
  try {
    const [revenue, ordersByStatus, topProducts, lowStock, recentOrders] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(total) FILTER (WHERE payment_status='paid' AND created_at >= date_trunc('day', now())), 0) AS today,
          COALESCE(SUM(total) FILTER (WHERE payment_status='paid' AND created_at >= date_trunc('week', now())), 0) AS week,
          COALESCE(SUM(total) FILTER (WHERE payment_status='paid' AND created_at >= date_trunc('month', now())), 0) AS month,
          COALESCE(SUM(total) FILTER (WHERE payment_status='paid'), 0) AS all_time,
          COUNT(*) FILTER (WHERE payment_status='paid') AS paid_orders_count
        FROM orders
      `),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status`),
      // Grouped by product_id ONLY, using the product's CURRENT name/photo
      // (falling back to the last order's snapshot if the product no longer
      // exists) — grouping by the snapshot columns too, as this used to,
      // fragmented a single product's sales into multiple rows every time
      // its name or primary photo was edited after it already had sales.
      pool.query(`
        SELECT oi.product_id,
          COALESCE(p.name, (array_agg(oi.product_name_snapshot ORDER BY oi.id DESC))[1]) AS name,
          COALESCE(pi.url, (array_agg(oi.product_image_snapshot ORDER BY oi.id DESC))[1]) AS img,
          SUM(oi.qty)::int AS units_sold, SUM(oi.qty * oi.unit_price) AS revenue
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        LEFT JOIN products p ON p.id = oi.product_id
        LEFT JOIN LATERAL (
          SELECT url FROM product_images WHERE product_id = oi.product_id ORDER BY is_primary DESC, sort_order ASC LIMIT 1
        ) pi ON true
        WHERE o.payment_status = 'paid'
        GROUP BY oi.product_id, p.name, pi.url
        ORDER BY units_sold DESC
        LIMIT 5
      `),
      pool.query(`
        SELECT pv.id, pv.color, pv.size, pv.stock_qty, p.name AS product_name
        FROM product_variants pv JOIN products p ON p.id = pv.product_id
        WHERE pv.stock_qty <= 5 AND p.is_active = true
        ORDER BY pv.stock_qty ASC LIMIT 10
      `),
      pool.query(`
        SELECT id, order_number, status, status_label, payment_status, total, created_at
        FROM orders ORDER BY created_at DESC LIMIT 8
      `),
    ]);
    const statusCounts = { processing: 0, shipping: 0, delivered: 0, cancelled: 0 };
    ordersByStatus.rows.forEach((r) => { statusCounts[r.status] = r.count; });
    res.json({
      revenue: {
        today: Number(revenue.rows[0].today),
        week: Number(revenue.rows[0].week),
        month: Number(revenue.rows[0].month),
        allTime: Number(revenue.rows[0].all_time),
        paidOrdersCount: Number(revenue.rows[0].paid_orders_count),
      },
      ordersByStatus: statusCounts,
      topProducts: topProducts.rows.map((r) => ({ productId: r.product_id, name: r.name, img: r.img, unitsSold: r.units_sold, revenue: Number(r.revenue) })),
      lowStock: lowStock.rows.map((r) => ({ id: r.id, productName: r.product_name, color: r.color, size: r.size, stock: r.stock_qty })),
      recentOrders: recentOrders.rows.map((r) => ({ id: r.id, orderNumber: r.order_number, status: r.status, statusLabel: r.status_label, paymentStatus: r.payment_status, total: Number(r.total), createdAt: r.created_at })),
    });
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
// Canonical fulfilment pipeline. `status` is the machine value stored on the
// row; `label` is the pt-BR text shown to the customer (auto-applied on a
// status change unless the admin typed their own). `next` drives the
// one-click "advance" button on the Vendas screen.
const ORDER_FLOW = {
  processing: { label: 'Em preparação', next: 'shipping', nextAction: 'Despachar' },
  shipping: { label: 'A caminho', next: 'delivered', nextAction: 'Marcar entregue' },
  delivered: { label: 'Entregue', next: null, nextAction: null },
  cancelled: { label: 'Cancelado', next: null, nextAction: null },
};

const PERIOD_SQL = {
  today: "o.created_at >= date_trunc('day', now())",
  '7d': "o.created_at >= now() - interval '7 days'",
  '30d': "o.created_at >= now() - interval '30 days'",
  all: 'TRUE',
};

router.get('/orders', async (req, res, next) => {
  try {
    const { period = 'today', status, payment, q } = req.query;
    const where = [PERIOD_SQL[period] || PERIOD_SQL.today];
    const params = [];
    if (status && ORDER_FLOW[status]) { params.push(status); where.push(`o.status = $${params.length}`); }
    if (payment) { params.push(payment); where.push(`o.payment_status = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(o.order_number ILIKE $${params.length} OR c.name ILIKE $${params.length} OR o.shipping_address->>'recipient' ILIKE $${params.length})`);
    }

    const { rows } = await pool.query(`
      SELECT o.id, o.order_number, o.status, o.status_label, o.payment_status, o.payment_method,
        o.subtotal, o.discount, o.shipping_cost, o.total, o.installments,
        o.created_at, o.updated_at,
        COALESCE(c.name, o.shipping_address->>'recipient') AS customer_name,
        o.shipping_address->>'phone' AS customer_phone,
        o.shipping_address->>'city' AS city,
        o.shipping_address->>'state' AS state,
        COUNT(oi.id)::int AS items_count,
        COALESCE(SUM(oi.qty), 0)::int AS units
      FROM orders o
      LEFT JOIN customers c ON c.user_id = o.user_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE ${where.join(' AND ')}
      GROUP BY o.id, c.name
      ORDER BY o.created_at DESC
      LIMIT 300
    `, params);

    const ids = rows.map((r) => r.id);
    let itemsByOrder = {};
    if (ids.length) {
      const { rows: items } = await pool.query(
        `SELECT order_id, product_id, product_name_snapshot, product_image_snapshot, size, color, qty
         FROM order_items WHERE order_id = ANY($1) ORDER BY id ASC`,
        [ids],
      );
      itemsByOrder = items.reduce((acc, it) => {
        (acc[it.order_id] = acc[it.order_id] || []).push({
          productId: it.product_id,
          name: it.product_name_snapshot,
          img: it.product_image_snapshot,
          size: it.size,
          color: it.color || null,
          qty: it.qty,
        });
        return acc;
      }, {});
    }

    // Summary is over ALL orders (ignores the current filters) so the alert
    // counts don't vanish when the admin narrows the view.
    const { rows: sum } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now())) AS today_count,
        COALESCE(SUM(total) FILTER (WHERE payment_status='paid' AND created_at >= date_trunc('day', now())), 0) AS today_revenue,
        COUNT(*) FILTER (WHERE payment_status='paid' AND status='processing') AS to_ship,
        COUNT(*) FILTER (WHERE status='shipping') AS in_transit,
        COUNT(*) FILTER (WHERE status='delivered' AND updated_at >= date_trunc('week', now())) AS delivered_week,
        COUNT(*) FILTER (WHERE payment_status='pending' AND status <> 'cancelled') AS awaiting_payment
      FROM orders
    `);
    const s = sum[0];

    res.json({
      summary: {
        todayCount: Number(s.today_count),
        todayRevenue: Number(s.today_revenue),
        toShip: Number(s.to_ship),
        inTransit: Number(s.in_transit),
        deliveredWeek: Number(s.delivered_week),
        awaitingPayment: Number(s.awaiting_payment),
      },
      orders: rows.map((r) => ({
        id: r.id,
        orderNumber: r.order_number,
        status: r.status,
        statusLabel: r.status_label,
        paymentStatus: r.payment_status,
        paymentMethod: r.payment_method,
        subtotal: Number(r.subtotal),
        discount: Number(r.discount),
        shippingCost: Number(r.shipping_cost),
        total: Number(r.total),
        installments: r.installments,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        city: r.city,
        state: r.state,
        itemsCount: r.items_count,
        units: r.units,
        items: itemsByOrder[r.id] || [],
      })),
    });
  } catch (err) { next(err); }
});

router.get('/orders/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id=$1', [req.params.id]);
    let customer = null;
    const { rows: cust } = await pool.query('SELECT name, email, photo_url FROM customers WHERE user_id=$1', [rows[0].user_id]);
    if (cust.length) customer = cust[0];
    res.json({ ...rows[0], items, customer });
  } catch (err) { next(err); }
});

const STATUS_NOTIFICATIONS = {
  processing: { icon: 'inventory_2', title: 'Pagamento confirmado! 🎉', body: (n) => `Recebemos o pagamento do pedido ${n}. Já estamos preparando tudo.` },
  shipping: { icon: 'local_shipping', title: 'Pedido enviado! 📦', body: (n) => `Seu pedido ${n} está a caminho.` },
  delivered: { icon: 'check_circle', title: 'Pedido entregue!', body: (n) => `Seu pedido ${n} foi entregue. Aproveite!` },
  cancelled: { icon: 'cancel', title: 'Pedido cancelado', body: (n) => `Seu pedido ${n} foi cancelado.` },
};

router.patch('/orders/:id', async (req, res, next) => {
  try {
    const { status, statusLabel } = req.body;
    if (status && !ORDER_FLOW[status]) return res.status(400).json({ error: 'Invalid status' });
    // A bare status change carries the canonical pt-BR label with it, so the
    // admin never has to retype it; an explicit statusLabel still wins.
    const label = statusLabel || (status ? ORDER_FLOW[status].label : null);
    const { rows } = await pool.query(
      'UPDATE orders SET status=COALESCE($1,status), status_label=COALESCE($2,status_label), updated_at=now() WHERE id=$3 RETURNING *',
      [status || null, label, req.params.id]
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
