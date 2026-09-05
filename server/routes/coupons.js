const express = require('express');
const pool = require('../db/pool');
const { getCouponOrThrow, assertCouponUsable, computeCouponDiscount } = require('../lib/coupons');

const router = express.Router();

// Public preview — lets the checkout screen show "cupom aplicado, -R$20"
// before the order is actually placed. The real, authoritative check +
// uses_count increment happens again inside the order transaction
// (persistOrder() in orders.js), so this endpoint being called never
// actually consumes a use.
router.get('/:code/validate', async (req, res, next) => {
  try {
    const subtotal = Number(req.query.subtotal) || 0;
    const coupon = await getCouponOrThrow(pool, req.params.code);
    assertCouponUsable(coupon, subtotal);
    const discount = computeCouponDiscount(coupon, subtotal);
    res.json({ code: coupon.code, discountType: coupon.discount_type, discountValue: Number(coupon.discount_value), discount });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
