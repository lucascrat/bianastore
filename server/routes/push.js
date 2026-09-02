const express = require('express');
const { requireUserId } = require('../middleware/user');
const push = require('../lib/push');

const router = express.Router();
router.use(requireUserId);

router.post('/subscribe', async (req, res, next) => {
  try {
    const { subscription } = req.body;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription payload' });
    }
    await push.saveSubscription(req.userId, subscription);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/subscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
    await push.removeSubscription(endpoint);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
