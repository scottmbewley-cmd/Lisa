// Evelle — browser-local cart (localStorage), shared across all public pages.
const CART_KEY = 'evelle_cart_v1';
const CHECKOUT_ENABLED = true;

function esc(s) { return (s ?? '').toString().replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function readCart() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeCart(items) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(items)); } catch (e) { /* storage unavailable — cart just won't persist */ }
  renderBadge();
  renderDrawer();
}

function cartCount(items) { return (items || readCart()).reduce((sum, i) => sum + i.qty, 0); }
function cartTotal(items) { return (items || readCart()).reduce((sum, i) => sum + i.price * i.qty, 0); }

// A cart line's identity is id+size, not just id — two different ring
// sizes of the same SKU are separate lines with separate quantities, never
// merged. lineKey() is used everywhere a line needs to be found/matched;
// non-ring items simply have size undefined, which still forms a stable key.
function lineKey(id, size) { return String(id) + '::' + (size || ''); }

// Lisa buys and tracks ring stock in US sizes only (Warehouse, Inventory,
// invoices all stay plain US numbers) — this table is purely a DISPLAY
// layer for customers, who are more likely to know their UK size. The
// stored/submitted value is always the plain US number; only what's shown
// on screen changes. Standard US→UK conversion — confirmed against Lisa's
// own sizing on 2026-09-10.
const US_TO_UK_RING_SIZE = {
  "3": "F", "3.5": "G", "4": "H", "4.5": "I", "5": "J", "5.5": "K",
  "6": "L", "6.5": "M", "7": "N", "7.5": "O", "8": "P", "8.5": "Q",
  "9": "R", "9.5": "S", "10": "T", "10.5": "U", "11": "V", "11.5": "W",
  "12": "X", "13": "Z"
};
// Normalizes "6", "6.0", " 6 " to the same lookup key so however Lisa typed
// it in Warehouse, the customer sees the same label. Anything that isn't a
// recognised US ring number (a typo, or a non-numeric size like
// "Adjustable") is shown exactly as stored, with no US/UK wrapper added.
function formatRingSize(sizeStr) {
  const raw = String(sizeStr || '').trim();
  const num = Number(raw);
  const key = Number.isFinite(num) && raw !== '' ? String(num) : null;
  const uk = key ? US_TO_UK_RING_SIZE[key] : null;
  return uk ? ('US ' + key + ' (UK ' + uk + ')') : raw;
}

function addToCart(product, qty) {
  qty = qty || 1;
  const items = readCart();
  const key = lineKey(product.id, product.size);
  const existing = items.find(i => lineKey(i.id, i.size) === key);
  const cap = product.maxQty && product.maxQty > 0 ? product.maxQty : null;
  if (existing) {
    existing.qty += qty;
    if (cap) existing.qty = Math.min(existing.qty, cap);
  } else {
    items.push({
      id: product.id, sku: product.sku, name: product.name, size: product.size || null,
      price: product.price, image_url: product.image_url,
      qty: cap ? Math.min(qty, cap) : qty, maxQty: cap
    });
  }
  writeCart(items);
}

function updateQty(key, qty) {
  let items = readCart();
  const item = items.find(i => lineKey(i.id, i.size) === key);
  if (!item) return;
  if (qty < 1) { items = items.filter(i => lineKey(i.id, i.size) !== key); }
  else { item.qty = item.maxQty ? Math.min(qty, item.maxQty) : qty; }
  writeCart(items);
}

function removeFromCart(key) {
  writeCart(readCart().filter(i => lineKey(i.id, i.size) !== key));
}

function clearCart() {
  writeCart([]);
}

function renderBadge() {
  const badge = document.getElementById('cart-count');
  if (!badge) return;
  const count = cartCount();
  badge.textContent = count;
  badge.classList.toggle('show', count > 0);
}

