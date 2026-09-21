/* Chit landing — morph proposal. Built to landing-brief.md. */
(() => {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = () => window.matchMedia('(max-width:767px)').matches;
  const page = document.querySelector('.page');

  /* ── 10. LED DOT TYPE ───────────────────────────────────
     7-row bitmaps. The brief's table plus "c" and "o", which the
     brief's own copy did not need and ours does. Same construction. */
  const GLYPHS = {
    '0': ['01110','10001','10011','10101','11001','10001','01110'],
    '1': ['010','110','010','010','010','010','111'],
    '2': ['01110','10001','00001','00010','00100','01000','11111'],
    '3': ['11110','00001','00001','01110','00001','00001','11110'],
    '4': ['00010','00110','01010','10010','11111','00010','00010'],
    '5': ['11111','10000','10000','11110','00001','00001','11110'],
    '6': ['01110','10000','10000','11110','10001','10001','01110'],
    '7': ['11111','00001','00010','00100','01000','01000','01000'],
    '8': ['01110','10001','10001','01110','10001','10001','01110'],
    '9': ['01110','10001','10001','01111','00001','00001','01110'],
    '.': ['0','0','0','0','0','0','1'],
    'I': ['111','010','010','010','010','010','111'],
    'a': ['00000','00000','01110','00001','01111','10001','01111'],
    'c': ['00000','00000','01110','10001','10000','10001','01110'],
    'e': ['00000','00000','01110','10001','11111','10000','01110'],
    'g': ['00000','00000','01111','10001','01111','00001','01110'],
    'i': ['1','0','1','1','1','1','1'],
    'l': ['10','10','10','10','10','10','01'],
    'n': ['00000','00000','11110','10001','10001','10001','10001'],
    'o': ['00000','00000','01110','10001','10001','10001','01110'],
    't': ['010','010','111','010','010','010','001'],
    'r': ['00000','00000','10110','11001','10000','10000','10000'],
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function renderDots(host) {
    const text = host.dataset.dots;
    if (!text) return;

    const isWord = host.classList.contains('dot-word');
    const pitchX = isWord ? 4 : 5;
    const pitchY = 4;
    const radius = isWord ? 1.8 : (host.closest('.metric--draw') ? 2.32 : 1.55);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'dot-svg');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');

    let x = 0;
    for (const char of text) {
      const glyph = GLYPHS[char];
      if (!glyph) {
        // The brief is explicit: never silently skip an unknown character.
        throw new Error(`dot type: no glyph for ${JSON.stringify(char)}`);
      }
      glyph.forEach((rowBits, row) => {
        [...rowBits].forEach((bit, col) => {
          if (bit !== '1') return;
          const c = document.createElementNS(SVG_NS, 'circle');
          c.setAttribute('cx', String(x + col * pitchX + 1.55));
          c.setAttribute('cy', String(row * pitchY + 1.55));
          c.setAttribute('r', String(radius));
          svg.appendChild(c);
        });
      });
      x += glyph[0].length * pitchX + pitchX; // one column gap between glyphs
    }

    svg.setAttribute('viewBox', `0 0 ${Math.max(x - pitchX, 1)} 28`);
    host.replaceChildren(svg);
  }

  document.querySelectorAll('[data-dots]').forEach((host) => {
    try { renderDots(host); }
    catch (err) { console.error(err); }
  });

  /* ── Gauge ticks ─────────────────────────────────────── */
  const ticks = document.getElementById('gaugeTicks');
  if (ticks) {
    for (let i = 0; i <= 22; i++) {
      const angle = (190 + i * 5) * Math.PI / 180;
      const major = i % 5 === 0;
      const outer = 142;
      const inner = major ? 129 : 133;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'tick');
      line.setAttribute('x1', String(163 + Math.cos(angle) * inner));
      line.setAttribute('y1', String(163 + Math.sin(angle) * inner));
      line.setAttribute('x2', String(163 + Math.cos(angle) * outer));
      line.setAttribute('y2', String(163 + Math.sin(angle) * outer));
      line.setAttribute('stroke-width', major ? '1.5' : '1');
      ticks.appendChild(line);
    }
  }

  /* ── 8. LOAD REVEAL ──────────────────────────────────── */
  // Card items carry their timing as data-rv="delay/duration" in ms.
  document.querySelectorAll('[data-rv]').forEach((el) => {
    const [delay, dur] = el.dataset.rv.split('/');
    el.style.setProperty('--rv-delay', `${delay}ms`);
    el.style.setProperty('--rv-dur', `${dur}ms`);
  });

  const revealTargets = document.querySelectorAll('[data-reveal]');
  revealTargets.forEach((el) => {
    el.addEventListener('animationend', (e) => {
      if (e.animationName === 'reveal') el.classList.add('is-revealed');
    });
  });

  window.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(() => {
      document.documentElement.classList.add('is-ready');
      // Screen A is never part of the screen B entrance.
      document.documentElement.classList.remove('entrance-active');
    });
  });

  /* ── 9. SCREEN B ENTRANCE (first show only) ──────────── */
  let entranceDone = false;
  function runEntrance() {
    if (entranceDone || reduced) return;
    entranceDone = true;
    document.documentElement.classList.add('entrance-active');

    const last = document.querySelector(
      mobile() ? '.card--delay .learn-more' : '.card--exit .learn-more'
    );
    const finish = () => {
      document.documentElement.classList.remove('entrance-active');
      clearTimeout(window.__entranceFailsafe);
    };
    if (last) last.addEventListener('animationend', finish, { once: true });
    else finish();
  }

  /* ── 7. THE MORPH ────────────────────────────────────── */
  let morphing = false;
  let cooldownUntil = 0;

  function canTrigger() {
    return !morphing && Date.now() >= cooldownUntil;
  }

  function goTo(screen) {
    if (mobile()) {
      if (screen === 'metrics') {
        document.querySelector('.screen--metrics')
          .scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
      }
      return;
    }
    if (page.dataset.screen === screen || !canTrigger()) return;

    morphing = true;
    page.classList.add('is-morphing');
    page.dataset.screen = screen;
    if (screen === 'metrics') runEntrance();

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      page.classList.remove('is-morphing');
      morphing = false;
      cooldownUntil = Date.now() + 250;
      clearTimeout(failsafe);
    };
    const onEnd = (e) => {
      if (e.target !== wash || e.propertyName !== 'clip-path') return;
      wash.removeEventListener('transitionend', onEnd);
      settle();
    };
    const wash = document.querySelector('.wash');
    wash.addEventListener('transitionend', onEnd);
    const failsafe = setTimeout(() => {
      wash.removeEventListener('transitionend', onEnd);
      settle();
    }, 1200);

    const cue = document.querySelector('.morph-cue');
    cue.querySelector('.morph-cue__label').textContent =
      screen === 'metrics' ? 'back' : 'the numbers';
    cue.setAttribute('aria-label',
      screen === 'metrics' ? 'Back to the top' : 'See the numbers');
  }

  /* ── 6.6 LIMIT SHEETS ─────────────────────────────────
     Each Learn More is a link to its sheet, so the page works with no
     script via :target. With script, the hash never changes: the sheet
     opens in place, the cards behind it go inert, and focus moves in and
     back out with the reader. */
  const limits = document.querySelector('.limits');
  const cards = document.querySelector('.cards');
  let openSheet = null;
  let opener = null;

  /** The sheet a "#limit-…" hash names, or null for any other hash. */
  function sheetAt(hash) {
    const el = document.getElementById(hash.slice(1));
    return el && el.classList.contains('limit') ? el : null;
  }

  function setExpanded(sheet, expanded) {
    document.querySelectorAll(`[aria-controls="${sheet.id}"]`)
      .forEach((a) => a.setAttribute('aria-expanded', String(expanded)));
  }

  function hideSheet(sheet) {
    sheet.classList.remove('is-open');
    setExpanded(sheet, false);
  }

  function openLimit(sheet, trigger) {
    if (openSheet === sheet) return;
    // Switching sheets keeps the original opener, so closing later returns
    // focus to the card the reader actually left.
    if (openSheet) hideSheet(openSheet);
    else opener = trigger;
    openSheet = sheet;
    sheet.classList.add('is-open');
    setExpanded(sheet, true);
    limits.classList.add('has-open');
    if (!mobile()) cards.inert = true;
    sheet.focus({ preventScroll: true });
  }

  function closeLimit() {
    if (!openSheet) return;
    hideSheet(openSheet);
    openSheet = null;
    limits.classList.remove('has-open');
    cards.inert = false;
    if (opener) opener.focus({ preventScroll: true });
    opener = null;
  }

  /* ── 6.7 MODAL SHEETS ─────────────────────────────────
     Launch app / Open the app show how far along the build is; Read the
     boundary shows where the privacy line sits. They sit over either
     screen, so the main region goes inert rather than the cards. */
  const main = document.getElementById('main-content');
  let openModal = null;
  let modalOpener = null;

  function modalAt(hash) {
    const el = document.getElementById(hash.slice(1));
    return el && el.classList.contains('modal') ? el : null;
  }

  function showModal(modal, trigger) {
    if (openModal === modal) return;
    if (openModal) hideSheet(openModal);
    else modalOpener = trigger;
    openModal = modal;
    modal.classList.add('is-open');
    setExpanded(modal, true);
    main.inert = true;
    modal.focus({ preventScroll: true });
    if (modal.id === 'progress') loadProgress().then(renderProgress);
  }

  function closeModal() {
    if (!openModal) return;
    hideSheet(openModal);
    openModal = null;
    main.inert = false;
    if (modalOpener) modalOpener.focus({ preventScroll: true });
    modalOpener = null;
  }

  /* A click on the scrim, outside the sheet itself, closes the modal. */
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  });

  /* Every in-page link inside .page routes here; the skip link is outside. */
  document.querySelectorAll('.page a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const href = a.getAttribute('href');
      const modal = modalAt(href);
      const sheet = sheetAt(href);
      if (modal) { showModal(modal, a); return; }
      if (sheet) {
        closeModal();
        if (page.dataset.screen !== 'metrics') goTo('metrics');
        openLimit(sheet, a);
        return;
      }
      if (href === '#the-page') closeModal();
      else closeLimit();
    });
  });

  /* ── Build progress, rendered from progress.json ─────
     Nothing below invents a number. The file is recomputed from the task
     lists in the Vercel build (PROGRESS.md); the API serves the public
     mirror's copy, and the same-origin file is the deploy's own fallback. */
  async function loadProgress() {
    for (const url of ['/api/progress', 'progress.json']) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) return await res.json();
      } catch { /* try the next source */ }
    }
    return null;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function codeItem(code, note, state) {
    const li = el('li');
    if (state) li.dataset.state = state;
    li.append(el('code', '', code), el('span', '', note));
    return li;
  }

  /** One task list: its title, done / total, and a bar. */
  function specItem(spec) {
    const li = el('li');
    const row = el('div', 'spec__row');
    const count = el('span', 'spec__count');
    count.append(el('strong', '', String(spec.done)), ` / ${spec.total}`);
    row.append(el('span', '', spec.title), count);
    const bar = el('div', 'bar');
    const fill = el('span');
    fill.style.setProperty('--pct', `${spec.total ? (spec.done / spec.total) * 100 : 0}%`);
    bar.append(fill);
    li.append(row, bar);
    return li;
  }

  function renderProgress(p) {
    const slot = (name) => document.querySelector(`[data-progress="${name}"]`);
    if (!p) {
      slot('stages').replaceChildren(codeItem('Unavailable', 'the repo record could not be reached just now'));
      slot('stamp').textContent = 'Try again in a moment.';
      return;
    }
    const dots = slot('percent');
    dots.dataset.dots = String(p.tasks.percent);
    dots.setAttribute('aria-label', String(p.tasks.percent));
    renderDots(dots);
    slot('tasks').textContent = `${p.tasks.done} of ${p.tasks.total} specced tasks done`;

    slot('stages').replaceChildren(...p.stages.map((s) =>
      codeItem(`Stage ${s.stage} · ${s.name}`, s.status, /^Live/.test(s.status) ? 'done' : undefined)));

    slot('specs').replaceChildren(...p.specs.map(specItem));

    const open = p.specs.flatMap((spec) => spec.open);
    slot('open').replaceChildren(...(open.length
      ? open.map((t) => codeItem(t.id, t.text))
      : [codeItem('Nothing open', 'every specced task has passed its gate')]));

    // A build without git history knows the commit and nothing more; the stamp says what is known.
    const when = p.committedAt ? `, ${new Date(p.committedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
    const count = p.commits ? ` ${p.commits} commits so far.` : '';
    slot('stamp').textContent = `Read from commit ${p.commit ?? 'unknown'}${when}.${count} Stage 3 has no task list yet, so it is not in the count.`;
  }

  /* ── Triggers. A sheet is one step deeper than screen B, so "back"
     closes it before it leaves the screen, and "forward" waits. ────── */
  const forward = () => { if (!openModal && !openSheet) goTo('metrics'); };
  const back = () => {
    if (openModal) closeModal();
    else if (openSheet) closeLimit();
    else goTo('hero');
  };

  window.addEventListener('wheel', (e) => {
    if (mobile() || openModal || Math.abs(e.deltaY) <= 12) return;
    // inside an open sheet the wheel scrolls its body; only a wheel-up at
    // the top of that body reads as "back"
    if (openSheet && (e.deltaY > 0 || openSheet.querySelector('.limit__body').scrollTop > 0)) return;
    e.deltaY > 0 ? forward() : back();
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (mobile()) return;
    if (openModal) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
      return;
    }
    if (openSheet) {
      // the sheet's own body scrolls with the arrow keys; only Escape is ours
      if (e.key === 'Escape') { e.preventDefault(); back(); }
      return;
    }
    if (['ArrowDown', 'PageDown', ' ', 'Spacebar'].includes(e.key)) { e.preventDefault(); forward(); }
    else if (['ArrowUp', 'PageUp', 'Escape'].includes(e.key)) { e.preventDefault(); back(); }
  });

  /* A sheet linked to directly opens on arrival; a limit sheet brings screen B. */
  const arrivalModal = modalAt(location.hash);
  const arrival = sheetAt(location.hash);
  if (arrivalModal || arrival) history.replaceState(null, '', location.pathname + location.search);
  if (arrivalModal) showModal(arrivalModal, document.querySelector(`[aria-controls="${arrivalModal.id}"]`));
  if (arrival) {
    goTo('metrics');
    openLimit(arrival, document.querySelector(`[aria-controls="${arrival.id}"]`));
  }

  let touchStartY = null;
  window.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
  window.addEventListener('touchend', (e) => {
    if (mobile() || openModal || touchStartY === null) return;
    const dy = touchStartY - e.changedTouches[0].clientY;
    if (Math.abs(dy) > 40) dy > 0 ? forward() : back();
    touchStartY = null;
  }, { passive: true });

  document.querySelector('.morph-cue').addEventListener('click', () => {
    page.dataset.screen === 'metrics' ? back() : forward();
  });

  /* Mobile: run the entrance the first time screen B scrolls into view. */
  if (mobile() && !reduced) {
    const metrics = document.querySelector('.screen--metrics');
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        runEntrance();
        io.disconnect();
      });
    }, { threshold: 0.2 });
    io.observe(metrics);
  }


  /* ── Contract address copy ───────────────────────────── */
  /* The address shows shortened, but its text is whole: this copies all of it. */
  const contractAddress = document.getElementById('contract-address');
  const copyButton = document.getElementById('copy-contract-address');
  const status = document.getElementById('copy-contract-status');
  const copyLabel = copyButton?.querySelector('.contract-row__action');

  if (contractAddress && copyButton && status && copyLabel) {
    let resetTimer;
    copyButton.addEventListener('click', async () => {
      clearTimeout(resetTimer);
      try {
        await navigator.clipboard.writeText(contractAddress.textContent ?? "");
        copyLabel.textContent = "Copied";
        copyButton.dataset.state = "copied";
        copyButton.classList.remove("error");
        status.textContent = "CHIT token address copied.";
      } catch {
        copyLabel.textContent = "Copy failed. Try again.";
        delete copyButton.dataset.state;
        copyButton.classList.add("error");
        status.textContent = "Copy failed. Try again.";
      }
      resetTimer = setTimeout(() => {
        copyLabel.textContent = "Copy";
        delete copyButton.dataset.state;
        copyButton.classList.remove("error");
        status.textContent = "";
      }, 2000);
    });
  }

  /* Reveal the screen B entrance once it is actually seen, then stop watching. */
  const metricsSection = document.querySelector('.screen--metrics');
  if (metricsSection && !reduced) {
    const seen = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        seen.unobserve(entry.target);
        runEntrance();
      });
    }, { threshold: 0.2 });
    seen.observe(metricsSection);
  }

  /* Mobile nav, if the masthead has one. The landing currently does not:
     every destination it had was inside the app, which is not public yet. */
  const burger = document.querySelector('.burger');
  const nav = document.querySelector('.nav');
  if (burger && nav) {
    burger.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', String(open));
    });
  }
})();
