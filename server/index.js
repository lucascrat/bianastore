const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');

const productsRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const favoritesRoutes = require('./routes/favorites');
const ordersRoutes = require('./routes/orders');
const notificationsRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const socialRoutes = require('./routes/social');
const pushRoutes = require('./routes/push');
const shippingRoutes = require('./routes/shipping');
const couponsRoutes = require('./routes/coupons');

const app = express();
app.set('trust proxy', 1); // behind Coolify/Traefik

// CORS_ORIGIN accepts a comma-separated list (e.g. production domain + a local
// dev server) so the same deployed API can be pointed at from local testing.
const allowedOrigins = (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  credentials: true,
}));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.get('/health', (req, res) => res.json({ ok: true }));

// Public, non-secret config the frontend needs at boot (Efí's "Identificador
// de Conta" is meant for client-side use, like a Stripe publishable key —
// exposing it here means the frontend never needs a redeploy when it's set).
app.get('/api/config', (req, res) => {
  res.json({
    efiAccountId: process.env.EFI_ACCOUNT_ID || null,
    efiSandbox: process.env.EFI_SANDBOX === 'true',
    paymentsEnabled: Boolean(process.env.EFI_CLIENT_ID && process.env.EFI_ACCOUNT_ID),
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
  });
});

app.use('/api', productsRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/feed', socialRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api/coupons', couponsRoutes);

app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BianaStore API listening on port ${PORT}`);
});
