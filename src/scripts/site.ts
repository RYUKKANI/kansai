const menuButton = document.querySelector<HTMLButtonElement>('.mobile-menu-toggle');
const mobileNavigation = document.querySelector<HTMLElement>('#mobile-navigation');
function closeMenu() {
  menuButton?.setAttribute('aria-expanded', 'false');
  menuButton?.setAttribute('aria-label', 'メニューを開く');
  if (mobileNavigation) mobileNavigation.hidden = true;
}
menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
  if (mobileNavigation) mobileNavigation.hidden = !open;
});
mobileNavigation?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
window.matchMedia('(min-width: 1025px)').addEventListener('change', event => { if (event.matches) closeMenu(); });

document.querySelectorAll<HTMLElement>('[data-filter-group]').forEach(group => {
  const buttons = group.querySelectorAll<HTMLButtonElement>('[data-filter]');
  const cards = group.querySelectorAll<HTMLElement>('[data-category]');
  buttons.forEach(button => button.addEventListener('click', () => {
    const category = button.dataset.filter;
    let count = 0;
    cards.forEach(card => { card.hidden = category !== 'all' && card.dataset.category !== category; if (!card.hidden) count++; });
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    const counter = group.querySelector<HTMLElement>('[data-news-count]');
    if (counter) counter.textContent = `${count} ${count === 1 ? 'STORY' : 'STORIES'}`;
  }));
});

document.querySelectorAll<HTMLElement>('[data-tabs]').forEach(group => {
  const tabs = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  function selectTab(selected: HTMLButtonElement) {
    tabs.forEach(tab => {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      if (panel) panel.hidden = !active;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let nextIndex: number | undefined;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      const next = tabs[nextIndex];
      if (next) { selectTab(next); next.focus(); }
    });
  });
});

const searchDialog = document.querySelector<HTMLDialogElement>('.search-dialog');
const searchInput = document.querySelector<HTMLInputElement>('#news-search');
const searchResults = document.querySelectorAll<HTMLAnchorElement>('[data-search-text]');
document.querySelectorAll<HTMLButtonElement>('.search-open').forEach(button => button.addEventListener('click', () => {
  closeMenu();
  searchDialog?.showModal();
  searchInput?.focus();
}));
searchInput?.addEventListener('input', () => {
  const query = searchInput.value.trim().toLocaleLowerCase('ja').normalize('NFKC');
  let count = 0;
  searchResults.forEach(result => {
    const text = (result.dataset.searchText ?? '').toLocaleLowerCase('ja').normalize('NFKC');
    result.hidden = !text.includes(query);
    if (!result.hidden) count++;
  });
  const empty = document.querySelector<HTMLElement>('.search-empty');
  if (empty) empty.hidden = count > 0;
});

const photoDialog = document.querySelector<HTMLDialogElement>('.photo-dialog');
document.querySelectorAll<HTMLButtonElement>('[data-lightbox]').forEach(button => button.addEventListener('click', () => {
  const image = document.querySelector<HTMLImageElement>('#lightbox-image');
  const caption = document.querySelector<HTMLElement>('#lightbox-caption');
  const source = document.querySelector<HTMLAnchorElement>('#lightbox-source');
  if (!image || !button.dataset.image) return;
  image.src = button.dataset.image;
  image.alt = button.dataset.alt ?? '関西ユナイテッドFCの活動写真';
  if (caption) caption.textContent = button.dataset.caption ?? '';
  if (source && button.dataset.source) source.href = button.dataset.source;
  photoDialog?.showModal();
}));

document.querySelectorAll<HTMLDialogElement>('dialog').forEach(dialog => {
  dialog.querySelectorAll<HTMLButtonElement>('[data-close-dialog]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
});
