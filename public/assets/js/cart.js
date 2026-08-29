// Evelle — browser-local cart (localStorage), shared across all public pages.
const CART_KEY = 'evelle_cart_v1';
const CHECKOUT_ENABLED = true;
const UK_SHIPPING_FLAT = 2.50; // must match the shipping rate used in checkout.html's order summary

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

function addToCart(product, qty) {
  qty = qty || 1;
  const items = readCart();
  const existing = items.find(i => String(i.id) === String(product.id));
  const cap = product.maxQty && product.maxQty > 0 ? product.maxQty : null;
  if (existing) {
    existing.qty += qty;
    if (cap) existing.qty = Math.min(existing.qty, cap);
  } else {
    items.push({
      id: product.id, sku: product.sku, name: product.name,
      price: product.price, image_url: product.image_url,
      qty: cap ? Math.min(qty, cap) : qty, maxQty: cap
    });
  }
  writeCart(items);
}

function updateQty(id, qty) {
  let items = readCart();
  const item = items.find(i => String(i.id) === String(id));
  if (!item) return;
  if (qty < 1) { items = items.filter(i => String(i.id) !== String(id)); }
  else { item.qty = item.maxQty ? Math.min(qty, item.maxQty) : qty; }
  writeCart(items);
}

function removeFromCart(id) {
  writeCart(readCart().filter(i => String(i.id) !== String(id)));
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

  body.innerHTML = items.map(item => `
    <div class="cart-line" data-id="${esc(item.id)}">
      ${item.image_url ? `<img class="cart-line-img" src="${esc(item.image_url)}" alt="${esc(item.name)}">` : '<div class="cart-line-img"></div>'}
      <div class="cart-line-info">
        <span class="n">${esc(item.name)}</span>
        <span class="s">SKU ${esc(item.sku)}</span>
        <div class="p">£${(item.price * item.qty).toFixed(2)}</div>
        <div class="cart-qty-row">
          <button class="cart-qty-btn qty-minus" data-id="${esc(item.id)}">&minus;</button>
          <span class="cart-qty-val">${item.qty}</span>
          <button class="cart-qty-btn qty-plus" data-id="${esc(item.id)}"${item.maxQty && item.qty >= item.maxQty ? ' disabled' : ''}>+</button>
          <button class="cart-remove-btn" data-id="${esc(item.id)}">Remove</button>
        </div>
      </div>
    </div>
  `).join('');

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
      const item = readCart().find(i => String(i.id) === String(minus.dataset.id));
      if (item) updateQty(item.id, item.qty - 1);
    } else if (plus) {
      const item = readCart().find(i => String(i.id) === String(plus.dataset.id));
      if (item) updateQty(item.id, item.qty + 1);
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
