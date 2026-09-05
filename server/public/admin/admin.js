// Shared helpers for the admin panel. Plain JS, no build step, no framework —
// the panel is served same-origin by this backend so relative paths + cookies work.
async function api(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    credentials: 'include',
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    window.location.href = '/admin/login.html';
    throw new Error('Not authenticated');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function requireAuth() {
  try {
    const { isAdmin } = await api('/session');
    if (!isAdmin) window.location.href = '/admin/login.html';
  } catch {
    window.location.href = '/admin/login.html';
  }
}

function fmtMoney(v) {
  return `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderNav(active) {
  const items = [
    { href: '/admin/dashboard.html', label: 'Dashboard', key: 'dashboard' },
    { href: '/admin/index.html', label: 'Produtos', key: 'products' },
    { href: '/admin/inventory.html', label: 'Estoque', key: 'inventory' },
    { href: '/admin/categories.html', label: 'Categorias', key: 'categories' },
    { href: '/admin/feed.html', label: 'Feed', key: 'feed' },
    { href: '/admin/orders.html', label: 'Pedidos', key: 'orders' },
    { href: '/admin/coupons.html', label: 'Cupons', key: 'coupons' },
    { href: '/admin/shipping.html', label: 'Frete', key: 'shipping' },
    { href: '/admin/customers.html', label: 'Clientes', key: 'customers' },
  ];
  return items.map((i) => `<a href="${i.href}" class="${i.key === active ? 'active' : ''}">${i.label}</a>`).join('');
}

async function logout() {
  await api('/logout', { method: 'POST' });
  window.location.href = '/admin/login.html';
}
