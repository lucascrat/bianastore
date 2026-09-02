// ─────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────
const API_BASE = 'https://bianastore-api.appbr.pro';

function getUserId() {
  let id = localStorage.getItem('bs_uid');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('bs_uid', id);
  }
  return id;
}

async function api(path, opts = {}) {
  // FormData bodies (file uploads) must NOT get a manual Content-Type — the
  // browser needs to set its own multipart boundary.
  const isFormData = opts.body instanceof FormData;
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      'X-User-Id': getUserId(),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro na requisição (${res.status})`);
  return data;
}

// ─────────────────────────────────────────────────────────
// DATA (populated from the API at boot — see loadInitialData())
// ─────────────────────────────────────────────────────────
let PRODUCTS = [];
let FEED_ITEMS = [];
let CATEGORIES = ['Todos'];
let NOTIFICATIONS = [];

// ─────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────
let currentScreen = 'feed';
let cart = []; // mirror of the server cart, loaded from /api/cart (see loadInitialData/refreshCart)
let favorites = new Set(); // product ids, loaded from /api/favorites
let activeCategory = 'Todos';
let selectedProduct = null;
let selectedSize = null;
let selectedColor = 0;
let currentCustomer = null; // {userId,name,email,photoUrl} once logged in, else null — see /api/auth/me
let authMode = 'login'; // 'login' | 'register', toggled on screen-auth
let authPhotoUrl = null; // photo uploaded during registration, before the account exists
let activeCommentsFeedItem = null; // feed item currently open on screen-comments

// ─────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────
const NAV_SCREENS = ['feed','shop','favorites','orders','profile'];
function navigateTo(screen, data) {
  // Deactivate all
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  // Activate
  document.getElementById('screen-' + screen)?.classList.add('active');
  if (NAV_SCREENS.includes(screen)) {
    document.getElementById('nav-' + screen)?.classList.add('active');
  }
  currentScreen = screen;
  // Scroll top-bar actions
  const leftIcon = document.getElementById('topBarLeftIcon');
  if (['product','cart','checkout','confirm','notifications','auth','comments'].includes(screen)) {
    leftIcon.textContent = 'arrow_back';
  } else {
    leftIcon.textContent = 'menu';
  }
  // Render
  if (screen === 'shop') renderShop();
  if (screen === 'cart') renderCart();
  if (screen === 'favorites') renderFavorites();
  if (screen === 'orders') renderOrders();
  if (screen === 'profile') renderProfile();
  if (screen === 'notifications') renderNotifications();
  if (screen === 'product' && data) { selectedProduct = data; selectedSize = data.sizes[1] || data.sizes[0]; selectedColor = 0; renderProductDetail(); }
  if (screen === 'checkout') renderCheckout();
  if (screen === 'confirm') renderConfirmation();
  if (screen === 'auth') renderAuth();
  if (screen === 'comments' && data) { activeCommentsFeedItem = data; renderComments(); }
}

function handleTopLeft() {
  const backs = ['product','cart','checkout','confirm','notifications','auth','comments'];
  if (backs.includes(currentScreen)) {
    history.back();
    // Simple back logic
    if (currentScreen === 'product') navigateTo('shop');
    else if (currentScreen === 'cart') navigateTo('shop');
    else if (currentScreen === 'checkout') navigateTo('cart');
    else if (currentScreen === 'confirm') navigateTo('shop');
    else if (currentScreen === 'notifications') navigateTo('profile');
    else if (currentScreen === 'auth') navigateTo('profile');
    else if (currentScreen === 'comments') navigateTo('feed');
  }
}

// Check URL param on load
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  if (view) navigateTo(view);
});

// ─────────────────────────────────────────────────────────
// FEED
// ─────────────────────────────────────────────────────────
function renderFeed() {
  const container = document.getElementById('feedContainer');
  container.innerHTML = FEED_ITEMS.map((item, i) => `
    <div class="feed-item" onclick="handleFeedTap(event, ${item.id}, ${i})">
      <div class="feed-bg" style="background-image:url('${item.bg}')"></div>
      <div class="feed-overlay"></div>
      ${item.sale ? `<div class="feed-sale-chip">${item.sale}</div>` : ''}
      <div class="feed-actions">
        <button class="feed-action-btn ${item.likedByMe ? 'liked' : ''}" id="feedLike${i}" onclick="event.stopPropagation();toggleFeedLike(${item.id}, ${i})">
          <div class="icon-circle">
            <span class="material-symbols-outlined" id="feedLikeIcon${i}" style="${item.likedByMe ? "font-variation-settings:'FILL' 1" : ''}">favorite</span>
          </div>
          <span id="feedLikeCount${i}">${item.likes}</span>
        </button>
        <button class="feed-action-btn" onclick="event.stopPropagation();navigateTo('comments', FEED_ITEMS.find(f=>f.id==${item.id}))">
          <div class="icon-circle"><span class="material-symbols-outlined">chat_bubble</span></div>
          <span id="feedCommentCount${i}">${item.comments}</span>
        </button>
        <button class="feed-action-btn" onclick="event.stopPropagation();handleShare(${item.product.id})">
          <div class="icon-circle"><span class="material-symbols-outlined">share</span></div>
          <span>Compartilhar</span>
        </button>
      </div>
      <div class="feed-product-card" onclick="event.stopPropagation();navigateTo('product', PRODUCTS.find(p=>p.id==${item.product.id}))">
        <div class="feed-product-name">${item.product.name}</div>
        <div class="feed-prices">
          <span class="feed-price">R$ ${item.product.price.toFixed(2).replace('.',',')}</span>
          ${item.product.oldPrice ? `<span class="feed-price-old">R$ ${item.product.oldPrice.toFixed(2).replace('.',',')}</span>` : ''}
        </div>
        <button class="feed-buy-btn" onclick="event.stopPropagation();quickAddToCart(${item.product.id})">
          COMPRAR AGORA
        </button>
      </div>
    </div>
  `).join('');
}

// Double-tap-to-like on the media itself (Instagram-style big heart burst),
// plus the sidebar like button spawns floating hearts on every like — see
// toggleFeedLike below.
const lastFeedTapAt = {};
function handleFeedTap(e, feedItemId, i) {
  const now = Date.now();
  const last = lastFeedTapAt[feedItemId] || 0;
  lastFeedTapAt[feedItemId] = now;
  if (now - last > 300) return; // single tap — nothing to do
  lastFeedTapAt[feedItemId] = 0; // consume so a 3rd rapid tap isn't a "double" again
  const feedItemEl = e.currentTarget;
  spawnBigHeart(feedItemEl);
  const item = FEED_ITEMS.find(f => f.id === feedItemId);
  if (item && !item.likedByMe) toggleFeedLike(feedItemId, i); // never unlikes on double-tap
}

function spawnBigHeart(feedItemEl) {
  const heart = document.createElement('span');
  heart.className = 'material-symbols-outlined big-heart-burst';
  heart.style.fontVariationSettings = "'FILL' 1";
  heart.textContent = 'favorite';
  feedItemEl.appendChild(heart);
  heart.addEventListener('animationend', () => heart.remove());
}

function spawnFloatingHearts(feedItemEl, count = 6) {
  for (let n = 0; n < count; n++) {
    setTimeout(() => {
      const heart = document.createElement('span');
      heart.className = 'material-symbols-outlined floating-heart';
      heart.style.fontVariationSettings = "'FILL' 1";
      heart.style.setProperty('--drift', Math.round(Math.random() * 70 - 35) + 'px');
      heart.style.setProperty('--rot', Math.round(Math.random() * 40 - 20) + 'deg');
      heart.style.right = (8 + Math.random() * 24) + 'px';
      heart.textContent = 'favorite';
      feedItemEl.appendChild(heart);
      heart.addEventListener('animationend', () => heart.remove());
    }, n * 90);
  }
}

function formatCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

async function toggleFeedLike(feedItemId, i) {
  const btn = document.getElementById('feedLike' + i);
  const icon = document.getElementById('feedLikeIcon' + i);
  const countEl = document.getElementById('feedLikeCount' + i);
  const iconCircle = btn.querySelector('.icon-circle');
  try {
    const { liked, likesCount } = await api(`/api/feed/${feedItemId}/like/toggle`, { method: 'POST' });
    btn.classList.toggle('liked', liked);
    icon.style.fontVariationSettings = liked ? "'FILL' 1" : '';
    countEl.textContent = formatCount(likesCount);
    const item = FEED_ITEMS.find(f => f.id === feedItemId);
    if (item) { item.likedByMe = liked; item.likes = formatCount(likesCount); }
    if (liked) {
      // Instagram/TikTok-style feedback: the heart pops, and a little burst
      // of hearts floats up from the button and fades out.
      iconCircle.classList.remove('pop');
      void iconCircle.offsetWidth; // restart the animation even if it's already mid-pop
      iconCircle.classList.add('pop');
      spawnFloatingHearts(btn.closest('.feed-item'));
    }
  } catch (err) {
    showToast('Erro ao curtir: ' + err.message);
  }
}

function handleShare(productId) {
  const p = PRODUCTS.find(x => x.id === productId);
  if (navigator.share) {
    navigator.share({ title: p.name + ' — BianaStore', text: `Olha que lindo: ${p.name} por R$ ${p.price},00!`, url: location.href });
  } else {
    showToast('Link copiado!');
  }
}

// ─────────────────────────────────────────────────────────
// SHOP
// ─────────────────────────────────────────────────────────
function renderShop() {
  // Categories
  const chips = document.getElementById('categoryChips');
  chips.innerHTML = CATEGORIES.map(c => `
    <button class="chip ${c === activeCategory ? 'active' : ''}" onclick="setCategory('${c}')">${c}</button>
  `).join('');
  // Products
  const grid = document.getElementById('productsGrid');
  const filtered = activeCategory === 'Todos' ? PRODUCTS : PRODUCTS.filter(p => p.cat === activeCategory);
  grid.innerHTML = filtered.map(p => `
    <div class="product-card" onclick="navigateTo('product', PRODUCTS.find(x=>x.id==${p.id}))">
      <div class="product-card-img-wrap">
        <img class="product-card-img" src="${p.img}" alt="${p.name}" loading="lazy"/>
        <button class="product-card-fav ${favorites.has(p.id) ? 'active' : ''}" onclick="event.stopPropagation();toggleFav(${p.id})" id="fav-card-${p.id}">
          <span class="material-symbols-outlined" style="font-variation-settings:'FILL' ${favorites.has(p.id)?1:0}">${favorites.has(p.id)?'favorite':'favorite_border'}</span>
        </button>
        <div class="product-card-badge">R$ ${p.price.toFixed(2).replace('.',',')}</div>
      </div>
      <div class="product-card-info">
        <div class="product-card-name">${p.name}</div>
        <div class="product-card-sub">${p.sub}</div>
        <span class="product-card-price">R$ ${p.price.toFixed(2).replace('.',',')}</span>
        ${p.oldPrice ? `<span class="product-card-old">R$ ${p.oldPrice.toFixed(2).replace('.',',')}</span>` : ''}
      </div>
    </div>
  `).join('');
}

function setCategory(cat) {
  activeCategory = cat;
  renderShop();
}

async function toggleFav(id) {
  // Optimistic update first, then reconcile with the server.
  const wasFavorited = favorites.has(id);
  if (wasFavorited) { favorites.delete(id); showToast('Removido dos favoritos'); }
  else { favorites.add(id); showToast('❤️ Salvo nos favoritos!'); }
  const btn = document.getElementById('fav-card-'+id);
  if (btn) {
    btn.classList.toggle('active', favorites.has(id));
    btn.querySelector('.material-symbols-outlined').textContent = favorites.has(id) ? 'favorite' : 'favorite_border';
    btn.querySelector('.material-symbols-outlined').style.fontVariationSettings = `'FILL' ${favorites.has(id)?1:0}`;
  }
  try {
    await api(`/api/favorites/${id}/toggle`, { method: 'POST' });
  } catch (err) {
    // Roll back on failure
    if (wasFavorited) favorites.add(id); else favorites.delete(id);
    showToast('Erro ao favoritar: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────
// PRODUCT DETAIL
// ─────────────────────────────────────────────────────────
function renderProductDetail() {
  const p = selectedProduct;
  if (!p) return;
  const content = document.getElementById('productDetailContent');
  content.innerHTML = `
    <div class="detail-gallery">
      <img src="${p.img}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover"/>
      <div class="detail-back" onclick="navigateTo('shop')">
        <span class="material-symbols-outlined">arrow_back</span>
      </div>
      <div class="detail-gallery-dots">
        <span class="active"></span><span></span><span></span>
      </div>
    </div>
    <div class="detail-body">
      <div class="reviews-row">
        <span class="stars">${'★'.repeat(Math.floor(p.rating))}${p.rating%1>=0.5?'½':''}</span>
        <span class="reviews-count">${p.rating} (${p.reviews} avaliações)</span>
      </div>
      <h2 class="detail-name">${p.name}</h2>
      <p class="detail-sub">${p.sub}</p>
      <div class="detail-prices">
        <span class="detail-price">R$ ${p.price.toFixed(2).replace('.',',')}</span>
        ${p.oldPrice ? `<span class="detail-price-old">R$ ${p.oldPrice.toFixed(2).replace('.',',')}</span>` : ''}
        ${p.oldPrice ? `<span style="font-size:13px;color:#1A7B45;font-weight:700;background:#E6F7EE;padding:2px 8px;border-radius:99px;">${Math.round((1-p.price/p.oldPrice)*100)}% OFF</span>` : ''}
      </div>

      ${p.colors.length > 1 ? `
      <div class="section-label">Cor</div>
      <div class="color-row" id="colorRow">
        ${p.colors.map((c,i) => `
          <div class="color-swatch ${i===selectedColor?'active':''}" style="background:${c}" onclick="selectColor(${i})" id="color-swatch-${i}"></div>
        `).join('')}
      </div>` : ''}

      <div class="section-label">Tamanho <button style="font-size:12px;color:var(--primary);font-weight:600;margin-left:8px;cursor:pointer" onclick="showToast('Guia de medidas em breve!')">Guia</button></div>
      <div class="size-row" id="sizeRow">
        ${p.sizes.map(s => `
          <button class="size-btn ${s===selectedSize?'active':''}" onclick="selectSize('${s}')" id="size-btn-${s}">${s}</button>
        `).join('')}
      </div>

      <div class="section-label">Descrição</div>
      <p class="detail-desc">${p.desc}</p>

      <div style="display:flex;gap:8px;margin-bottom:16px">
        <div style="flex:1;background:var(--surface-container-low);border-radius:12px;padding:12px;text-align:center">
          <span class="material-symbols-outlined" style="font-size:22px;color:var(--primary)">local_shipping</span>
          <div style="font-size:12px;color:var(--on-surface-variant);margin-top:4px">Frete grátis<br>acima R$ 299</div>
        </div>
        <div style="flex:1;background:var(--surface-container-low);border-radius:12px;padding:12px;text-align:center">
          <span class="material-symbols-outlined" style="font-size:22px;color:var(--primary)">autorenew</span>
          <div style="font-size:12px;color:var(--on-surface-variant);margin-top:4px">Troca grátis<br>em 30 dias</div>
        </div>
        <div style="flex:1;background:var(--surface-container-low);border-radius:12px;padding:12px;text-align:center">
          <span class="material-symbols-outlined" style="font-size:22px;color:var(--primary)">verified</span>
          <div style="font-size:12px;color:var(--on-surface-variant);margin-top:4px">Compra<br>segura</div>
        </div>
      </div>
    </div>

    <button class="detail-add-btn" onclick="addToCart(${p.id})">
      <span class="material-symbols-outlined">shopping_bag</span>
      Adicionar à Sacola
    </button>
  `;
}

function selectSize(s) {
  selectedSize = s;
  document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('size-btn-'+s)?.classList.add('active');
}

function selectColor(i) {
  selectedColor = i;
  document.querySelectorAll('.color-swatch').forEach((s,j) => s.classList.toggle('active', j===i));
}

// ─────────────────────────────────────────────────────────
// CART
// ─────────────────────────────────────────────────────────
async function refreshCart() {
  cart = await api('/api/cart');
  updateCartBadge();
}

async function addToCart(productId) {
  if (!selectedSize) { showToast('Selecione um tamanho!'); return; }
  try {
    cart = await api('/api/cart', { method: 'POST', body: JSON.stringify({ productId, size: selectedSize, qty: 1 }) });
    showToast('✅ Adicionado à sacola!');
    updateCartBadge();
  } catch (err) {
    showToast('Erro ao adicionar: ' + err.message);
  }
}

async function quickAddToCart(productId) {
  try {
    cart = await api('/api/cart', { method: 'POST', body: JSON.stringify({ productId, size: 'M', qty: 1 }) });
    showToast('✅ Adicionado à sacola!');
    updateCartBadge();
  } catch (err) {
    showToast('Erro ao adicionar: ' + err.message);
  }
}

function updateCartBadge() {
  const dot = document.getElementById('cartDot');
  const total = cart.reduce((s, i) => s + i.qty, 0);
  dot.style.display = total > 0 ? 'block' : 'none';
}

async function changeQty(key, delta) {
  const item = cart.find(i => i.key === key);
  if (!item) return;
  const newQty = Math.max(0, item.qty + delta);
  try {
    cart = await api('/api/cart', { method: 'PATCH', body: JSON.stringify({ productId: item.productId, size: item.size, qty: newQty }) });
    updateCartBadge();
    renderCart();
  } catch (err) {
    showToast('Erro ao atualizar quantidade: ' + err.message);
  }
}

async function removeCartItem(key) {
  const item = cart.find(i => i.key === key);
  if (!item) return;
  try {
    cart = await api('/api/cart', { method: 'DELETE', body: JSON.stringify({ productId: item.productId, size: item.size }) });
    updateCartBadge();
    renderCart();
    showToast('Item removido');
  } catch (err) {
    showToast('Erro ao remover: ' + err.message);
  }
}

function getCartTotals() {
  let sub = 0, discount = 0;
  cart.forEach(ci => {
    sub += ci.price * ci.qty;
    if (ci.oldPrice) discount += (ci.oldPrice - ci.price) * ci.qty;
  });
  return { sub, discount, total: sub };
}

function renderCart() {
  const content = document.getElementById('cartContent');
  const count = cart.reduce((s,i) => s + i.qty, 0);
  if (cart.length === 0) {
    content.innerHTML = `
      <div class="cart-header"><h2 class="cart-title">Minha Sacola</h2></div>
      <div class="cart-empty">
        <span class="material-symbols-outlined">shopping_bag</span>
        <h3>Sacola vazia</h3>
        <p>Adicione produtos incríveis ao seu carrinho</p>
        <button style="margin-top:8px;padding:12px 24px;border-radius:99px;background:var(--primary);color:#fff;font-weight:700;font-family:'Plus Jakarta Sans',sans-serif" onclick="navigateTo('shop')">Explorar produtos</button>
      </div>`;
    return;
  }
  const { sub, discount, total } = getCartTotals();
  const fmt = v => `R$ ${v.toFixed(2).replace('.',',')}`;
  const itemsHtml = cart.map(ci => {
    return `
      <div class="cart-item">
        <img class="cart-item-img" src="${ci.img}" alt="${ci.name}" loading="lazy"/>
        <div class="cart-item-body">
          <div>
            <div class="cart-item-name">${ci.name}</div>
            <div class="cart-item-variant">Tamanho: ${ci.size}</div>
          </div>
          <div>
            ${ci.oldPrice ? `<div class="cart-item-price-old">${fmt(ci.oldPrice)}</div>` : ''}
            <div class="cart-item-price">${fmt(ci.price * ci.qty)}</div>
          </div>
          <div class="cart-item-footer">
            <div class="qty-control">
              <button class="qty-btn" onclick="changeQty('${ci.key}', -1)">
                <span class="material-symbols-outlined">remove</span>
              </button>
              <span class="qty-val">${ci.qty}</span>
              <button class="qty-btn" onclick="changeQty('${ci.key}', 1)">
                <span class="material-symbols-outlined">add</span>
              </button>
            </div>
            <button class="cart-remove-btn" onclick="removeCartItem('${ci.key}')">
              <span class="material-symbols-outlined">delete_outline</span>
            </button>
          </div>
        </div>
      </div>`;
  }).join('');

  content.innerHTML = `
    <div class="cart-header">
      <h2 class="cart-title">Minha Sacola</h2>
      <span class="cart-count">${count} ${count===1?'item':'itens'}</span>
    </div>
    ${itemsHtml}
    <div class="cart-summary">
      <div class="cart-summary-title">Resumo do Pedido</div>
      <div class="cart-row"><span>Subtotal</span><span>${fmt(sub)}</span></div>
      ${discount > 0 ? `<div class="cart-row"><span>Desconto</span><span class="discount">− ${fmt(discount)}</span></div>` : ''}
      <div class="cart-row"><span>Frete</span><span style="color:var(--primary);font-weight:600">${total >= 299 ? 'Grátis 🎉' : 'A calcular'}</span></div>
      <div class="cart-row total"><span>Total</span><span class="price">${fmt(total)}</span></div>
      <button class="cart-checkout-btn" onclick="navigateTo('checkout')">
        Finalizar Compra <span class="material-symbols-outlined">arrow_forward</span>
      </button>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// CHECKOUT
// ─────────────────────────────────────────────────────────
function renderCheckout() {
  const content = document.getElementById('checkoutContent');
  const { total } = getCartTotals();
  const fmt = v => `R$ ${v.toFixed(2).replace('.',',')}`;
  content.innerHTML = `
    <div style="padding:16px 16px 8px">
      <h2 style="font-family:'Plus Jakarta Sans',sans-serif;font-size:22px;font-weight:700;color:var(--on-background)">Finalizar Compra</h2>
    </div>

    <div class="checkout-section">
      <div class="checkout-section-header">
        <span class="material-symbols-outlined">location_on</span>
        <span class="checkout-section-title">Endereço de Entrega</span>
      </div>
      <div class="checkout-field">
        <label>CEP</label>
        <input type="text" id="addr-cep" placeholder="00000-000" inputmode="numeric" maxlength="9"/>
      </div>
      <div class="checkout-field">
        <label>Rua / Avenida</label>
        <input type="text" id="addr-street" placeholder="Ex: Rua das Flores, 123"/>
      </div>
      <div style="display:flex">
        <div class="checkout-field" style="flex:1">
          <label>Número</label>
          <input type="text" id="addr-number" placeholder="123" inputmode="numeric"/>
        </div>
        <div class="checkout-field" style="flex:2">
          <label>Complemento</label>
          <input type="text" id="addr-complement" placeholder="Apto, bloco…"/>
        </div>
      </div>
      <div class="checkout-field">
        <label>Bairro</label>
        <input type="text" id="addr-neighborhood" placeholder="Seu bairro"/>
      </div>
      <div style="display:flex">
        <div class="checkout-field" style="flex:2">
          <label>Cidade</label>
          <input type="text" id="addr-city" placeholder="São Paulo"/>
        </div>
        <div class="checkout-field" style="flex:1">
          <label>Estado</label>
          <input type="text" id="addr-state" placeholder="SP" maxlength="2"/>
        </div>
      </div>
    </div>

    <div class="checkout-section">
      <div class="checkout-section-header">
        <span class="material-symbols-outlined">payment</span>
        <span class="checkout-section-title">Forma de Pagamento</span>
      </div>
      <div class="payment-options">
        <label class="payment-option">
          <input type="radio" name="payment" value="pix" checked/>
          <span class="material-symbols-outlined">qr_code_2</span>
          <span class="payment-option-label">PIX — 5% de desconto</span>
        </label>
        <label class="payment-option">
          <input type="radio" name="payment" value="credit"/>
          <span class="material-symbols-outlined">credit_card</span>
          <span class="payment-option-label">Cartão de Crédito</span>
        </label>
        <label class="payment-option">
          <input type="radio" name="payment" value="boleto"/>
          <span class="material-symbols-outlined">receipt_long</span>
          <span class="payment-option-label">Boleto Bancário</span>
        </label>
      </div>
    </div>

    <div class="checkout-section">
      <div class="checkout-section-header">
        <span class="material-symbols-outlined">local_shipping</span>
        <span class="checkout-section-title">Opção de Entrega</span>
      </div>
      <label class="payment-option">
        <input type="radio" name="shipping" value="express" checked/>
        <span class="material-symbols-outlined">bolt</span>
        <span class="payment-option-label">Expresso — Amanhã</span>
        <span style="font-size:13px;font-weight:700;color:var(--primary)">R$ 14,90</span>
      </label>
      <label class="payment-option">
        <input type="radio" name="shipping" value="standard"/>
        <span class="material-symbols-outlined">local_shipping</span>
        <span class="payment-option-label">Padrão — 3-5 dias</span>
        <span style="font-size:13px;font-weight:700;color:#1A7B45">${total >= 299 ? 'Grátis' : 'R$ 9,90'}</span>
      </label>
    </div>

    <div style="height:120px"></div>

    <div class="checkout-total-bar">
      <div class="checkout-total-row">
        <span class="checkout-total-label">Total do pedido</span>
        <span class="checkout-total-val">${fmt(total)}</span>
      </div>
      <button class="checkout-confirm-btn" id="checkoutConfirmBtn" onclick="placeOrder()">
        <span class="material-symbols-outlined">lock</span>
        Confirmar Pedido
      </button>
    </div>
  `;
}

let lastOrder = null;

async function placeOrder() {
  const btn = document.getElementById('checkoutConfirmBtn');
  const val = (id) => document.getElementById(id)?.value?.trim() || '';
  const shippingAddress = {
    cep: val('addr-cep'),
    street: val('addr-street'),
    number: val('addr-number'),
    complement: val('addr-complement'),
    neighborhood: val('addr-neighborhood'),
    city: val('addr-city'),
    state: val('addr-state'),
  };
  if (!shippingAddress.street || !shippingAddress.city) {
    showToast('Preencha o endereço de entrega!');
    return;
  }
  const paymentMethod = document.querySelector('input[name="payment"]:checked')?.value || 'pix';
  const shippingMethod = document.querySelector('input[name="shipping"]:checked')?.value || 'standard';

  btn.disabled = true;
  try {
    lastOrder = await api('/api/orders', {
      method: 'POST',
      body: JSON.stringify({ shippingAddress, paymentMethod, shippingMethod }),
    });
    cart = [];
    updateCartBadge();
    navigateTo('confirm');
  } catch (err) {
    showToast('Erro ao confirmar pedido: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────
// CONFIRMATION
// ─────────────────────────────────────────────────────────
function renderConfirmation() {
  const orderId = lastOrder ? lastOrder.id : '—';
  document.getElementById('confirmContent').innerHTML = `
    <div class="confirm-screen">
      <div class="confirm-icon-wrap">
        <span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1">check_circle</span>
      </div>
      <h2 class="confirm-title">Pedido confirmado! 🎉</h2>
      <p class="confirm-sub">Seu pedido foi recebido e está sendo preparado com muito carinho pela BianaStore.</p>
      <div class="confirm-order-box">
        <div class="confirm-order-num">NÚMERO DO PEDIDO</div>
        <div class="confirm-order-id">#${orderId}</div>
        <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--on-surface-variant)">
            <span class="material-symbols-outlined" style="font-size:18px;color:var(--primary)">local_shipping</span>
            Entrega prevista: <strong style="color:var(--on-surface)">amanhã</strong>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--on-surface-variant)">
            <span class="material-symbols-outlined" style="font-size:18px;color:var(--primary)">notifications</span>
            Acompanhe pelo app ou e-mail
          </div>
        </div>
      </div>
      <div class="confirm-btn-row">
        <button class="confirm-primary-btn" onclick="navigateTo('orders')">Ver Meus Pedidos</button>
        <button class="confirm-secondary-btn" onclick="navigateTo('feed')">Continuar Comprando</button>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// FAVORITES
// ─────────────────────────────────────────────────────────
async function renderFavorites() {
  const content = document.getElementById('favContent');
  let favProducts = [];
  try {
    favProducts = await api('/api/favorites');
    favorites = new Set(favProducts.map(p => p.id));
  } catch (err) {
    content.innerHTML = `<div class="cart-empty"><p>Erro ao carregar favoritos: ${err.message}</p></div>`;
    return;
  }
  if (favProducts.length === 0) {
    content.innerHTML = `
      <div class="screen-header"><h2 class="screen-title">Favoritos</h2></div>
      <div class="cart-empty">
        <span class="material-symbols-outlined">favorite_border</span>
        <h3>Nenhum favorito ainda</h3>
        <p>Salve os produtos que você ama para encontrar facilmente depois</p>
        <button style="margin-top:8px;padding:12px 24px;border-radius:99px;background:var(--primary);color:#fff;font-weight:700;font-family:'Plus Jakarta Sans',sans-serif" onclick="navigateTo('shop')">Descobrir produtos</button>
      </div>`;
    return;
  }
  content.innerHTML = `
    <div class="screen-header"><h2 class="screen-title">Favoritos</h2></div>
    <div class="products-grid" style="padding:12px">
      ${favProducts.map(p => `
        <div class="product-card" onclick="navigateTo('product', PRODUCTS.find(x=>x.id==${p.id}))">
          <div class="product-card-img-wrap">
            <img class="product-card-img" src="${p.img}" alt="${p.name}" loading="lazy"/>
            <button class="product-card-fav active" onclick="event.stopPropagation();toggleFav(${p.id}).then(renderFavorites)">
              <span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1">favorite</span>
            </button>
            <div class="product-card-badge">R$ ${p.price.toFixed(2).replace('.',',')}</div>
          </div>
          <div class="product-card-info">
            <div class="product-card-name">${p.name}</div>
            <div class="product-card-sub">${p.sub}</div>
            <span class="product-card-price">R$ ${p.price.toFixed(2).replace('.',',')}</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────
async function renderOrders() {
  const content = document.getElementById('ordersContent');
  let orders = [];
  try {
    orders = await api('/api/orders');
  } catch (err) {
    content.innerHTML = `<div class="screen-header"><h2 class="screen-title">Meus Pedidos</h2></div><div class="cart-empty"><p>Erro ao carregar pedidos: ${err.message}</p></div>`;
    return;
  }
  if (orders.length === 0) {
    content.innerHTML = `
      <div class="screen-header"><h2 class="screen-title">Meus Pedidos</h2></div>
      <div class="cart-empty">
        <span class="material-symbols-outlined">package_2</span>
        <h3>Nenhum pedido ainda</h3>
        <p>Seus pedidos vão aparecer aqui depois da primeira compra</p>
        <button style="margin-top:8px;padding:12px 24px;border-radius:99px;background:var(--primary);color:#fff;font-weight:700;font-family:'Plus Jakarta Sans',sans-serif" onclick="navigateTo('shop')">Explorar produtos</button>
      </div>`;
    return;
  }
  content.innerHTML = `
    <div class="screen-header"><h2 class="screen-title">Meus Pedidos</h2></div>
    ${orders.map(o => `
      <div class="order-card" onclick="showToast('Pedido ${o.id}')">
        <div class="order-card-header">
          <div>
            <div class="order-num">Pedido #${o.id}</div>
            <div class="order-date">${o.date}</div>
          </div>
          <span class="order-status ${o.status}">${o.statusLabel}</span>
        </div>
        <div class="order-items-preview">
          ${o.items.map(img => `<img class="order-thumb" src="${img}" alt="item"/>`).join('')}
          ${o.items_count > o.items.length ? `<div class="order-thumb" style="display:flex;align-items:center;justify-content:center;background:var(--surface-container);color:var(--on-surface-variant);font-weight:700;font-size:14px">+${o.items_count - o.items.length}</div>` : ''}
        </div>
        <div class="order-card-footer">
          <span style="font-size:13px;color:var(--on-surface-variant)">${o.items_count} ${o.items_count===1?'item':'itens'}</span>
          <span class="order-total">${o.total}</span>
        </div>
      </div>
    `).join('')}
  `;
}

// ─────────────────────────────────────────────────────────
// PROFILE
// ─────────────────────────────────────────────────────────
async function renderProfile() {
  const content = document.getElementById('profileContent');
  let ordersCount = 0;
  try { ordersCount = (await api('/api/orders')).length; } catch { /* keep 0 on error */ }

  const loggedIn = Boolean(currentCustomer);
  const initial = loggedIn ? currentCustomer.name.trim().charAt(0).toUpperCase() : '?';
  const avatarHtml = loggedIn && currentCustomer.photoUrl
    ? `<img src="${currentCustomer.photoUrl}" style="width:100%;height:100%;object-fit:cover"/>`
    : initial;

  content.innerHTML = `
    <div class="profile-hero">
      <div class="profile-avatar">${avatarHtml}</div>
      <div class="profile-name">${loggedIn ? escapeHtml(currentCustomer.name) : 'Visitante'}</div>
      <div class="profile-email">${loggedIn ? escapeHtml(currentCustomer.email) : 'Faça login para salvar seus dados'}</div>
      ${!loggedIn ? `<button style="margin-top:8px;padding:10px 24px;border-radius:99px;background:#fff;color:var(--primary);font-weight:700;font-family:'Plus Jakarta Sans',sans-serif" onclick="navigateTo('auth')">Entrar / Criar conta</button>` : ''}
    </div>
    <div class="profile-stats">
      <div class="profile-stat">
        <div class="profile-stat-val">${ordersCount}</div>
        <div class="profile-stat-label">Pedidos</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-val">${favorites.size}</div>
        <div class="profile-stat-label">Favoritos</div>
      </div>
      <div class="profile-stat">
        <div class="profile-stat-val">120</div>
        <div class="profile-stat-label">Pontos</div>
      </div>
    </div>
    <div class="profile-menu">
      <div class="profile-section-title">Conta</div>
      <div class="profile-menu-item" onclick="navigateTo('orders')">
        <span class="material-symbols-outlined">package_2</span>
        <span class="profile-menu-item-label">Meus Pedidos</span>
        <span class="material-symbols-outlined arrow">chevron_right</span>
      </div>
      <div class="profile-menu-item" onclick="navigateTo('favorites')">
        <span class="material-symbols-outlined">favorite</span>
        <span class="profile-menu-item-label">Favoritos</span>
        <span class="material-symbols-outlined arrow">chevron_right</span>
      </div>
      <div class="profile-menu-item" onclick="navigateTo('notifications')">
        <span class="material-symbols-outlined">notifications</span>
        <span class="profile-menu-item-label">Notificações</span>
        <span class="material-symbols-outlined arrow">chevron_right</span>
      </div>
      <div class="profile-section-title" style="margin-top:16px">Configurações</div>
      <div class="profile-menu-item" onclick="showToast('Endereços em breve!')">
        <span class="material-symbols-outlined">location_on</span>
        <span class="profile-menu-item-label">Meus Endereços</span>
        <span class="material-symbols-outlined arrow">chevron_right</span>
      </div>
      <div class="profile-menu-item" onclick="showToast('Pagamentos em breve!')">
        <span class="material-symbols-outlined">payment</span>
        <span class="profile-menu-item-label">Métodos de Pagamento</span>
        <span class="material-symbols-outlined arrow">chevron_right</span>
      </div>
      <div class="profile-menu-item" onclick="requestPushPermission()">
        <span class="material-symbols-outlined">notifications_active</span>
        <span class="profile-menu-item-label">Ativar Notificações Push</span>
        <span class="material-symbols-outlined arrow">chevron_right</span>
      </div>
      ${loggedIn ? `
      <div class="profile-menu-item" onclick="logoutCustomer()">
        <span class="material-symbols-outlined" style="color:var(--error)">logout</span>
        <span class="profile-menu-item-label" style="color:var(--error)">Sair</span>
      </div>` : `
      <div class="profile-menu-item" onclick="navigateTo('auth')">
        <span class="material-symbols-outlined" style="color:var(--primary)">login</span>
        <span class="profile-menu-item-label" style="color:var(--primary)">Entrar / Criar conta</span>
      </div>`}
    </div>
  `;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─────────────────────────────────────────────────────────
// AUTH (login / cadastro)
// ─────────────────────────────────────────────────────────
function renderAuth() {
  const content = document.getElementById('authContent');
  content.innerHTML = `
    <div class="auth-tabs">
      <div class="auth-tab ${authMode === 'login' ? 'active' : ''}" onclick="switchAuthMode('login')">Entrar</div>
      <div class="auth-tab ${authMode === 'register' ? 'active' : ''}" onclick="switchAuthMode('register')">Criar conta</div>
    </div>
    ${authMode === 'register' ? `
      <div class="auth-avatar-upload" onclick="document.getElementById('authPhotoInput').click()">
        ${authPhotoUrl ? `<img src="${authPhotoUrl}"/>` : `<span class="material-symbols-outlined">add_a_photo</span>`}
      </div>
      <div class="auth-avatar-hint">Foto de perfil (opcional)</div>
      <input type="file" id="authPhotoInput" accept="image/*" style="display:none" onchange="handleAuthPhotoUpload(event)"/>
      <div class="checkout-section">
        <div class="checkout-field"><label>Nome</label><input type="text" id="auth-name" placeholder="Seu nome"/></div>
        <div class="checkout-field"><label>Email</label><input type="email" id="auth-email" placeholder="voce@email.com"/></div>
        <div class="checkout-field"><label>Senha</label><input type="password" id="auth-password" placeholder="Mínimo 6 caracteres"/></div>
      </div>
    ` : `
      <div class="checkout-section" style="margin-top:20px">
        <div class="checkout-field"><label>Email</label><input type="email" id="auth-email" placeholder="voce@email.com"/></div>
        <div class="checkout-field"><label>Senha</label><input type="password" id="auth-password" placeholder="Sua senha"/></div>
      </div>
    `}
    <div id="authError" class="auth-error hidden"></div>
    <div style="padding:16px">
      <button class="checkout-confirm-btn" id="authSubmitBtn" onclick="submitAuth()">${authMode === 'register' ? 'Criar conta' : 'Entrar'}</button>
    </div>
  `;
}

function switchAuthMode(mode) {
  authMode = mode;
  renderAuth();
}

async function handleAuthPhotoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const { url } = await api('/api/auth/avatar', { method: 'POST', body: form });
    authPhotoUrl = url;
    renderAuth();
  } catch (err) {
    showToast('Erro ao enviar foto: ' + err.message);
  }
}

async function submitAuth() {
  const errEl = document.getElementById('authError');
  errEl.classList.add('hidden');
  const btn = document.getElementById('authSubmitBtn');
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  btn.disabled = true;
  try {
    let customer;
    if (authMode === 'register') {
      const name = document.getElementById('auth-name').value.trim();
      if (!name) throw new Error('Digite seu nome');
      customer = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password, photoUrl: authPhotoUrl }) });
    } else {
      customer = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    }
    currentCustomer = customer;
    // Adopt the customer's persistent id — cart/favorites/orders made anonymously
    // before login stay attached to it, and logging in from another browser
    // pulls in this same customer's data since it's the same id server-side.
    localStorage.setItem('bs_uid', customer.userId);
    authPhotoUrl = null;
    showToast(authMode === 'register' ? '🎉 Conta criada!' : `Bem-vinda de volta, ${customer.name}!`);
    await refreshCart();
    navigateTo('profile');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

function logoutCustomer() {
  currentCustomer = null;
  localStorage.setItem('bs_uid', crypto.randomUUID()); // fresh anonymous identity
  cart = [];
  favorites = new Set();
  updateCartBadge();
  showToast('Você saiu da conta');
  navigateTo('feed');
}

// ─────────────────────────────────────────────────────────
// COMMENTS
// ─────────────────────────────────────────────────────────
async function renderComments() {
  const item = activeCommentsFeedItem;
  const container = document.getElementById('commentsContent');
  if (!item) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <div class="screen-header" style="flex-shrink:0"><h2 class="screen-title">Comentários</h2></div>
    <div class="comments-list scrollbar-hide" id="commentsList" style="flex:1;overflow-y:auto">Carregando…</div>
    <div class="comment-input-bar">
      <input type="text" id="commentInput" placeholder="${currentCustomer ? 'Escreva um comentário…' : 'Faça login para comentar'}" ${currentCustomer ? '' : 'disabled onclick="navigateTo(\'auth\')"'}/>
      <button class="comment-send-btn" onclick="submitComment()"><span class="material-symbols-outlined">send</span></button>
    </div>
  `;
  try {
    const comments = await api(`/api/feed/${item.id}/comments`);
    renderCommentsList(comments);
  } catch (err) {
    document.getElementById('commentsList').innerHTML = `<p style="padding:16px;color:var(--on-surface-variant)">Erro ao carregar comentários: ${err.message}</p>`;
  }
}

function renderCommentsList(comments) {
  const list = document.getElementById('commentsList');
  if (!comments.length) {
    list.innerHTML = `<p style="padding:24px 16px;text-align:center;color:var(--on-surface-variant)">Seja a primeira a comentar!</p>`;
    return;
  }
  list.innerHTML = comments.map(c => `
    <div class="comment-item">
      <div class="comment-avatar">${c.photoUrl ? `<img src="${c.photoUrl}"/>` : escapeHtml(c.name.charAt(0).toUpperCase())}</div>
      <div class="comment-body">
        <div class="comment-name">${escapeHtml(c.name)}</div>
        <div class="comment-text">${escapeHtml(c.body)}</div>
        <div class="comment-time">${new Date(c.createdAt).toLocaleString('pt-BR')}</div>
      </div>
    </div>
  `).join('');
}

async function submitComment() {
  if (!currentCustomer) { navigateTo('auth'); return; }
  const input = document.getElementById('commentInput');
  const body = input.value.trim();
  if (!body) return;
  const item = activeCommentsFeedItem;
  try {
    await api(`/api/feed/${item.id}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
    input.value = '';
    const comments = await api(`/api/feed/${item.id}/comments`);
    renderCommentsList(comments);
    // Keep the feed's comment counter in sync for when the user goes back.
    const feedItem = FEED_ITEMS.find(f => f.id === item.id);
    if (feedItem) feedItem.comments = String(comments.length);
  } catch (err) {
    showToast('Erro ao comentar: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────────────────────
async function renderNotifications() {
  const content = document.getElementById('notifContent');
  let notifications = [];
  try {
    notifications = await api('/api/notifications');
  } catch (err) {
    content.innerHTML = `<div class="screen-header"><h2 class="screen-title">Notificações</h2></div><div class="cart-empty"><p>Erro ao carregar: ${err.message}</p></div>`;
    return;
  }
  content.innerHTML = `
    <div class="screen-header"><h2 class="screen-title">Notificações</h2></div>
    ${notifications.map(n => `
      <div class="notif-item ${n.unread ? 'unread' : ''}" onclick="showToast('${n.title}')">
        <div class="notif-icon ${n.unread ? 'pink' : 'gray'}">
          <span class="material-symbols-outlined">${n.icon}</span>
        </div>
        <div class="notif-body">
          <div class="notif-title">${n.title}</div>
          <div class="notif-desc">${n.desc}</div>
          <div class="notif-time">${n.time}</div>
        </div>
        ${n.unread ? '<div class="notif-dot"></div>' : ''}
      </div>
    `).join('')}
  `;
}

// ─────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ─────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS
// ─────────────────────────────────────────────────────────
async function requestPushPermission() {
  if (!('Notification' in window)) { showToast('Notificações não suportadas'); return; }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') showToast('🔔 Notificações ativadas!');
  else showToast('Notificações bloqueadas');
}

// ─────────────────────────────────────────────────────────
// PWA INSTALL
// ─────────────────────────────────────────────────────────
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  if (!localStorage.getItem('bs_install_dismissed')) {
    setTimeout(() => {
      document.getElementById('installBanner').classList.add('show');
    }, 3000);
  }
});

document.getElementById('installBtn').addEventListener('click', async () => {
  if (!deferredInstall) { showToast('Adicione à tela inicial pelo menu do browser'); return; }
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  if (outcome === 'accepted') showToast('BianaStore instalada! 🎉');
  deferredInstall = null;
  dismissInstall();
});

function dismissInstall() {
  document.getElementById('installBanner').classList.remove('show');
  localStorage.setItem('bs_install_dismissed', '1');
}

window.addEventListener('appinstalled', () => {
  showToast('BianaStore instalada! 🎉');
  dismissInstall();
});

// ─────────────────────────────────────────────────────────
// SERVICE WORKER
// ─────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────
async function loadInitialData() {
  try {
    const [products, feed, categories, favs, cartData, me] = await Promise.all([
      api('/api/products'),
      api('/api/feed'),
      api('/api/categories'),
      api('/api/favorites'),
      api('/api/cart'),
      api('/api/auth/me'),
    ]);
    PRODUCTS = products;
    FEED_ITEMS = feed;
    CATEGORIES = ['Todos', ...categories];
    favorites = new Set(favs.map(p => p.id));
    cart = cartData;
    currentCustomer = me; // null if the current X-User-Id isn't a registered customer
  } catch (err) {
    showToast('Erro ao carregar a loja: ' + err.message);
  }
}

(async function init() {
  await loadInitialData();
  renderFeed();
  updateCartBadge();
  // Check URL shortcut
  const urlParams = new URLSearchParams(location.search);
  const startView = urlParams.get('view');
  if (startView) navigateTo(startView);
})();
