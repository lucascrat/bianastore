-- BianaStore schema. All statements are idempotent (IF NOT EXISTS) so this file
-- can be run on every deploy without special-casing "first run" vs "later runs".

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sub TEXT,
  price NUMERIC(10,2) NOT NULL,
  old_price NUMERIC(10,2),
  category_id INT REFERENCES categories(id) ON DELETE SET NULL,
  colors JSONB NOT NULL DEFAULT '[]',
  sizes JSONB NOT NULL DEFAULT '[]',
  description TEXT,
  rating NUMERIC(2,1) DEFAULT 0,
  reviews_count INT DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_images (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_primary BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON product_images(product_id);

-- Real stock, one row per (color, size) combination actually sold. A product
-- with no colors and/or no sizes gets '' for that column — every product
-- always has at least one variant row, even a single-option one like the
-- bag ("Único" size, no color choice at all).
CREATE TABLE IF NOT EXISTS product_variants (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  stock_qty INT NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(product_id, color, size)
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);

-- One-time-per-product backfill: creates a variant row for every
-- color×size combination a product currently has, defaulting to 20 units so
-- the storefront doesn't suddenly show everything as sold out the moment
-- this feature ships — the admin reviews/adjusts real counts from there.
-- ON CONFLICT DO NOTHING makes this safe to re-run on every deploy; it only
-- ever fills in gaps (e.g. a newly-added color), never resets stock that's
-- already been set for an existing combination.
INSERT INTO product_variants (product_id, color, size, stock_qty)
SELECT p.id, COALESCE(c.color, ''), COALESCE(s.size, ''), 20
FROM products p
LEFT JOIN LATERAL jsonb_array_elements_text(p.colors) AS c(color) ON true
LEFT JOIN LATERAL jsonb_array_elements_text(p.sizes) AS s(size) ON true
ON CONFLICT (product_id, color, size) DO NOTHING;

CREATE TABLE IF NOT EXISTS feed_items (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_url TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'image' CHECK (media_type IN ('image','video')),
  likes_count INT NOT NULL DEFAULT 0,
  comments_count INT NOT NULL DEFAULT 0,
  sale_badge TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, product_id, size)
);

-- Real per-variant (color × size) stock, added after the initial launch —
-- cart_items/order_items only tracked size until now. A product with no
-- explicit colors and/or sizes gets '' for that column, so every product has
-- at least one variant row regardless of how many options it has.
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '';
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_user_id_product_id_size_key;
DO $$ BEGIN
  ALTER TABLE cart_items ADD CONSTRAINT cart_items_user_product_size_color_key UNIQUE (user_id, product_id, size, color);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS favorites (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','shipping','delivered','cancelled')),
  status_label TEXT NOT NULL DEFAULT 'Processando',
  subtotal NUMERIC(10,2) NOT NULL,
  discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  shipping_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL,
  shipping_address JSONB NOT NULL,
  payment_method TEXT NOT NULL,
  shipping_method TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refunded')),
  payment_provider_id TEXT,
  pix_qr_code TEXT,
  installments INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

-- Real payments (Efí) were added after the initial launch — these columns
-- won't exist yet on an already-deployed database, so add them idempotently.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pix_qr_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS installments INT NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_discount NUMERIC(10,2) NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check CHECK (payment_status IN ('pending','paid','failed','refunded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Discount codes. discount_type 'percent' (discount_value 0-100) or 'fixed'
-- (a flat R$ amount). max_uses NULL = unlimited. uses_count is incremented
-- inside the same transaction that creates an order (see persistOrder in
-- orders.js), so it can never overcount past max_uses under concurrent use.
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value NUMERIC(10,2) NOT NULL,
  min_order_value NUMERIC(10,2) NOT NULL DEFAULT 0,
  max_uses INT,
  uses_count INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  product_name_snapshot TEXT NOT NULL,
  product_image_snapshot TEXT,
  size TEXT NOT NULL,
  qty INT NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL
);
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '';

-- Real shipping by destination region instead of one flat number regardless
-- of distance. `states` is a JSONB array of UF codes (e.g. ["SP","RJ"]) —
-- computeShippingCost() in orders.js looks up the zone containing the
-- customer's state. Admin-editable (see /admin/shipping.html); the defaults
-- below are just a sensible starting point, not tuned to any specific
-- carrier contract.
CREATE TABLE IF NOT EXISTS shipping_zones (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  states JSONB NOT NULL DEFAULT '[]',
  standard_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  standard_days INT NOT NULL DEFAULT 5,
  express_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  express_days INT NOT NULL DEFAULT 2,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO shipping_zones (name, states, standard_cost, standard_days, express_cost, express_days, sort_order)
SELECT * FROM (VALUES
  ('Sudeste', '["ES","MG","RJ","SP"]'::jsonb, 9.90, 3, 19.90, 1, 0),
  ('Sul', '["PR","RS","SC"]'::jsonb, 14.90, 5, 24.90, 2, 1),
  ('Centro-Oeste', '["DF","GO","MT","MS"]'::jsonb, 16.90, 6, 27.90, 3, 2),
  ('Nordeste', '["AL","BA","CE","MA","PB","PE","PI","RN","SE"]'::jsonb, 19.90, 8, 32.90, 4, 3),
  ('Norte', '["AC","AP","AM","PA","RO","RR","TO"]'::jsonb, 24.90, 12, 39.90, 6, 4)
) AS v(name, states, standard_cost, standard_days, express_cost, express_days, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM shipping_zones);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('sale','order','fav','promo')),
  icon TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  unread BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

CREATE TABLE IF NOT EXISTS media_assets (
  id SERIAL PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  content_type TEXT,
  size_bytes INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Real customer accounts. Extends a `users` row (the same anonymous id already
-- used for cart/favorites/orders) with login capability, so registering just
-- "upgrades" whatever anonymous id the browser already had — existing cart
-- contents carry over instead of being lost.
CREATE TABLE IF NOT EXISTS customers (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Real, persistent likes on feed items (one per customer per item). The
-- displayed count is this table's real count PLUS feed_items.likes_count,
-- which holds the seeded "social proof" baseline set at launch.
CREATE TABLE IF NOT EXISTS likes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feed_item_id INT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feed_item_id)
);

-- Comments require a real customer account (checked in the route, not here)
-- so every comment can show a real name + photo. Count shown to users is
-- always COUNT(*) on this table — no seeded baseline, so it never disagrees
-- with the actual list they see.
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  feed_item_id INT NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_feed_item ON comments(feed_item_id);

-- Web Push subscriptions (one browser/device can have several; a user can
-- have several devices). endpoint is unique per browser installation, so
-- re-subscribing (e.g. after clearing site data) just replaces the old row.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
