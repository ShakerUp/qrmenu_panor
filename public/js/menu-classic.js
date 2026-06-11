const tabs = [...document.querySelectorAll('.classic-tab')];

const sections = tabs
  .map((tab) => document.querySelector(tab.getAttribute('href')))
  .filter(Boolean);

function setActiveTab(sectionId) {
  tabs.forEach((tab) => {
    const active = tab.getAttribute('href') === `#${sectionId}`;
    tab.classList.toggle('active', active);

    if (active) {
      tab.scrollIntoView({
        behavior: 'smooth',
        inline: 'center',
        block: 'nearest',
      });
    }
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

    const top = target.getBoundingClientRect().top + window.scrollY - offset;

    window.scrollTo({
      top,
      behavior: 'smooth',
    });
  });
});

function updateActiveOnScroll() {
  const nav = document.querySelector('.classic-tabs');
  const offset = nav ? nav.offsetHeight + 80 : 130;

  let current = sections[0];

  sections.forEach((section) => {
    if (section.offsetTop <= window.scrollY + offset) {
      current = section;
    }
  });

  if (current) {
    setActiveTab(current.id);
  }
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