function renderDrawer() {
  const body = document.getElementById('cart-drawer-body');
  const foot = document.getElementById('cart-drawer-foot');
  if (!body || !foot) return;
  const items = readCart();

  if (!items.length) {
    body.innerHTML = '<div class="cart-empty"><p class="muted">Your cart is empty.</p><a href="' + relativeShopLink() + '" class="btn btn-outline">Continue Shopping</a></div>';
    foot.innerHTML = '';
    return;
  }

  body.innerHTML = items.map(item => {
    const key = lineKey(item.id, item.size);
    return `
    <div class="cart-line" data-id="${esc(key)}">
      ${item.image_url ? `<img class="cart-line-img" src="${esc(item.image_url)}" alt="${esc(item.name)}">` : '<div class="cart-line-img"></div>'}
      <div class="cart-line-info">
        <span class="n">${esc(item.name)}</span>
        <span class="s">SKU ${esc(item.sku)}${item.size ? ' &middot; Size ' + esc(formatRingSize(item.size)) : ''}</span>
        <div class="p">£${(item.price * item.qty).toFixed(2)}</div>
        <div class="cart-qty-row">
          <button class="cart-qty-btn qty-minus" data-id="${esc(key)}">&minus;</button>
          <span class="cart-qty-val">${item.qty}</span>
          <button class="cart-qty-btn qty-plus" data-id="${esc(key)}"${item.maxQty && item.qty >= item.maxQty ? ' disabled' : ''}>+</button>
          <button class="cart-remove-btn" data-id="${esc(key)}">Remove</button>
        </div>
      </div>
    </div>
  `;
  }).join('');

  const total = cartTotal(items);
  const checkoutBtn = CHECKOUT_ENABLED
    ? `<a href="checkout.html" class="btn btn-primary" id="cart-checkout-btn">Checkout</a>`
    : `<button class="btn btn-primary" id="cart-checkout-btn" disabled style="opacity:0.5;cursor:default;">Checkout — coming soon</button>`;
  foot.innerHTML = `
    <div class="cart-subtotal-row"><span>Subtotal</span><span>£${total.toFixed(2)}</span></div>
    ${checkoutBtn}
  `;
}

function relativeShopLink() { return 'shop.html'; }

function openDrawer() {
  document.getElementById('cart-drawer').classList.add('open');
  document.getElementById('cart-drawer-overlay').classList.add('open');
}
function closeDrawer() {
  document.getElementById('cart-drawer').classList.remove('open');
  document.getElementById('cart-drawer-overlay').classList.remove('open');
}

function buildDrawer() {
  if (document.getElementById('cart-drawer')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="cart-drawer-overlay" id="cart-drawer-overlay"></div>
    <aside class="cart-drawer" id="cart-drawer" aria-label="Shopping cart">
      <div class="cart-drawer-head">
        <h3>Your Cart</h3>
        <button class="cart-drawer-close" id="cart-drawer-close" aria-label="Close cart">&times;</button>
      </div>
      <div class="cart-drawer-body" id="cart-drawer-body"></div>
      <div class="cart-drawer-foot" id="cart-drawer-foot"></div>
    </aside>
  `;
  document.body.appendChild(wrap);
  document.getElementById('cart-drawer-overlay').addEventListener('click', closeDrawer);
  document.getElementById('cart-drawer-close').addEventListener('click', closeDrawer);

  document.getElementById('cart-drawer-body').addEventListener('click', (e) => {
    const minus = e.target.closest('.qty-minus');
    const plus = e.target.closest('.qty-plus');
    const remove = e.target.closest('.cart-remove-btn');
    if (minus) {
      const item = readCart().find(i => lineKey(i.id, i.size) === minus.dataset.id);
      if (item) updateQty(minus.dataset.id, item.qty - 1);
    } else if (plus) {
      const item = readCart().find(i => lineKey(i.id, i.size) === plus.dataset.id);
      if (item) updateQty(plus.dataset.id, item.qty + 1);
    } else if (remove) {
      removeFromCart(remove.dataset.id);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  buildDrawer();
  renderBadge();
  renderDrawer();

  const toggle = document.getElementById('cart-toggle');
  if (toggle) toggle.addEventListener('click', openDrawer);

  // Delegated (capture phase, so it runs before the product-card's own
  // bubble-phase click-to-expand listener in main.js) so it works for
  // server-rendered shop cards without also toggling the card open.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.add-to-cart-btn');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    addToCart({
      id: btn.dataset.id,
      sku: btn.dataset.sku,
      name: btn.dataset.name,
      size: btn.dataset.size || null,
      price: parseFloat(btn.dataset.price) || 0,
      image_url: btn.dataset.image || '',
      maxQty: parseInt(btn.dataset.quantity, 10) || 0
    });
    const original = btn.textContent;
    btn.textContent = 'Added ✓';
    btn.classList.add('added');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('added'); }, 1200);
    openDrawer();
  }, true);
});
