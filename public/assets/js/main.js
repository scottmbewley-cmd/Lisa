document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('open'));
  }

  document.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('open'));
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
