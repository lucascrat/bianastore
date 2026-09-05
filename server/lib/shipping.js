const pool = require('../db/pool');

// Used when a destination state doesn't match any configured zone (e.g. a
// zone was deleted, or a new UF wasn't added to any zone yet) — the priciest
// generic tier, so an unconfigured state never silently gets free/cheap
// shipping by accident.
const FALLBACK_ZONE = { name: 'Padrão', standard_cost: 24.90, standard_days: 12, express_cost: 39.90, express_days: 6 };

// `states` is stored as a JSONB array of UF codes (e.g. ["SP","RJ"]) — the
// `?` operator checks whether a text value exists as a top-level element of
// a JSONB array (or key of an object), which is exactly "does this zone
// cover that state".
async function findZoneForState(state) {
  if (!state) return null;
  const { rows } = await pool.query(
    'SELECT * FROM shipping_zones WHERE states ? $1 ORDER BY sort_order ASC LIMIT 1',
    [String(state).toUpperCase()]
  );
  return rows[0] || null;
}

// Real shipping cost for a destination state + method, using the matching
// shipping_zones row. The free-shipping-over-R$299 promotion only ever
// applies to standard shipping (matches the pre-existing behavior before
// zones existed — express always costs, regardless of order size).
async function computeShippingCost(method, subtotal, state) {
  const zone = (await findZoneForState(state)) || FALLBACK_ZONE;
  if (method === 'express') return Number(zone.express_cost);
  return subtotal >= 299 ? 0 : Number(zone.standard_cost);
}

module.exports = { findZoneForState, computeShippingCost, FALLBACK_ZONE };
