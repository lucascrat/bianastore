// Gates /api/admin/* routes (except /login) behind an authenticated session.
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { requireAdmin };
