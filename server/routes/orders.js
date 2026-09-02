const express = require('express');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { requireUserId } = require('../middleware/user');
const efi = require('../lib/efi');
const push = require('../lib/push');

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

async function loadCartAndTotals(userId, client) {
  const { rows: cartRows } = await client.query(
    `SELECT ci.product_id, ci.size, ci.qty, p.name, p.price, p.old_price,
      (SELECT pi.url FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.is_primary DESC, pi.sort_order ASC LIMIT 1) AS img
     FROM cart_items ci JOIN products p ON p.id = ci.product_id
     WHERE ci.user_id = $1`,
    [userId]
  );
  let subtotal = 0;
  let discount = 0;
  for (const item of cartRows) {
    subtotal += Number(item.price) * item.qty;
    if (item.old_price) discount += (Number(item.old_price) - Number(item.price)) * item.qty;
  }
  return { cartRows, subtotal, discount };
}

async function persistOrder({ client, userId, shippingAddress, paymentMethod, shippingMethod, cartRows, subtotal, discount, shippingCost, total, paymentStatus, paymentProviderId, pixQrCode, installments }) {
  let orderNumber = generateOrderNumber();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows } = await client.query('SELECT 1 FROM orders WHERE order_number=$1', [orderNumber]);
    if (!rows.length) break;
    orderNumber = generateOrderNumber();
  }

  const { rows: orderRows } = await client.query(
    `INSERT INTO orders (order_number, user_id, status, status_label, subtotal, discount, shipping_cost, total, shipping_address, payment_method, shipping_method, payment_status, payment_provider_id, pix_qr_code, installments)
     VALUES ($1,$2,'processing','Processando',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [orderNumber, userId, subtotal, discount, shippingCost, total, JSON.stringify(shippingAddress), paymentMethod, shippingMethod, paymentStatus, paymentProviderId || null, pixQrCode || null, installments || 1]
  );
  const order = orderRows[0];

  for (const item of cartRows) {
    await client.query(
      `INSERT INTO order_items (order_id, product_id, product_name_snapshot, product_image_snapshot, size, qty, unit_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [order.id, item.product_id, item.name, item.img, item.size, item.qty, item.price]
    );
  }

  await client.query('DELETE FROM cart_items WHERE user_id=$1', [userId]);
  await client.query(
    `INSERT INTO notifications (user_id, type, icon, title, description, unread)
     VALUES ($1,'order','package_2',$2,$3,true)`,
    [userId, `Pedido ${orderNumber} confirmado`, paymentStatus === 'paid' ? 'Pagamento aprovado! Seu pedido está sendo processado.' : 'Seu pedido foi recebido, aguardando confirmação do pagamento.']
  );

  return order;
}

