const express = require('express');
const pool = require('../db/pool');
const { requireUserId } = require('../middleware/user');

const router = express.Router();
router.use(requireUserId);

const CART_SELECT = `
  SELECT ci.product_id, ci.size, ci.qty,
    p.name, p.price, p.old_price, p.sizes,
    (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) AS img
  FROM cart_items ci
  JOIN products p ON p.id = ci.product_id
  WHERE ci.user_id = $1
  ORDER BY ci.created_at ASC
`;

function serialize(row) {
  return {
    key: `${row.product_id}-${row.size}`,
    productId: row.product_id,
    size: row.size,
    qty: row.qty,
    name: row.name,
    price: Number(row.price),
    oldPrice: row.old_price !== null ? Number(row.old_price) : null,
    img: row.img,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(CART_SELECT, [req.userId]);
    res.json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { productId, size, qty } = req.body;
    if (!productId || !size || !qty || qty < 1) {
      return res.status(400).json({ error: 'productId, size and qty (>=1) are required' });
    }
    await pool.query(
      `INSERT INTO cart_items (user_id, product_id, size, qty)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, product_id, size) DO UPDATE SET qty = cart_items.qty + EXCLUDED.qty, updated_at = now()`,
      [req.userId, productId, size, qty]
    );
    const { rows } = await pool.query(CART_SELECT, [req.userId]);
    res.status(201).json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const { productId, size, qty } = req.body;
    if (!productId || !size || qty === undefined) {
      return res.status(400).json({ error: 'productId, size and qty are required' });
    }
    if (qty <= 0) {
      await pool.query('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2 AND size=$3', [req.userId, productId, size]);
    } else {
      await pool.query(
        'UPDATE cart_items SET qty=$4, updated_at=now() WHERE user_id=$1 AND product_id=$2 AND size=$3',
        [req.userId, productId, size, qty]
      );
    }
    const { rows } = await pool.query(CART_SELECT, [req.userId]);
    res.json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const { productId, size } = req.body;
    if (!productId || !size) return res.status(400).json({ error: 'productId and size are required' });
    await pool.query('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2 AND size=$3', [req.userId, productId, size]);
    const { rows } = await pool.query(CART_SELECT, [req.userId]);
    res.json(rows.map(serialize));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
