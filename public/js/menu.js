const tabs = [...document.querySelectorAll('.tab')];
const sections = tabs
  .map((tab) => document.querySelector(tab.getAttribute('href')))
  .filter(Boolean);

const observer = new IntersectionObserver(
  (entries) => {
    const visible = entries
      .filter((e) => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    tabs.forEach((tab) =>
      tab.classList.toggle('active', tab.getAttribute('href') === `#${visible.target.id}`),
    );
  },
  { rootMargin: '-90px 0px -55% 0px', threshold: [0.1, 0.3, 0.6] },
);

sections.forEach((section) => observer.observe(section));

function updateDescriptions() {
  document.querySelectorAll('.desc').forEach((desc) => {
    desc.classList.remove('is-overflow');

    if (desc.scrollHeight > desc.clientHeight + 1) {
      desc.classList.add('is-overflow');
    }
  });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.desc-more');
  if (!btn) return;

  const desc = btn.closest('.desc');

  desc.classList.add('expanded');

  btn.remove();
});

window.addEventListener('load', updateDescriptions);
window.addEventListener('resize', updateDescriptions);
