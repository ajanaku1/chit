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

  const forward = () => goTo('metrics');
  const back = () => goTo('hero');

  window.addEventListener('wheel', (e) => {
    if (mobile() || Math.abs(e.deltaY) <= 12) return;
    e.deltaY > 0 ? forward() : back();
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if (mobile()) return;
    if (['ArrowDown', 'PageDown', ' ', 'Spacebar'].includes(e.key)) { e.preventDefault(); forward(); }
    else if (['ArrowUp', 'PageUp', 'Escape'].includes(e.key)) { e.preventDefault(); back(); }
  });

  let touchStartY = null;
  window.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
  window.addEventListener('touchend', (e) => {
    if (mobile() || touchStartY === null) return;
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
  const contractAddress = document.getElementById('contract-address');
  const copyButton = document.getElementById('copy-contract-address');
  const status = document.getElementById('copy-contract-status');

  if (contractAddress && copyButton && status) {
    let resetTimer;
    copyButton.addEventListener('click', async () => {
      clearTimeout(resetTimer);
      try {
        await navigator.clipboard.writeText(contractAddress.textContent ?? "");
        copyButton.textContent = "Copied";
        copyButton.classList.remove("error");
        status.textContent = "Contract address copied.";
      } catch {
        copyButton.textContent = "Copy failed. Try again.";
        copyButton.classList.add("error");
        status.textContent = "Copy failed. Try again.";
      }
      resetTimer = setTimeout(() => {
        copyButton.textContent = "Copy";
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

  /* Mobile nav */
  const burger = document.querySelector('.burger');
  const nav = document.querySelector('.nav');
  burger.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', String(open));
  });
})();
