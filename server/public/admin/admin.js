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

// Product reference code shown to admin and customers alike — just the
// product's own id (stable forever, never reused: products are soft-deleted,
// never actually removed from the table) formatted as "#01", "#02", ... No
// separate column/schema needed; this is purely a display convention.
function productCode(id) {
  return '#' + String(id).padStart(2, '0');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Curated palette of common clothing colors — used by the product-edit color
// picker and the Buscar screen's color filter. Only hex is ever stored on a
// product; the names here are just for display/labelling.
const COLOR_PALETTE = [
  { name: 'Preto', hex: '#191c1d' },
  { name: 'Branco', hex: '#FFFFFF' },
  { name: 'Cinza Claro', hex: '#C4C4C4' },
  { name: 'Cinza Chumbo', hex: '#4A4A4A' },
  { name: 'Bege', hex: '#E8DCC8' },
  { name: 'Nude', hex: '#E8C4A0' },
  { name: 'Marrom', hex: '#6B4423' },
  { name: 'Vinho', hex: '#6B1F2A' },
  { name: 'Vermelho', hex: '#C41E3A' },
  { name: 'Rosa Claro', hex: '#F5C2C7' },
  { name: 'Rosa Pink', hex: '#E91E8C' },
  { name: 'Laranja', hex: '#E8804A' },
  { name: 'Amarelo', hex: '#F0D264' },
  { name: 'Verde', hex: '#4A7856' },
  { name: 'Verde Militar', hex: '#6B7355' },
  { name: 'Azul Marinho', hex: '#1F3A5F' },
  { name: 'Azul Serenity', hex: '#A8C5D6' },
  { name: 'Roxo', hex: '#6B4A7A' },
  { name: 'Dourado', hex: '#C9A961' },
  { name: 'Prata', hex: '#C0C0C0' },
];

// Friendly name for a hex if it's in the palette, else the hex itself.
function colorName(hex) {
  const known = COLOR_PALETTE.find((c) => c.hex.toLowerCase() === String(hex).toLowerCase());
  return known ? known.name : hex;
}

function renderNav(active) {
  const items = [
    { href: '/admin/dashboard.html', label: 'Dashboard', key: 'dashboard' },
    { href: '/admin/index.html', label: 'Produtos', key: 'products' },
    { href: '/admin/search.html', label: 'Buscar', key: 'search' },
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
