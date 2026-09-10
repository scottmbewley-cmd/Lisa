document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('open'));
  }

  document.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('open'));
  });

  // Ring size pickers: each ring card with sizes starts with its
  // Add-to-Cart button disabled (server-rendered) until a size is chosen.
  // Choosing a size updates the button's data-size/data-quantity so
  // cart.js's existing delegated click handler picks up the right values
  // with no changes needed there beyond reading data-size.
  document.querySelectorAll('.size-select').forEach(select => {
    let sizes = [];
    try { sizes = JSON.parse(select.dataset.sizes || '[]'); } catch (e) { sizes = []; }
    const btn = select.closest('.product-info').querySelector('.add-to-cart-btn');
    select.addEventListener('change', () => {
      const chosen = sizes.find(s => s.size === select.value);
      if (!chosen || chosen.shop_qty <= 0) {
        btn.disabled = true;
        btn.dataset.size = '';
        btn.textContent = 'Select a size';
        return;
      }
      btn.disabled = false;
      btn.dataset.size = chosen.size;
      btn.dataset.quantity = String(chosen.shop_qty);
      btn.textContent = 'Add to Cart';
    });
  });

  const searchInput = document.getElementById('shop-search');
  const chips = document.querySelectorAll('.chip');
  if (searchInput) {
    let activeCat = '';
    function applyShopFilter() {
      const q = searchInput.value.trim().toLowerCase();
      const cards = document.querySelectorAll('.product-card');
      let anyVisible = false;
      cards.forEach(card => {
        const matchesCat = !activeCat || card.dataset.category === activeCat;
        const matchesSearch = !q || (card.dataset.search || '').includes(q);
        const show = matchesCat && matchesSearch;
        card.style.display = show ? '' : 'none';
        if (show) anyVisible = true;
      });
      const emptyMsg = document.getElementById('shop-empty-msg');
      if (emptyMsg) emptyMsg.style.display = anyVisible ? 'none' : 'block';
    }
    searchInput.addEventListener('input', applyShopFilter);
    chips.forEach(chip => {
      chip.addEventListener('click', () => {
        chips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        activeCat = chip.dataset.cat;
        applyShopFilter();
      });
    });
  }
});
