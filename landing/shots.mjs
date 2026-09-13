import { chromium } from 'playwright';

const OUT = process.argv[2];
const URL = 'http://localhost:8778/index.html';
const errors = [];

const browser = await chromium.launch();

async function shoot(name, width, height, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion: opts.reducedMotion ?? 'no-preference',
  });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`${name}: PAGEERROR ${e.message}`));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(opts.settle ?? 3200);

  if (opts.morph) {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(2600);
  }

  // horizontal overflow check
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // dot type actually rendered?
  const dots = await page.evaluate(() =>
    [...document.querySelectorAll('[data-dots]')].map(d => d.querySelector('svg.dot-svg') ? 'svg' : 'EMPTY'));
  // which screen is showing
  const screen = await page.evaluate(() => document.querySelector('.page').dataset.screen);

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: opts.fullPage ?? false });
  console.log(`${name.padEnd(26)} overflowX=${overflow}px  screen=${screen}  dots=[${dots.join(',')}]`);
  await ctx.close();
}

await shoot('desktop-a-hero', 1606, 1161);
await shoot('desktop-b-numbers', 1606, 1161, { morph: true });
await shoot('desktop-1440', 1440, 900);
await shoot('tablet-portrait', 1024, 1180);
await shoot('mobile-390', 390, 844, { fullPage: true });
await shoot('reduced-motion', 1606, 1161, { reducedMotion: 'reduce', settle: 800 });

await browser.close();
console.log(errors.length ? '\nCONSOLE ERRORS:\n' + errors.join('\n') : '\nNo console errors.');
