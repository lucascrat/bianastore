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
  if (['product','cart','checkout','confirm','notifications','auth','comments','pix-wait'].includes(screen)) {
    leftIcon.textContent = 'arrow_back';
  } else {
    leftIcon.textContent = 'menu';
  }
  // Leaving the Pix wait screen stops its background polling.
  if (screen !== 'pix-wait') clearInterval(pixPollTimer);
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
  if (screen === 'pix-wait') renderPixWait();
}

function handleTopLeft() {
  const backs = ['product','cart','checkout','confirm','notifications','auth','comments','pix-wait'];
  if (backs.includes(currentScreen)) {
    // Was calling the browser's real history.back() here too — but this app
    // never pushes history entries (navigateTo() only swaps screens in
    // memory), so there was nothing for it to go back to. It ended up
    // navigating the real browser away from the app entirely (jarring in an
    // installed/standalone PWA, where that can look like the app closing).
    // The explicit navigateTo() calls below are the actual navigation.
    if (currentScreen === 'product') navigateTo('shop');
    else if (currentScreen === 'cart') navigateTo('shop');
    else if (currentScreen === 'checkout') navigateTo('cart');
    else if (currentScreen === 'confirm') navigateTo('shop');
    else if (currentScreen === 'notifications') navigateTo('profile');
    else if (currentScreen === 'auth') navigateTo('profile');
    else if (currentScreen === 'comments') navigateTo('feed');
    else if (currentScreen === 'pix-wait') navigateTo('orders');
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
          <span class="feed-action-label" id="feedLikeCount${i}">${item.likes}</span>
        </button>
        <button class="feed-action-btn" id="feedCartBtn${i}" onclick="event.stopPropagation();addToBagFromFeed(${item.product.id}, ${i})">
          <div class="icon-circle"><span class="material-symbols-outlined">add_shopping_cart</span></div>
          <span class="feed-action-label">Sacola</span>
        </button>
        <button class="feed-action-btn" onclick="event.stopPropagation();navigateTo('comments', FEED_ITEMS.find(f=>f.id==${item.id}))">
          <div class="icon-circle"><span class="material-symbols-outlined">chat_bubble</span></div>
          <span class="feed-action-label" id="feedCommentCount${i}">${item.comments}</span>
        </button>
        <button class="feed-action-btn" onclick="event.stopPropagation();handleShare(${item.product.id})">
          <div class="icon-circle"><span class="material-symbols-outlined">share</span></div>
          <span class="feed-action-label">Compartilhar</span>
        </button>
      </div>
      <div class="feed-product-card" onclick="event.stopPropagation();navigateTo('product', PRODUCTS.find(p=>p.id==${item.product.id}))">
        <div class="feed-product-name">${item.product.name}</div>
        <div class="feed-prices">
          <span class="feed-price">R$ ${item.product.price.toFixed(2).replace('.',',')}</span>
          ${item.product.oldPrice ? `<span class="feed-price-old">R$ ${item.product.oldPrice.toFixed(2).replace('.',',')}</span>` : ''}
        </div>
        <button class="feed-buy-btn" onclick="event.stopPropagation();openQuickBuy(${item.product.id})">
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
  const p = PRODUCTS.find(x => x.id == productId);
  if (!p) return;
  // Was sharing location.href — always the generic app URL (SPA, no real
  // routing), so whoever received the link just landed on the home feed
  // instead of the product being shown off. ?product=ID is picked up by
  // init() above and opens that exact product.
  const shareUrl = `${location.origin}${location.pathname}?product=${p.id}`;
  const shareText = `Olha que lindo: ${p.name} por R$ ${p.price.toFixed(2).replace('.', ',')}!`;
  if (navigator.share) {
    navigator.share({ title: p.name + ' — BianaStore', text: shareText, url: shareUrl });
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(shareUrl).then(() => showToast('Link copiado!'));
  } else {
    showToast('Link: ' + shareUrl);
  }
}

// ─────────────────────────────────────────────────────────
// SHOP
// ─────────────────────────────────────────────────────────
let shopSearchQuery = '';
let shopSortBy = 'relevance';

function setShopSearch(value) {
  shopSearchQuery = value;
  renderShop();
}

function setShopSort(value) {
  shopSortBy = value;
  renderShop();
}

function renderShop() {
  // Categories
  const chips = document.getElementById('categoryChips');
  chips.innerHTML = CATEGORIES.map(c => `
    <button class="chip ${c === activeCategory ? 'active' : ''}" onclick="setCategory('${c}')">${c}</button>
  `).join('');
  // Products
  const grid = document.getElementById('productsGrid');
  let filtered = activeCategory === 'Todos' ? PRODUCTS : PRODUCTS.filter(p => p.cat === activeCategory);
  const q = shopSearchQuery.trim().toLowerCase();
  if (q) filtered = filtered.filter(p => p.name.toLowerCase().includes(q) || (p.sub || '').toLowerCase().includes(q));
  filtered = filtered.slice(); // don't sort the shared PRODUCTS array in place
  if (shopSortBy === 'price-asc') filtered.sort((a, b) => a.price - b.price);
  else if (shopSortBy === 'price-desc') filtered.sort((a, b) => b.price - a.price);
  else if (shopSortBy === 'newest') filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!filtered.length) {
    grid.innerHTML = `<div class="cart-empty" style="grid-column:1/-1">
      <span class="material-symbols-outlined">search_off</span>
      <h3>Nenhum produto encontrado</h3>
      <p>${q ? `Não achamos nada pra "${escapeHtml(shopSearchQuery)}"` : 'Tente outra categoria'}</p>
    </div>`;
    return;
  }
  grid.innerHTML = filtered.map(p => `
    <div class="product-card" onclick="navigateTo('product', PRODUCTS.find(x=>x.id==${p.id}))">
      <div class="product-card-img-wrap">
        <img class="product-card-img" src="${p.img}" alt="${p.name}" loading="lazy"/>
        <button class="product-card-fav ${favorites.has(p.id) ? 'active' : ''}" onclick="event.stopPropagation();toggleFav(${p.id})" id="fav-card-${p.id}">
          <span class="material-symbols-outlined" style="font-variation-settings:'FILL' ${favorites.has(p.id)?1:0}">${favorites.has(p.id)?'favorite':'favorite_border'}</span>
        </button>
        <button class="product-card-cart-btn" onclick="addToBagFromCard(${p.id}, event)">
          <span class="material-symbols-outlined">add_shopping_cart</span>
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
      <p class="detail-sub">${p.sub} <span style="color:var(--outline);font-size:12px">· Ref: ${productCode(p.id)}</span></p>
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
      <div id="stockHint" style="font-size:13px;font-weight:600;margin:-10px 0 16px"></div>

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

    <button class="detail-add-btn" id="detailAddBtn" onclick="addToCart(${p.id})">
      <span class="material-symbols-outlined">shopping_bag</span>
      Adicionar à Sacola
    </button>
  `;
  updateStockHint();
}

// Looks up real stock for a color+size combo from the product's `variants`
// (populated server-side from product_variants — see server/routes/products.js).
// Returns null when there's simply no record for that combo (shouldn't happen
// once a product has been through the admin sync, but treated as "unknown /
// don't block" rather than "zero" so a data gap never wrongly blocks a sale).
function stockFor(p, color, size) {
  const v = (p.variants || []).find(x => x.color === (color || '') && x.size === (size || ''));
  return v ? v.stock : null;
}

function currentColorValue() {
  const p = selectedProduct;
  return p && p.colors.length ? (p.colors[selectedColor] || '') : '';
}

function updateStockHint() {
  const p = selectedProduct;
  if (!p) return;
  const hint = document.getElementById('stockHint');
  const btn = document.getElementById('detailAddBtn');
  if (!hint || !btn) return;
  const stock = stockFor(p, currentColorValue(), selectedSize);
  if (stock === null) { hint.textContent = ''; btn.disabled = false; btn.style.opacity = ''; return; }
  if (stock <= 0) {
    hint.textContent = '❌ Esgotado nesse tamanho/cor';
    hint.style.color = 'var(--error)';
    btn.disabled = true;
    btn.style.opacity = '0.5';
  } else if (stock <= 5) {
    hint.textContent = `🔥 Só restam ${stock} unidades`;
    hint.style.color = 'var(--error)';
    btn.disabled = false;
    btn.style.opacity = '';
  } else {
    hint.textContent = '✅ Em estoque';
    hint.style.color = 'var(--success, #1a7b45)';
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

function selectSize(s) {
  selectedSize = s;
  document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('size-btn-'+s)?.classList.add('active');
  updateStockHint();
}

function selectColor(i) {
  selectedColor = i;
  document.querySelectorAll('.color-swatch').forEach((s,j) => s.classList.toggle('active', j===i));
  updateStockHint();
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
  const color = currentColorValue();
  try {
    cart = await api('/api/cart', { method: 'POST', body: JSON.stringify({ productId, size: selectedSize, color, qty: 1 }) });
    showToast('✅ Adicionado à sacola!');
    updateCartBadge();
    bumpCartIcon();
  } catch (err) {
    showToast('Erro ao adicionar: ' + err.message);
  }
}

// ─────────────────────────────────────────────────────────
// QUICK BUY — urgency bottom sheet opened from the feed's "COMPRAR AGORA"
// button. Goes straight to checkout instead of silently dropping the item
// in the cart (that's what used to happen and is what the user reported as
// broken) and layers on TikTok Shop-style urgency (countdown + scarcity) to
// push conversion. The countdown/stock numbers are presentational — nothing
// here reserves real inventory server-side.
// ─────────────────────────────────────────────────────────
let quickBuyProduct = null;
let quickBuySize = null;
let quickBuyColor = null;
let quickBuyDeadline = null;
let quickBuyTimerHandle = null;

function openQuickBuy(productId) {
  const p = PRODUCTS.find(x => x.id == productId);
  if (!p) return;
  quickBuyProduct = p;
  quickBuySize = p.sizes?.[1] || p.sizes?.[0] || null;
  quickBuyColor = p.colors?.[0] || '';
  quickBuyDeadline = Date.now() + 5 * 60 * 1000; // 5-minute reservation window, resets every time the sheet opens
  renderQuickBuy();
  document.getElementById('quickBuyOverlay').classList.add('active');
  clearInterval(quickBuyTimerHandle);
  quickBuyTimerHandle = setInterval(updateQuickBuyTimer, 1000);
  updateQuickBuyTimer();
}

function closeQuickBuy() {
  document.getElementById('quickBuyOverlay').classList.remove('active');
  clearInterval(quickBuyTimerHandle);
  quickBuyTimerHandle = null;
}

function renderQuickBuy() {
  const p = quickBuyProduct;
  if (!p) return;
  const content = document.getElementById('quickBuyContent');
  content.innerHTML = `
    <div class="quick-buy-header">
      <img class="quick-buy-thumb" src="${p.img}" alt="${escapeHtml(p.name)}"/>
      <div>
        <div class="quick-buy-name">${escapeHtml(p.name)}</div>
        <div class="quick-buy-prices">
          <span class="quick-buy-price">R$ ${p.price.toFixed(2).replace('.', ',')}</span>
          ${p.oldPrice ? `<span class="quick-buy-price-old">R$ ${p.oldPrice.toFixed(2).replace('.', ',')}</span>` : ''}
        </div>
      </div>
    </div>

    <div class="quick-buy-urgency">
      <span class="material-symbols-outlined">timer</span>
      <div class="quick-buy-urgency-text">Estamos <b>reservando esta peça</b> pra você.<br>Finalize antes que o tempo acabe!</div>
      <span class="quick-buy-timer" id="quickBuyTimer">05:00</span>
    </div>

    <div class="quick-buy-stock" id="qbStockLine"></div>
    <div class="quick-buy-stock-bar"><div class="quick-buy-stock-bar-fill" id="qbStockBar" style="width:0%"></div></div>

    ${p.colors?.length > 1 ? `
    <div class="section-label">Cor</div>
    <div class="color-row" id="qbColorRow">
      ${p.colors.map((c, i) => `<div class="color-swatch ${c === quickBuyColor ? 'active' : ''}" style="background:${c}" onclick="selectQuickBuyColor(${i})" id="qb-color-${i}"></div>`).join('')}
    </div>` : ''}

    ${p.sizes?.length ? `
    <div class="section-label">Escolha o tamanho</div>
    <div class="size-row">
      ${p.sizes.map(s => `<button class="size-btn ${s === quickBuySize ? 'active' : ''}" id="qb-size-${s}" onclick="selectQuickBuySize('${s}')">${s}</button>`).join('')}
    </div>` : ''}

    <button class="quick-buy-cta" id="quickBuyCtaBtn" onclick="confirmQuickBuy()">
      <span class="material-symbols-outlined">bolt</span>
      GARANTIR AGORA · R$ ${p.price.toFixed(2).replace('.', ',')}
    </button>
    <div class="quick-buy-secure">🔒 Pagamento seguro via Pix ou cartão</div>
  `;
  updateQuickBuyStockDisplay();
}

// Reflects REAL stock (product_variants, via the product's `variants` field)
// for whichever color+size is currently selected — matches exactly what
// confirmQuickBuy() adds to the cart.
function updateQuickBuyStockDisplay() {
  const p = quickBuyProduct;
  const line = document.getElementById('qbStockLine');
  const bar = document.getElementById('qbStockBar');
  const btn = document.getElementById('quickBuyCtaBtn');
  if (!p || !line || !bar || !btn) return;
  const stock = stockFor(p, quickBuyColor, quickBuySize);
  if (stock === null || stock > 5) {
    line.innerHTML = `<span class="material-symbols-outlined">local_fire_department</span><span>Peça muito procurada — garanta a sua!</span>`;
    bar.style.width = '70%';
    btn.disabled = false;
    btn.style.opacity = '';
  } else if (stock <= 0) {
    line.innerHTML = `<span class="material-symbols-outlined">local_fire_department</span><span>Esgotado nesse tamanho no momento</span>`;
    bar.style.width = '0%';
    btn.disabled = true;
    btn.style.opacity = '0.5';
  } else {
    line.innerHTML = `<span class="material-symbols-outlined">local_fire_department</span><span>Só resta${stock > 1 ? 'm' : ''} ${stock} unidade${stock > 1 ? 's' : ''} — está saindo rápido!</span>`;
    bar.style.width = `${stock * 20}%`;
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

function selectQuickBuySize(s) {
  quickBuySize = s;
  document.querySelectorAll('#quickBuyContent .size-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('qb-size-' + s)?.classList.add('active');
  updateQuickBuyStockDisplay();
}

function selectQuickBuyColor(i) {
  quickBuyColor = quickBuyProduct.colors[i];
  document.querySelectorAll('#qbColorRow .color-swatch').forEach((el, j) => el.classList.toggle('active', j === i));
  updateQuickBuyStockDisplay();
}

function updateQuickBuyTimer() {
  const el = document.getElementById('quickBuyTimer');
  if (!el) { clearInterval(quickBuyTimerHandle); return; }
  const remaining = Math.max(0, quickBuyDeadline - Date.now());
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  el.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  el.classList.toggle('urgent', remaining <= 60000 && remaining > 0);
  if (remaining <= 0) {
    clearInterval(quickBuyTimerHandle);
    quickBuyTimerHandle = null;
  }
}

async function confirmQuickBuy() {
  const p = quickBuyProduct;
  if (!p) return;
  if (p.sizes?.length && !quickBuySize) { showToast('Selecione um tamanho!'); return; }
  const btn = document.getElementById('quickBuyCtaBtn');
  if (btn) btn.disabled = true;
  try {
    cart = await api('/api/cart', { method: 'POST', body: JSON.stringify({ productId: p.id, size: quickBuySize || 'Único', color: quickBuyColor || '', qty: 1 }) });
    updateCartBadge();
    bumpCartIcon();
    closeQuickBuy();
    showToast('🔥 Garantido! Finalize seu pagamento agora');
    navigateTo('checkout');
  } catch (err) {
    showToast('Erro ao reservar: ' + err.message);
    if (btn) btn.disabled = false;
  }
}

function updateCartBadge() {
  const dot = document.getElementById('cartDot');
  const total = cart.reduce((s, i) => s + i.qty, 0);
  dot.textContent = total > 99 ? '99+' : String(total);
  dot.classList.toggle('show', total > 0);
}

// Small pop/rotate feedback on the top-bar cart icon whenever an item is
// added — reinforces that the piece was "reserved" without leaving the feed/grid.
function bumpCartIcon() {
  const btn = document.querySelector('.top-bar-icon.cart-badge');
  if (!btn) return;
  btn.classList.remove('cart-bump');
  void btn.offsetWidth; // restart the animation even if it's already mid-play
  btn.classList.add('cart-bump');
}

// Default size/color for a quick "add to bag" action where there's no
// picker UI (feed / grid cards) — same middle size the product detail page
// defaults to (or 'Único' with no size options), and the product's first
// color. The server still enforces real stock at checkout regardless of
// what gets added here.
function defaultSizeFor(p) {
  return p.sizes?.[1] || p.sizes?.[0] || 'Único';
}
function defaultColorFor(p) {
  return p.colors?.[0] || '';
}

// Adds to the cart straight from the feed without leaving it or triggering
// the quick-buy urgency flow — lets the customer keep browsing and "reserve"
// several pieces before deciding to check out.
async function addToBagFromFeed(productId, i) {
  const p = PRODUCTS.find(x => x.id == productId);
  if (!p) return;
  const circle = document.getElementById('feedCartBtn' + i)?.querySelector('.icon-circle');
  try {
    cart = await api('/api/cart', { method: 'POST', body: JSON.stringify({ productId: p.id, size: defaultSizeFor(p), color: defaultColorFor(p), qty: 1 }) });
    updateCartBadge();
    bumpCartIcon();
    if (circle) { circle.classList.remove('pop'); void circle.offsetWidth; circle.classList.add('pop'); }
    showToast('🛍️ Reservado na sacola! Continue explorando');
  } catch (err) {
    showToast('Erro ao adicionar: ' + err.message);
  }
}

// Same quick add, from a product card in the Shop or Favorites grid.
async function addToBagFromCard(productId, event) {
  event?.stopPropagation();
  const p = PRODUCTS.find(x => x.id == productId);
  if (!p) return;
  const btn = event?.currentTarget;
  try {
    cart = await api('/api/cart', { method: 'POST', body: JSON.stringify({ productId: p.id, size: defaultSizeFor(p), color: defaultColorFor(p), qty: 1 }) });
    updateCartBadge();
    bumpCartIcon();
    if (btn) { btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop'); }
    showToast('🛍️ Reservado na sacola!');
  } catch (err) {
    showToast('Erro ao adicionar: ' + err.message);
  }
}

async function changeQty(key, delta) {
  const item = cart.find(i => i.key === key);
  if (!item) return;
  const newQty = Math.max(0, item.qty + delta);
  try {
    cart = await api('/api/cart', { method: 'PATCH', body: JSON.stringify({ productId: item.productId, size: item.size, color: item.color, qty: newQty }) });
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
    cart = await api('/api/cart', { method: 'DELETE', body: JSON.stringify({ productId: item.productId, size: item.size, color: item.color }) });
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
            <div class="cart-item-name">${ci.name} <span style="color:var(--outline);font-weight:400;font-size:12px">${productCode(ci.productId)}</span></div>
            <div class="cart-item-variant">Tamanho: ${ci.size}${ci.color ? ` &nbsp;•&nbsp; Cor: <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${ci.color};vertical-align:middle;border:1px solid var(--outline)"></span>` : ''}</div>
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
    <button class="cart-add-more-btn" onclick="navigateTo('shop')">
      <span class="material-symbols-outlined">add</span> Continuar reservando peças
    </button>
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
  // Guards against an empty-cart checkout (e.g. the last item was removed
  // from another tab/device while this one still had the checkout screen
  // open) — without this, the screen rendered a "Total do pedido R$14,90"
  // for a shipping fee alone with no items to justify it, and only failed
  // (confusingly) once the customer actually tapped "Confirmar Pedido".
  if (cart.length === 0) {
    showToast('Sua sacola está vazia');
    navigateTo('cart');
    return;
  }
  const content = document.getElementById('checkoutContent');
  const { total } = getCartTotals();
  const fmt = v => `R$ ${v.toFixed(2).replace('.',',')}`;
  // Fresh state every time the customer (re)enters checkout — a coupon or
  // shipping estimate from a previous visit shouldn't silently carry over.
  appliedCoupon = null;
  shippingZoneCache = null;
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
        <label>Quem vai receber</label>
        <input type="text" id="addr-recipient" placeholder="Nome completo do destinatário" autocomplete="name"/>
      </div>
      <div class="checkout-field">
        <label>Telefone / WhatsApp</label>
        <input type="tel" id="addr-phone" placeholder="(11) 90000-0000" inputmode="tel" autocomplete="tel"/>
      </div>
      <div class="checkout-field">
        <label>CEP</label>
        <input type="text" id="addr-cep" placeholder="00000-000" inputmode="numeric" maxlength="9" oninput="onCepInput(this.value)"/>
        <span id="cepStatus" style="font-size:12px;color:var(--on-surface-variant)"></span>
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
          <input type="text" id="addr-state" placeholder="SP" maxlength="2" oninput="this.value=this.value.toUpperCase();updateShippingEstimate()"/>
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
          <input type="radio" name="payment" value="pix" checked onchange="onPaymentMethodChange()"/>
          <span class="material-symbols-outlined">qr_code_2</span>
          <span class="payment-option-label">PIX — 5% de desconto</span>
        </label>
        <label class="payment-option" style="${appConfig.efiAccountId ? '' : 'opacity:0.5'}">
          <input type="radio" name="payment" value="credit" onchange="onPaymentMethodChange()" ${appConfig.efiAccountId ? '' : 'disabled'}/>
          <span class="material-symbols-outlined">credit_card</span>
          <span class="payment-option-label">Cartão de Crédito${appConfig.efiAccountId ? '' : ' (em breve)'}</span>
        </label>
      </div>
    </div>

    <div class="checkout-section" id="creditCardFields" style="display:none">
      <div class="checkout-section-header">
        <span class="material-symbols-outlined">badge</span>
        <span class="checkout-section-title">Dados do Titular</span>
      </div>
      <div class="checkout-field"><label>Nome completo</label><input type="text" id="cust-name" placeholder="Como está no cartão"/></div>
      <div style="display:flex">
        <div class="checkout-field" style="flex:1"><label>CPF</label><input type="text" id="cust-cpf" placeholder="000.000.000-00" inputmode="numeric"/></div>
        <div class="checkout-field" style="flex:1"><label>Telefone</label><input type="text" id="cust-phone" placeholder="(11) 90000-0000" inputmode="tel"/></div>
      </div>
      <div class="checkout-field"><label>E-mail</label><input type="email" id="cust-email" placeholder="voce@email.com"/></div>
      <div class="checkout-field">
        <label>Número do cartão</label>
        <input type="text" id="card-number" placeholder="0000 0000 0000 0000" inputmode="numeric" maxlength="19" oninput="onCardNumberInput()"/>
        <div class="card-brand-chip" id="cardBrandChip"></div>
      </div>
      <div style="display:flex">
        <div class="checkout-field" style="flex:1"><label>Validade (MM/AAAA)</label><input type="text" id="card-expiry" placeholder="12/2029" inputmode="numeric" maxlength="7"/></div>
        <div class="checkout-field" style="flex:1"><label>CVV</label><input type="text" id="card-cvv" placeholder="123" inputmode="numeric" maxlength="4"/></div>
      </div>
      <div class="checkout-field">
        <label>Parcelas</label>
        <select class="installment-select" id="installment-select"><option value="1">1x sem juros</option></select>
      </div>
    </div>

    <div class="checkout-section">
      <div class="checkout-section-header">
        <span class="material-symbols-outlined">sell</span>
        <span class="checkout-section-title">Cupom de Desconto</span>
      </div>
      <div style="display:flex;gap:8px">
        <input type="text" id="couponInput" placeholder="Digite o código" style="flex:1;padding:10px 12px;border:1px solid var(--outline-variant);border-radius:8px;text-transform:uppercase" onkeydown="if(event.key==='Enter'){event.preventDefault();applyCoupon();}"/>
        <button class="btn-coupon-apply" id="couponApplyBtn" onclick="applyCoupon()" style="padding:0 18px;border-radius:8px;border:none;background:var(--primary);color:#fff;font-weight:700;cursor:pointer">Aplicar</button>
      </div>
      <div id="couponMsg" style="font-size:13px;margin-top:6px"></div>
    </div>

    <div class="checkout-section">
      <div class="checkout-section-header">
        <span class="material-symbols-outlined">local_shipping</span>
        <span class="checkout-section-title">Opção de Entrega</span>
      </div>
      <div id="shippingOptions"></div>
    </div>

    <div style="height:120px"></div>

    <div class="checkout-total-bar">
      <div id="checkoutTotalBreakdown"></div>
      <button class="checkout-confirm-btn" id="checkoutConfirmBtn" onclick="placeOrder()">
        <span class="material-symbols-outlined">lock</span>
        Confirmar Pedido
      </button>
    </div>
  `;
  renderShippingOptions();
  renderCheckoutTotals();
}

let lastOrder = null;
let appConfig = { efiAccountId: null, efiSandbox: false, paymentsEnabled: false };
let pixPollTimer = null;
let cepLookupTimer = null;

// Auto-fills street/neighborhood/city/state from a CEP via ViaCEP (free,
// no key needed) so the customer doesn't have to type their whole address by
// hand every time — only the house number/complement stay manual. Debounced
// so it doesn't fire a request on every keystroke.
function onCepInput(raw) {
  clearTimeout(cepLookupTimer);
  const cep = raw.replace(/\D/g, '');
  const status = document.getElementById('cepStatus');
  if (cep.length !== 8) { if (status) status.textContent = ''; return; }
  if (status) status.textContent = 'Buscando endereço…';
  cepLookupTimer = setTimeout(async () => {
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
      const data = await res.json();
      if (data.erro) { if (status) status.textContent = 'CEP não encontrado — preencha manualmente'; return; }
      const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
      set('addr-street', data.logradouro);
      set('addr-neighborhood', data.bairro);
      set('addr-city', data.localidade);
      set('addr-state', data.uf);
      if (status) status.textContent = '✅ Endereço encontrado';
      updateShippingEstimate();
    } catch {
      if (status) status.textContent = 'Não foi possível buscar o CEP — preencha manualmente';
    }
  }, 500);
}

// ─────────────────────────────────────────────────────────
// SHIPPING (real, per-destination-state — see server/lib/shipping.js) and
// COUPONS. Both render into their own containers inside the checkout screen
// (#shippingOptions / #checkoutTotalBreakdown) so applying a coupon or
// resolving a CEP never has to re-render the whole checkout form (which
// would blow away whatever the customer already typed).
// ─────────────────────────────────────────────────────────
let appliedCoupon = null; // {code, discount} once applied, else null
let shippingZoneCache = null; // {zoneName, standardCost, standardDays, expressCost, expressDays} once resolved

// Shown before the destination state is known — matches what this screen
// hardcoded before real shipping zones existed, so checkout never looks
// broken while waiting on a CEP lookup.
const SHIPPING_FALLBACK = { standardCost: 9.9, standardDays: 5, expressCost: 14.9, expressDays: 2 };

function currentShippingDisplay() {
  if (shippingZoneCache) return shippingZoneCache;
  const { total } = getCartTotals();
  return {
    zoneName: null,
    standardCost: total >= 299 ? 0 : SHIPPING_FALLBACK.standardCost,
    standardDays: SHIPPING_FALLBACK.standardDays,
    expressCost: SHIPPING_FALLBACK.expressCost,
    expressDays: SHIPPING_FALLBACK.expressDays,
  };
}

async function updateShippingEstimate() {
  const state = document.getElementById('addr-state')?.value?.trim().toUpperCase();
  if (!state || state.length !== 2) return;
  const { sub } = getCartTotals();
  try {
    shippingZoneCache = await api(`/api/shipping/estimate?state=${state}&subtotal=${sub}`);
    renderShippingOptions();
    renderCheckoutTotals();
  } catch {
    // Silent — the order itself recomputes shipping server-side regardless,
    // so a failed estimate here just means the fallback numbers stay shown.
  }
}

function renderShippingOptions() {
  const el = document.getElementById('shippingOptions');
  if (!el) return;
  const selected = document.querySelector('input[name="shipping"]:checked')?.value || 'express';
  const s = currentShippingDisplay();
  const fmt = v => v <= 0 ? 'Grátis' : `R$ ${v.toFixed(2).replace('.', ',')}`;
  el.innerHTML = `
    <label class="payment-option">
      <input type="radio" name="shipping" value="express" ${selected === 'express' ? 'checked' : ''} onchange="renderCheckoutTotals()"/>
      <span class="material-symbols-outlined">bolt</span>
      <span class="payment-option-label">Expresso — ${s.expressDays <= 1 ? 'Amanhã' : `${s.expressDays} dias úteis`}</span>
      <span style="font-size:13px;font-weight:700;color:var(--primary)">${fmt(s.expressCost)}</span>
    </label>
    <label class="payment-option">
      <input type="radio" name="shipping" value="standard" ${selected === 'standard' ? 'checked' : ''} onchange="renderCheckoutTotals()"/>
      <span class="material-symbols-outlined">local_shipping</span>
      <span class="payment-option-label">Padrão — ${s.standardDays} dias úteis</span>
      <span style="font-size:13px;font-weight:700;color:#1A7B45">${fmt(s.standardCost)}</span>
    </label>
    ${s.zoneName ? `<div style="font-size:12px;color:var(--on-surface-variant);margin-top:4px">📍 Frete calculado para: ${escapeHtml(s.zoneName)}</div>` : ''}
  `;
}

function renderCheckoutTotals() {
  const el = document.getElementById('checkoutTotalBreakdown');
  if (!el) return;
  const { sub, discount } = getCartTotals();
  const method = document.querySelector('input[name="shipping"]:checked')?.value || 'express';
  const s = currentShippingDisplay();
  const shippingCost = method === 'express' ? s.expressCost : s.standardCost;
  const couponDiscount = appliedCoupon?.discount || 0;
  const total = Math.max(0, sub + shippingCost - couponDiscount);
  const fmt = v => `R$ ${v.toFixed(2).replace('.', ',')}`;
  el.innerHTML = `
    <div class="checkout-total-row"><span class="checkout-total-label">Subtotal</span><span>${fmt(sub)}</span></div>
    ${discount > 0 ? `<div class="checkout-total-row"><span class="checkout-total-label">Você economiza</span><span style="color:var(--primary)">− ${fmt(discount)}</span></div>` : ''}
    <div class="checkout-total-row"><span class="checkout-total-label">Frete</span><span>${shippingCost <= 0 ? 'Grátis' : fmt(shippingCost)}</span></div>
    ${couponDiscount > 0 ? `<div class="checkout-total-row"><span class="checkout-total-label">Cupom ${escapeHtml(appliedCoupon.code)}</span><span style="color:var(--primary)">− ${fmt(couponDiscount)}</span></div>` : ''}
    <div class="checkout-total-row"><span class="checkout-total-label">Total do pedido</span><span class="checkout-total-val">${fmt(total)}</span></div>
  `;
}

async function applyCoupon() {
  const input = document.getElementById('couponInput');
  const msg = document.getElementById('couponMsg');
  const code = input.value.trim().toUpperCase();
  if (!code) return;
  const { sub } = getCartTotals();
  try {
    const result = await api(`/api/coupons/${encodeURIComponent(code)}/validate?subtotal=${sub}`);
    appliedCoupon = { code: result.code, discount: result.discount };
    msg.innerHTML = `✅ Cupom <b>${escapeHtml(result.code)}</b> aplicado! <a href="javascript:void(0)" onclick="removeCoupon()" style="color:inherit;text-decoration:underline">Remover</a>`;
    msg.style.color = 'var(--success, #1a7b45)';
    input.disabled = true;
    document.getElementById('couponApplyBtn').disabled = true;
    renderCheckoutTotals();
  } catch (err) {
    appliedCoupon = null;
    msg.textContent = '❌ ' + err.message;
    msg.style.color = 'var(--error)';
    renderCheckoutTotals();
  }
}

function removeCoupon() {
  appliedCoupon = null;
  const input = document.getElementById('couponInput');
  if (input) { input.value = ''; input.disabled = false; }
  const btn = document.getElementById('couponApplyBtn');
  if (btn) btn.disabled = false;
  const msg = document.getElementById('couponMsg');
  if (msg) msg.textContent = '';
  renderCheckoutTotals();
}

function onPaymentMethodChange() {
  const isCredit = document.querySelector('input[name="payment"]:checked')?.value === 'credit';
  document.getElementById('creditCardFields').style.display = isCredit ? 'block' : 'none';
}

async function onCardNumberInput() {
  const number = document.getElementById('card-number').value.replace(/\D/g, '');
  const chip = document.getElementById('cardBrandChip');
  if (number.length < 6) { chip.textContent = ''; return; }
  try {
    const brand = await EfiPay.CreditCard.setCardNumber(number).verifyCardBrand();
    if (brand === 'undefined' || brand === 'unsupported') { chip.textContent = ''; return; }
    chip.textContent = brand.toUpperCase();
    await loadInstallmentOptions(brand);
  } catch { /* keep typing, brand just isn't identifiable yet */ }
}

async function loadInstallmentOptions(brand) {
  const select = document.getElementById('installment-select');
  const { total } = getCartTotals();
  const shippingCost = document.querySelector('input[name="shipping"]:checked')?.value === 'express' ? 14.9 : (total >= 299 ? 0 : 9.9);
  const totalCents = Math.round((total + shippingCost) * 100);
  try {
    const result = await EfiPay.CreditCard
      .setAccount(appConfig.efiAccountId)
      .setEnvironment(appConfig.efiSandbox ? 'sandbox' : 'production')
      .setBrand(brand)
      .setTotal(totalCents)
      .getInstallments();
    const options = result?.[0]?.installments || [];
    if (!options.length) return;
    select.innerHTML = options.map(o => {
      const val = (o.value / 100).toFixed(2).replace('.', ',');
      return `<option value="${o.installment}">${o.installment}x de R$ ${val}${o.has_interest ? ' com juros' : ' sem juros'}</option>`;
    }).join('');
  } catch (err) {
    // Non-fatal: the customer can still pay in 1x, just without the full simulated list.
  }
}

async function placeOrder() {
  const btn = document.getElementById('checkoutConfirmBtn');
  const val = (id) => document.getElementById(id)?.value?.trim() || '';
  const shippingAddress = {
    recipient: val('addr-recipient'),
    phone: val('addr-phone'),
    cep: val('addr-cep'),
    street: val('addr-street'),
    number: val('addr-number'),
    complement: val('addr-complement'),
    neighborhood: val('addr-neighborhood'),
    city: val('addr-city'),
    state: val('addr-state'),
  };
  if (!shippingAddress.recipient || !shippingAddress.phone) {
    showToast('Informe quem vai receber e um telefone de contato!');
    return;
  }
  if (!shippingAddress.street || !shippingAddress.city) {
    showToast('Preencha o endereço de entrega!');
    return;
  }
  const paymentMethod = document.querySelector('input[name="payment"]:checked')?.value || 'pix';
  const shippingMethod = document.querySelector('input[name="shipping"]:checked')?.value || 'standard';

  btn.disabled = true;
  try {
    let payload = { shippingAddress, paymentMethod, shippingMethod, couponCode: appliedCoupon?.code || undefined };

    if (paymentMethod === 'credit') {
      const customer = { name: val('cust-name'), cpf: val('cust-cpf'), email: val('cust-email'), phone: val('cust-phone') };
      const cardNumber = val('card-number').replace(/\D/g, '');
      const cvv = val('card-cvv');
      const [expMonth, expYear] = val('card-expiry').split('/');
      const installments = parseInt(document.getElementById('installment-select').value, 10) || 1;
      if (!customer.name || !customer.cpf || !customer.email || !customer.phone) {
        throw new Error('Preencha seus dados (nome, CPF, e-mail e telefone)');
      }
      if (!cardNumber || !cvv || !expMonth || !expYear) {
        throw new Error('Preencha os dados do cartão corretamente');
      }
      const brand = await EfiPay.CreditCard.setCardNumber(cardNumber).verifyCardBrand();
      if (brand === 'undefined' || brand === 'unsupported') throw new Error('Bandeira do cartão não reconhecida');
      const tokenResult = await EfiPay.CreditCard
        .setAccount(appConfig.efiAccountId)
        .setEnvironment(appConfig.efiSandbox ? 'sandbox' : 'production')
        .setCreditCardData({
          brand, number: cardNumber, cvv,
          expirationMonth: expMonth.padStart(2, '0'), expirationYear: expYear,
          holderName: customer.name, holderDocument: customer.cpf.replace(/\D/g, ''),
        })
        .getPaymentToken();
      payload = { ...payload, paymentToken: tokenResult.payment_token, installments, customer };
    }

    lastOrder = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
    cart = [];
    updateCartBadge();

    if (paymentMethod === 'pix') {
      navigateTo('pix-wait');
    } else {
      navigateTo('confirm');
    }
  } catch (err) {
    showToast(err.error_description || err.message || 'Erro ao confirmar pedido');
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────
// PIX WAIT (polling — no webhook needed, see server/routes/orders.js)
// ─────────────────────────────────────────────────────────
function renderPixWait() {
  clearInterval(pixPollTimer);
  const content = document.getElementById('pixWaitContent');
  const order = lastOrder;
  if (!order) { content.innerHTML = ''; return; }
  const fmt = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

  const renderPending = () => `
    <div class="pix-wrap">
      <h2 style="font-family:'Plus Jakarta Sans',sans-serif;font-size:20px;font-weight:800;margin-bottom:4px">Pague com Pix</h2>
      <p style="color:var(--on-surface-variant);font-size:14px;margin-bottom:8px">Escaneie o QR code ou copie o código abaixo</p>
      <div class="pix-qr-box"><img src="${order.pixQrImage}" alt="QR code Pix"/></div>
      <div style="font-size:22px;font-weight:800;color:var(--primary);margin-bottom:16px">${fmt(order.total)}</div>
      <div class="pix-copia-box" id="pixCopiaText">${order.pixQrCode}</div>
      <button class="pix-copy-btn" onclick="copyPixCode()">
        <span class="material-symbols-outlined" style="font-size:18px">content_copy</span> Copiar código Pix
      </button>
      <div style="margin-top:24px" class="pix-spinner"></div>
      <p style="color:var(--on-surface-variant);font-size:13px">Aguardando confirmação do pagamento…</p>
      <p style="color:var(--on-surface-variant);font-size:12px;margin-top:4px">Isso é automático — a página atualiza sozinha assim que o Pix cair.</p>
    </div>
  `;

  content.innerHTML = renderPending();

  pixPollTimer = setInterval(async () => {
    try {
      const { paymentStatus } = await api(`/api/orders/${order.dbId}/check-payment`);
      if (paymentStatus === 'paid') {
        clearInterval(pixPollTimer);
        content.innerHTML = `
          <div class="pix-wrap">
            <div class="pix-paid-check"><span class="material-symbols-outlined" style="font-variation-settings:'FILL' 1">check</span></div>
            <h2 style="font-family:'Plus Jakarta Sans',sans-serif;font-size:20px;font-weight:800">Pagamento confirmado! 🎉</h2>
          </div>
        `;
        setTimeout(() => navigateTo('confirm'), 1400);
      }
    } catch { /* transient network hiccup — next tick retries */ }
  }, 3000);
}

function copyPixCode() {
  const text = document.getElementById('pixCopiaText')?.textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => showToast('Código Pix copiado!')).catch(() => showToast('Não foi possível copiar'));
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
            Entrega prevista: <strong style="color:var(--on-surface)">${lastOrder?.shippingMethod === 'express' ? 'em 1-3 dias úteis' : 'conforme prazo informado no checkout'}</strong>
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
            <button class="product-card-cart-btn" onclick="addToBagFromCard(${p.id}, event)">
              <span class="material-symbols-outlined">add_shopping_cart</span>
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
      ${!loggedIn ? `
        <div style="display:flex;gap:10px;margin-top:12px">
          <button style="padding:10px 22px;border-radius:99px;background:#fff;color:var(--primary);font-weight:700;font-family:'Plus Jakarta Sans',sans-serif;border:none;cursor:pointer" onclick="openAuth('login')">Entrar</button>
          <button style="padding:10px 22px;border-radius:99px;background:var(--primary);color:#fff;font-weight:700;font-family:'Plus Jakarta Sans',sans-serif;border:none;cursor:pointer" onclick="openAuth('register')">Criar conta</button>
        </div>` : ''}
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
      <div class="profile-menu-item" onclick="openAuth('login')">
        <span class="material-symbols-outlined" style="color:var(--primary)">login</span>
        <span class="profile-menu-item-label" style="color:var(--primary)">Entrar</span>
        <span class="material-symbols-outlined arrow">chevron_right</span>
      </div>
      <div class="profile-menu-item" onclick="openAuth('register')">
        <span class="material-symbols-outlined" style="color:var(--primary)">person_add</span>
        <span class="profile-menu-item-label" style="color:var(--primary)">Criar conta</span>
        <span class="material-symbols-outlined arrow">chevron_right</span>
      </div>`}
    </div>
  `;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Product reference code shown to customers (e.g. handy when contacting
// support about a specific piece) — just the product's own id, stable
// forever, formatted as "#01", "#02", ... Mirrors admin.js's productCode().
function productCode(id) {
  return '#' + String(id).padStart(2, '0');
}

// ─────────────────────────────────────────────────────────
// AUTH (login / cadastro)
// ─────────────────────────────────────────────────────────
function renderAuth() {
  const content = document.getElementById('authContent');
  content.innerHTML = `
    <div class="screen-header" style="flex-shrink:0;display:flex;align-items:center;gap:8px;padding:12px 16px">
      <button class="icon-btn" onclick="navigateTo('profile')" aria-label="Voltar">
        <span class="material-symbols-outlined">arrow_back</span>
      </button>
      <h2 class="screen-title" style="margin:0">${authMode === 'register' ? 'Criar conta' : 'Entrar'}</h2>
    </div>
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

// Opens the auth screen pre-set to the given mode ('login' or 'register')
function openAuth(mode) {
  authMode = mode || 'login';
  navigateTo('auth');
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
      <div class="notif-item ${n.unread ? 'unread' : ''}" id="notif-${n.id}" onclick="openNotification(${n.id})">
        <div class="notif-icon ${n.unread ? 'pink' : 'gray'}">
          <span class="material-symbols-outlined">${n.icon}</span>
        </div>
        <div class="notif-body">
          <div class="notif-title">${escapeHtml(n.title)}</div>
          <div class="notif-desc">${escapeHtml(n.desc)}</div>
          <div class="notif-time">${n.time}</div>
        </div>
        ${n.unread ? '<div class="notif-dot"></div>' : ''}
      </div>
    `).join('')}
  `;
}

async function openNotification(id) {
  const row = document.getElementById('notif-' + id);
  row?.classList.remove('unread');
  row?.querySelector('.notif-icon')?.classList.replace('pink', 'gray');
  row?.querySelector('.notif-dot')?.remove();
  try {
    await api(`/api/notifications/${id}/read`, { method: 'PATCH' });
  } catch { /* already updated visually; a failed sync just gets fixed on next screen load */ }
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
// Converts the VAPID public key (base64url, as returned by /api/config) into
// the Uint8Array shape PushManager.subscribe() requires.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function requestPushPermission() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('Notificações push não suportadas neste navegador');
    return;
  }
  if (!appConfig.vapidPublicKey) {
    showToast('Notificações push indisponíveis no momento');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { showToast('Notificações bloqueadas'); return; }
  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(appConfig.vapidPublicKey),
      });
    }
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) });
    showToast('🔔 Notificações ativadas!');
  } catch (err) {
    showToast('Erro ao ativar notificações: ' + err.message);
  }
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
    const [products, feed, categories, favs, cartData, me, config] = await Promise.all([
      api('/api/products'),
      api('/api/feed'),
      api('/api/categories'),
      api('/api/favorites'),
      api('/api/cart'),
      api('/api/auth/me'),
      api('/api/config'),
    ]);
    PRODUCTS = products;
    FEED_ITEMS = feed;
    CATEGORIES = ['Todos', ...categories];
    favorites = new Set(favs.map(p => p.id));
    cart = cartData;
    currentCustomer = me; // null if the current X-User-Id isn't a registered customer
    appConfig = config; // { efiAccountId, efiSandbox, paymentsEnabled }
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
  // Deep link to a specific product (?product=ID) — needs PRODUCTS loaded
  // first, so it's handled here rather than in the earlier DOMContentLoaded
  // handler. This is what makes a shared product link (see handleShare())
  // actually open that product instead of just the home feed.
  const productParam = urlParams.get('product');
  if (productParam) {
    const p = PRODUCTS.find(x => x.id == productParam);
    if (p) navigateTo('product', p);
  }
})();
