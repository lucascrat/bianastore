const express = require('express');
const pool = require('../db/pool');
const { requireUserId } = require('../middleware/user');

const router = express.Router();
router.use(requireUserId);

function computeShippingCost(method, subtotal) {
  if (method === 'express') return 14.9;
  // standard
  return subtotal >= 299 ? 0 : 9.9;
}

function generateOrderNumber() {
  return 'BS-' + Math.floor(20000 + Math.random() * 79999);
}

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { shippingAddress, paymentMethod, shippingMethod } = req.body;
    if (!shippingAddress || !paymentMethod || !shippingMethod) {
      return res.status(400).json({ error: 'shippingAddress, paymentMethod and shippingMethod are required' });
    }

    const { rows: cartRows } = await client.query(
      `SELECT ci.product_id, ci.size, ci.qty, p.name, p.price, p.old_price,
        (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) AS img
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = $1`,
      [req.userId]
    );
    if (!cartRows.length) return res.status(400).json({ error: 'Cart is empty' });

    // Totals are always recomputed server-side from the DB cart, never trusted from the client.
    let subtotal = 0;
    let discount = 0;
    for (const item of cartRows) {
      subtotal += Number(item.price) * item.qty;
      if (item.old_price) discount += (Number(item.old_price) - Number(item.price)) * item.qty;
    }
    const pixDiscount = paymentMethod === 'pix' ? subtotal * 0.05 : 0;
    const shippingCost = computeShippingCost(shippingMethod, subtotal);
    const total = subtotal - pixDiscount + shippingCost;

    await client.query('BEGIN');

    let orderNumber = generateOrderNumber();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { rows } = await client.query('SELECT 1 FROM orders WHERE order_number=$1', [orderNumber]);
      if (!rows.length) break;
      orderNumber = generateOrderNumber();
    }

    const { rows: orderRows } = await client.query(
      `INSERT INTO orders (order_number, user_id, status, status_label, subtotal, discount, shipping_cost, total, shipping_address, payment_method, shipping_method)
       VALUES ($1,$2,'processing','Processando',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [orderNumber, req.userId, subtotal, discount + pixDiscount, shippingCost, total, JSON.stringify(shippingAddress), paymentMethod, shippingMethod]
    );
    const order = orderRows[0];

    for (const item of cartRows) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name_snapshot, product_image_snapshot, size, qty, unit_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [order.id, item.product_id, item.name, item.img, item.size, item.qty, item.price]
      );
    }

    await client.query('DELETE FROM cart_items WHERE user_id=$1', [req.userId]);
    await client.query(
      `INSERT INTO notifications (user_id, type, icon, title, description, unread)
       VALUES ($1,'order','package_2',$2,$3,true)`,
      [req.userId, `Pedido ${orderNumber} confirmado`, 'Seu pedido foi recebido e está sendo processado.']
    );

    await client.query('COMMIT');
    res.status(201).json(await serializeOrder(order.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, COUNT(oi.id)::int AS items_count,
        COALESCE(json_agg(oi.product_image_snapshot ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS item_images
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC`,
      [req.userId]
    );
    res.json(rows.map(serializeOrderRow));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const order = await serializeOrder(req.params.id, req.userId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

function serializeOrderRow(row) {
  return {
    id: row.order_number,
    date: new Date(row.created_at).toLocaleDateString('pt-BR'),
    status: row.status,
    statusLabel: row.status_label,
    items: row.item_images.filter(Boolean),
    total: `R$ ${Number(row.total).toFixed(2).replace('.', ',')}`,
    items_count: row.items_count,
  };
}

async function serializeOrder(orderId, userId) {
  const params = userId ? [orderId, userId] : [orderId];
  const whereUser = userId ? 'AND o.user_id = $2' : '';
  const { rows } = await pool.query(`SELECT * FROM orders o WHERE o.id = $1 ${whereUser}`, params);
  if (!rows.length) return null;
  const order = rows[0];
  const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [order.id]);
  return {
    id: order.order_number,
    date: new Date(order.created_at).toLocaleDateString('pt-BR'),
    status: order.status,
    statusLabel: order.status_label,
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    shippingCost: Number(order.shipping_cost),
    total: Number(order.total),
    shippingAddress: order.shipping_address,
    paymentMethod: order.payment_method,
    shippingMethod: order.shipping_method,
    items: items.map((i) => ({
      productId: i.product_id,
      name: i.product_name_snapshot,
      img: i.product_image_snapshot,
      size: i.size,
      qty: i.qty,
      price: Number(i.unit_price),
    })),
  };
}

module.exports = router;
