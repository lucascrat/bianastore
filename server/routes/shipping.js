const express = require('express');
const { findZoneForState, FALLBACK_ZONE } = require('../lib/shipping');

const router = express.Router();

// Public — the checkout screen calls this as soon as it knows the
// destination state (from the CEP auto-fill or manual entry) to show a real
// shipping estimate before the customer commits to an order. The order
// itself always recomputes this server-side too (see orders.js) — this
// endpoint never has to be trusted for the final charged amount.
router.get('/estimate', async (req, res, next) => {
  try {
    const { state } = req.query;
    const subtotal = Number(req.query.subtotal) || 0;
    const zone = (await findZoneForState(state)) || FALLBACK_ZONE;
    const standardFree = subtotal >= 299;
    res.json({
      zoneName: zone.name,
      standardCost: standardFree ? 0 : Number(zone.standard_cost),
      standardDays: zone.standard_days,
      expressCost: Number(zone.express_cost),
      expressDays: zone.express_days,
    });
  } catch (err) { next(err); }
});

module.exports = router;
