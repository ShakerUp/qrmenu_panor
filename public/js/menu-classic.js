/* ─── TABS ─────────────────────────────────────────────── */
const tabs = [...document.querySelectorAll('.classic-tab')];
const sections = tabs.map((t) => document.querySelector(t.getAttribute('href'))).filter(Boolean);

function setActiveTab(id) {
  tabs.forEach((t) => {
    const active = t.getAttribute('href') === `#${id}`;
    t.classList.toggle('active', active);
    if (active) t.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });
}

tabs.forEach((tab) => {
  tab.addEventListener('click', (e) => {
    e.preventDefault();
    const target = document.querySelector(tab.getAttribute('href'));
    if (!target) return;
    setActiveTab(target.id);
    const nav = document.querySelector('.classic-tabs');
    const offset = nav ? nav.offsetHeight + 10 : 70;
    window.scrollTo({
      top: target.getBoundingClientRect().top + window.scrollY - offset,
      behavior: 'smooth',
    });
  });
});

function updateActiveOnScroll() {
  const nav = document.querySelector('.classic-tabs');
  const offset = nav ? nav.offsetHeight + 80 : 130;
  let current = sections[0];
  sections.forEach((s) => {
    if (s.offsetTop <= window.scrollY + offset) current = s;
  });
  if (current) setActiveTab(current.id);
}

let ticking = false;
window.addEventListener('scroll', () => {
  if (ticking) return;
  window.requestAnimationFrame(() => {
    updateActiveOnScroll();
    ticking = false;
  });
  ticking = true;
});
window.addEventListener('load', updateActiveOnScroll);
window.addEventListener('resize', updateActiveOnScroll);

/* ─── SUB-GROUP TOGGLE ──────────────────────────────────── */

/* Схлопываем все подразделы сразу при загрузке (без анимации) */
document.querySelectorAll('.sub-group-list').forEach((list) => {
  list.style.height = '0';
});
document.querySelectorAll('.sub-group-toggle').forEach((btn) => {
  btn.setAttribute('aria-expanded', 'false');
});

function toggleGroup(btn) {
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  const listId = btn.getAttribute('aria-controls');
  const list = document.getElementById(listId);

  btn.setAttribute('aria-expanded', String(!expanded));

  if (expanded) {
    /* collapse: фиксируем высоту → 0 */
    list.style.height = list.scrollHeight + 'px';
    list.offsetHeight; /* force reflow */
    list.style.height = '0';
  } else {
    /* expand: 0 → scrollHeight */
    list.style.height = list.scrollHeight + 'px';
    list.addEventListener(
      'transitionend',
      function onEnd() {
        list.style.height = 'auto';
        list.removeEventListener('transitionend', onEnd);
      },
      { once: true },
    );
  }
}

/* ─── LIGHTBOX ──────────────────────────────────────────── */
const lb = document.getElementById('lb');
const lbImg = document.getElementById('lbImg');

function lbShow(src) {
  lbImg.src = src;
  lb.classList.add('lb-open');
  document.body.style.overflow = 'hidden';
}

function lbHide() {
  lb.classList.remove('lb-open');
  document.body.style.overflow = '';
  /* небольшая задержка чтобы не мелькало src */
  setTimeout(() => {
    lbImg.src = '';
  }, 300);
}

function lbClose(e) {
  if (e.target === lb) lbHide();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lb.classList.contains('lb-open')) lbHide();
});

/* touch swipe down to close */
let touchStartY = 0;
lb.addEventListener(
  'touchstart',
  (e) => {
    touchStartY = e.touches[0].clientY;
  },
  { passive: true },
);
lb.addEventListener(
  'touchend',
  (e) => {
    if (e.changedTouches[0].clientY - touchStartY > 60) lbHide();
  },
  { passive: true },
);
