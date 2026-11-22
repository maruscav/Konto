// js/ui.js: privacy mode (blur amounts) and the mobile menu drawer.
// Load this file BEFORE plan.js and app.js. app.js and plan.js call isPrivate()
// when they build charts; this file calls refreshChartsForPrivacy() (defined in
// app.js) when the mode changes.

const PRIVACY_IDLE_MS = 60 * 1000;
const rootEl = document.documentElement;

// ---------------- Privacy mode ----------------
// index.html ships with class="private" on <html>, so every load starts hidden.
// Nothing is stored: the numbers are hidden again after a lock, after 60 seconds
// without activity, and when the tab or app goes to the background.

function isPrivate() { return rootEl.classList.contains('private'); }

let privacyIdleTimer = null;

function armPrivacyIdle() {
  clearTimeout(privacyIdleTimer);
  if (!isPrivate()) privacyIdleTimer = setTimeout(() => setPrivate(true), PRIVACY_IDLE_MS);
}

function setPrivate(on) {
  const changed = isPrivate() !== on;
  rootEl.classList.toggle('private', on);
  document.querySelectorAll('.privacy-toggle-btn').forEach((btn) => {
    const label = on ? 'Show numbers' : 'Hide numbers';
    const text = btn.querySelector('.privacy-label');
    if (text) text.textContent = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  armPrivacyIdle();
  if (changed && typeof refreshChartsForPrivacy === 'function') refreshChartsForPrivacy();
}

document.querySelectorAll('.privacy-toggle-btn').forEach((btn) => {
  btn.addEventListener('click', () => setPrivate(!isPrivate()));
});

['pointerdown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach((ev) => {
  window.addEventListener(ev, armPrivacyIdle, { passive: true, capture: true });
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) setPrivate(true);
});

setPrivate(true);

// ---------------- Mobile drawer ----------------

const drawerEl = document.getElementById('sidebar');
const backdropEl = document.getElementById('drawer-backdrop');
const menuBtn = document.getElementById('menu-btn');
const topbarTitle = document.getElementById('topbar-title');
const mobileMq = window.matchMedia('(max-width: 820px)');

function openDrawer() {
  drawerEl.classList.add('open');
  backdropEl.classList.add('open');
  rootEl.classList.add('drawer-open');
  menuBtn.setAttribute('aria-expanded', 'true');
  menuBtn.setAttribute('aria-label', 'Close menu');
}

function closeDrawer(returnFocus) {
  if (!drawerEl.classList.contains('open')) return;
  drawerEl.classList.remove('open');
  backdropEl.classList.remove('open');
  rootEl.classList.remove('drawer-open');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.setAttribute('aria-label', 'Open menu');
  if (returnFocus) menuBtn.focus();
}

menuBtn.addEventListener('click', () => {
  if (drawerEl.classList.contains('open')) closeDrawer(); else openDrawer();
});
backdropEl.addEventListener('click', () => closeDrawer());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer(true);
});
mobileMq.addEventListener('change', () => closeDrawer());

// Menu items are plain divs: make them reachable and usable from the keyboard,
// show the current page in the top bar, and close the drawer after choosing one.
document.querySelectorAll('.nav-item').forEach((item) => {
  item.setAttribute('tabindex', '0');
  item.setAttribute('role', 'button');
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.click(); }
  });
  item.addEventListener('click', () => {
    topbarTitle.textContent = item.textContent.trim();
    window.scrollTo(0, 0);
    closeDrawer();
  });
});

// Locking or signing out hides the app shell: hide the numbers and the menu too.
const shellEl = document.getElementById('app-shell');
new MutationObserver(() => {
  if (shellEl.style.display === 'none') { setPrivate(true); closeDrawer(); }
}).observe(shellEl, { attributes: true, attributeFilter: ['style'] });

// Footer buttons inside the drawer close it after use.
document.querySelectorAll('#sidebar .sidebar-footer button').forEach((btn) => {
  if (btn.classList.contains('privacy-toggle-btn') || btn.classList.contains('theme-toggle-btn')) return;
  btn.addEventListener('click', () => closeDrawer());
});
