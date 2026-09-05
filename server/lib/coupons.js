// Shared coupon validation logic — used both by the public preview endpoint
// (server/routes/coupons.js, called while the customer is still typing the
// code into checkout) and by the authoritative check inside the order
// transaction (server/routes/orders.js persistOrder()). Keeping this in one
// place means those two can never quietly disagree on what makes a coupon
// valid.

async function getCouponOrThrow(queryable, code) {
  const { rows } = await queryable.query('SELECT * FROM coupons WHERE code = $1', [String(code).toUpperCase()]);
  const coupon = rows[0];
  if (!coupon) throw Object.assign(new Error('Cupom não encontrado'), { status: 404 });
  return coupon;
}

function assertCouponUsable(coupon, subtotal) {
  if (!coupon.active) throw Object.assign(new Error('Cupom inativo'), { status: 400 });
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    throw Object.assign(new Error('Cupom expirado'), { status: 400 });
  }
  if (coupon.max_uses !== null && coupon.uses_count >= coupon.max_uses) {
    throw Object.assign(new Error('Cupom esgotado'), { status: 400 });
  }
  if (subtotal < Number(coupon.min_order_value)) {
    throw Object.assign(new Error(`Pedido mínimo de R$ ${Number(coupon.min_order_value).toFixed(2).replace('.', ',')} para usar este cupom`), { status: 400 });
  }
}

function computeCouponDiscount(coupon, subtotal) {
  const discount = coupon.discount_type === 'percent'
    ? subtotal * (Number(coupon.discount_value) / 100)
    : Math.min(Number(coupon.discount_value), subtotal);
  return Math.round(discount * 100) / 100;
}

module.exports = { getCouponOrThrow, assertCouponUsable, computeCouponDiscount };
