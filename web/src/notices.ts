// "Repudiationes · Merita" in the bottom left: each opens a panel over the cathedral with the
// disclaimers or the credits, in Latin first, with English a click away. The text is static
// and lives in index.html; nothing from the database is ever put into the DOM.

type Lang = 'la' | 'en';

export function setUpNotices(doc: Document = document) {
  const dialog = doc.getElementById('notice') as HTMLDialogElement | null;
  if (!dialog) return;
  const title = dialog.querySelector<HTMLElement>('#notice-title')!;
  const body = dialog.querySelector<HTMLElement>('.body')!;
  let notice = 'repudiationes';
  // Latin unless you have asked for English since the page opened.
  let lang: Lang = 'la';

  const show = () => {
    for (const s of dialog.querySelectorAll<HTMLElement>('section[data-notice]')) {
      const on = s.dataset.notice === notice && s.lang === lang;
      s.hidden = !on;
      if (on) title.textContent = s.dataset.title ?? '';
    }
    for (const b of dialog.querySelectorAll<HTMLButtonElement>('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    dialog.lang = lang;
  };

  for (const b of doc.querySelectorAll<HTMLButtonElement>('[data-open]')) {
    b.addEventListener('click', () => {
      notice = b.dataset.open!;
      show();
      body.scrollTop = 0;
      if (!dialog.open) dialog.showModal();
    });
  }
  for (const b of dialog.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
    b.addEventListener('click', () => {
      lang = b.dataset.lang as Lang;
      show();
    });
  }
  // There is no close button: a click on the backdrop (outside the panel) closes it, and
  // Escape is built in.
  dialog.addEventListener('click', (e) => {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
  show();
}