router.post('/', async (req, res, next) => {
  try {
    const { shippingAddress, paymentMethod, shippingMethod } = req.body;
    if (!shippingAddress || !paymentMethod || !shippingMethod) {
      return res.status(400).json({ error: 'shippingAddress, paymentMethod and shippingMethod are required' });
    }
    if (!['pix', 'credit'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'paymentMethod must be pix or credit' });
    }
    if (!efi.isConfigured()) {
      return res.status(503).json({ error: 'Pagamentos indisponíveis no momento. Tente novamente mais tarde.' });
    }

    const { cartRows, subtotal, discount } = await loadCartAndTotals(req.userId, pool);
    if (!cartRows.length) return res.status(400).json({ error: 'Cart is empty' });

    const shippingCost = computeShippingCost(shippingMethod, subtotal);

    if (paymentMethod === 'pix') {
      const pixDiscount = subtotal * 0.05;
      const total = subtotal - pixDiscount + shippingCost;
      // Reserve a candidate order number up front so the Pix txid (derived
      // from it) is stable even though the order row doesn't exist yet.
      const tentativeOrderNumber = generateOrderNumber();

      let charge;
      try {
        charge = await efi.createPixCharge({
          orderNumber: tentativeOrderNumber,
          valor: total,
          solicitacaoPagador: `Pedido BianaStore`,
        });
      } catch (err) {
        console.error('Efi Pix charge failed:', err.response?.data || err.message);
        return res.status(502).json({ error: 'Não foi possível gerar o PIX. Tente novamente.' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const order = await persistOrder({
          client, userId: req.userId, shippingAddress, paymentMethod, shippingMethod, cartRows,
          subtotal, discount: discount + pixDiscount, shippingCost, total,
          paymentStatus: 'pending', paymentProviderId: charge.txid, pixQrCode: charge.pixCopiaECola, installments: 1,
        });
        await client.query('COMMIT');
        res.status(201).json(await serializeOrder(order.id));
        push.sendPush(req.userId, { title: `Pedido ${order.order_number} recebido`, body: 'Pague o Pix para confirmar seu pedido.', url: '/?view=orders' }).catch(() => {});
      } catch (err) {
        await client.query('ROLLBACK');
        next(err);
      } finally {
        client.release();
      }
      return;
    }

    // ---- Credit card ----
    const { paymentToken, installments, customer } = req.body;
    if (!paymentToken || !installments || !customer?.name || !customer?.cpf || !customer?.email || !customer?.phone) {
      return res.status(400).json({ error: 'Dados do cartão/cliente incompletos' });
    }
    const totalCents = Math.round((subtotal + shippingCost) * 100); // no pix discount for card

    let chargeResult;
    try {
      chargeResult = await efi.chargeCard({
        items: cartRows.map((i) => ({ name: i.name, value: Math.round(Number(i.price) * 100), amount: i.qty })).concat(
          shippingCost > 0 ? [{ name: 'Frete', value: Math.round(shippingCost * 100), amount: 1 }] : []
        ),
        creditCard: {
          customer: {
            name: customer.name,
            cpf: customer.cpf.replace(/\D/g, ''),
            email: customer.email,
            phone_number: customer.phone.replace(/\D/g, ''),
            address: {
              street: shippingAddress.street, number: shippingAddress.number || 'S/N',
              neighborhood: shippingAddress.neighborhood, zipcode: (shippingAddress.cep || '').replace(/\D/g, ''),
              city: shippingAddress.city, state: shippingAddress.state, complement: shippingAddress.complement || '',
            },
          },
          installments,
          payment_token: paymentToken,
          billing_address: {
            street: shippingAddress.street, number: shippingAddress.number || 'S/N',
            neighborhood: shippingAddress.neighborhood, zipcode: (shippingAddress.cep || '').replace(/\D/g, ''),
            city: shippingAddress.city, state: shippingAddress.state,
          },
        },
      });
    } catch (err) {
      console.error('Efi card charge failed:', err.response?.data || err.message);
      const reason = err.response?.data?.error_description || 'Pagamento recusado pela operadora do cartão.';
      return res.status(402).json({ error: reason });
    }

    const chargeData = chargeResult.data || chargeResult;
    if (chargeData.status && chargeData.status !== 'approved' && chargeData.status !== 'paid' && chargeData.status !== 'waiting') {
      return res.status(402).json({ error: chargeData.refusal?.reason || 'Pagamento recusado pela operadora do cartão.' });
    }
    const finalTotal = chargeData.total ? chargeData.total / 100 : totalCents / 100;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = await persistOrder({
        client, userId: req.userId, shippingAddress, paymentMethod, shippingMethod, cartRows,
        subtotal, discount, shippingCost, total: finalTotal,
        paymentStatus: 'paid', paymentProviderId: String(chargeData.charge_id || ''), pixQrCode: null, installments,
      });
      await client.query('COMMIT');
      res.status(201).json(await serializeOrder(order.id));
      push.sendPush(req.userId, { title: `Pagamento aprovado! 🎉`, body: `Pedido ${order.order_number} confirmado e sendo preparado.`, url: '/?view=orders' }).catch(() => {});
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// Called by the frontend while showing the Pix QR code — re-checks Efí
// directly (never trusts a client-supplied "I paid" claim) and flips the
// order to paid the moment Efí confirms it, with no webhook required.
router.get('/:id/check-payment', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [req.params.id, req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = rows[0];
    if (order.payment_status !== 'pending' || order.payment_method !== 'pix') {
      return res.json({ paymentStatus: order.payment_status });
    }
    const status = await efi.getPixChargeStatus(order.payment_provider_id);
    if (status === 'CONCLUIDA') {
      await pool.query(`UPDATE orders SET payment_status='paid', updated_at=now() WHERE id=$1`, [order.id]);
      await push.notifyUser(order.user_id, {
        type: 'order', icon: 'check_circle',
        title: 'Pagamento confirmado! 🎉',
        body: `Seu Pix do pedido ${order.order_number} foi recebido. Preparando seu pedido!`,
        url: '/?view=orders',
      });
      return res.json({ paymentStatus: 'paid' });
    }
    res.json({ paymentStatus: 'pending' });
  } catch (err) {
    next(err);
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
    paymentStatus: row.payment_status,
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
  // Generated on the fly (not stored) so the QR image is always rendered
  // fresh from the copia-e-cola text we already have.
  const pixQrImage = order.pix_qr_code ? await QRCode.toDataURL(order.pix_qr_code, { margin: 1, width: 300 }) : null;
  return {
    id: order.order_number,
    dbId: order.id,
    date: new Date(order.created_at).toLocaleDateString('pt-BR'),
    status: order.status,
    statusLabel: order.status_label,
    paymentStatus: order.payment_status,
    pixQrCode: order.pix_qr_code,
    pixQrImage,
    installments: order.installments,
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
