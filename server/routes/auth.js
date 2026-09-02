const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const pool = require('../db/pool');
const r2 = require('../lib/r2');
const { requireUserId } = require('../middleware/user');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype);
    cb(ok ? null : new Error('Envie uma imagem (jpg, png, webp ou gif)'), ok);
  },
});

function serializeCustomer(row) {
  return { userId: row.user_id, name: row.name, email: row.email, photoUrl: row.photo_url };
}

// Public avatar upload used by the registration/edit-profile screens (no
// admin session required — anyone filling out the signup form can use it).
router.post('/avatar', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    if (!r2.isConfigured()) {
      return res.status(503).json({ error: 'Upload de foto indisponível no momento.' });
    }
    const ext = path.extname(req.file.originalname) || '.jpg';
    const key = `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const url = await r2.uploadBuffer({ buffer: req.file.buffer, key, contentType: req.file.mimetype });
    res.status(201).json({ url });
  } catch (err) {
    if (err.code === 'R2_NOT_CONFIGURED') return res.status(503).json({ error: 'Upload de foto indisponível no momento.' });
    next(err);
  }
});

// Registration "upgrades" whatever anonymous X-User-Id the browser already
// has into a real customer — existing cart/favorites carry over unchanged.
router.post('/register', requireUserId, async (req, res, next) => {
  try {
    const { name, email, password, photoUrl } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
    }
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email inválido' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha precisa de pelo menos 6 caracteres' });

    const { rows: existing } = await pool.query('SELECT 1 FROM customers WHERE email = $1', [email.toLowerCase()]);
    if (existing.length) return res.status(409).json({ error: 'Já existe uma conta com esse email' });

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO customers (user_id, name, email, password_hash, photo_url)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.userId, name, email.toLowerCase(), passwordHash, photoUrl || null]
    );
    res.status(201).json(serializeCustomer(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma conta com esse email' });
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    const { rows } = await pool.query('SELECT * FROM customers WHERE email = $1', [String(email).toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'Email ou senha incorretos' });
    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Email ou senha incorretos' });
    res.json(serializeCustomer(rows[0]));
  } catch (err) {
    next(err);
  }
});

// Used at boot to check whether the current X-User-Id belongs to a real
// customer (vs. still-anonymous) and to hydrate the profile screen.
router.get('/me', requireUserId, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM customers WHERE user_id = $1', [req.userId]);
    res.json(rows.length ? serializeCustomer(rows[0]) : null);
  } catch (err) {
    next(err);
  }
});

router.put('/profile', requireUserId, async (req, res, next) => {
  try {
    const { name, photoUrl } = req.body;
    const { rows } = await pool.query(
      'UPDATE customers SET name = COALESCE($1, name), photo_url = COALESCE($2, photo_url), updated_at = now() WHERE user_id = $3 RETURNING *',
      [name || null, photoUrl || null, req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Conta não encontrada' });
    res.json(serializeCustomer(rows[0]));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
