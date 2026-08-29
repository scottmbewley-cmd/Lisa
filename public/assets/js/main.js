document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('open'));
  }

  document.querySelectorAll('.product-card').forEach(card => {
    card.addEventListener('click', () => card.classList.toggle('open'));
  });
});
