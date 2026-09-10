const pool = require('./pool');

// One-shot, idempotent purge of known test-residue rows left over from
// pre-launch QA. Runs on every deploy (Dockerfile CMD) but is a plain no-op
// once the rows are gone. Every deletion is guarded so it can only ever touch
// the specific junk row it targets — never real catalogue or customer data.

async function cleanup() {
  // 1) "Produto Teste Bug" (#07): created during bug testing, never a real
  //    product — inactive, zero colors/sizes/images/stock. Guard on the exact
  //    name and on having no order history so a real product can't be hit.
  const junkProduct = await pool.query(
    `DELETE FROM products p
     WHERE p.name = 'Produto Teste Bug'
       AND p.is_active = false
       AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.product_id = p.id)
     RETURNING p.id`,
  );
  if (junkProduct.rowCount) {
    console.log(`cleanup: removed test product id=${junkProduct.rows.map((r) => r.id).join(',')}`);
  }

  // 2) Test customer "marta@gmail.com": QA signup, zero orders. Deleting the
  //    users row cascades to customers/cart/favorites/notifications. The guard
  //    on zero orders also matches the orders FK (no cascade) — a customer
  //    with real orders would raise instead of being silently removed.
  const junkCustomer = await pool.query(
    `DELETE FROM users u
     WHERE u.id = (SELECT user_id FROM customers WHERE email = 'marta@gmail.com')
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)
     RETURNING u.id`,
  );
  if (junkCustomer.rowCount) {
    console.log(`cleanup: removed test customer user_id=${junkCustomer.rows.map((r) => r.id).join(',')}`);
  }
}

cleanup()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Cleanup failed:', err);
    process.exit(1);
  });
