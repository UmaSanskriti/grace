import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const chromium = (await import(require.resolve('@sparticuz/chromium'))).default;
const browser = await puppeteer.launch({ args: [...chromium.args, '--no-sandbox'], executablePath: await chromium.executablePath(), headless: 'shell' });
let fails = 0;
const check = (c, n) => { console.log((c?'  PASS  ':'  FAIL  ')+n); if(!c) fails++; };

for (const width of [390, 560, 1200]) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  await page.goto('file://' + process.cwd() + '/index.html', { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 650));
  const sel = width >= 880 ? '.g-head-link' : '.g-bn-item';
  const vis = s => page.evaluate(x => { const el = document.querySelector(x); return !!el && !el.hidden && el.getBoundingClientRect().height > 0; }, s);
  const tap = async r => {
    const b = await page.$(sel + '[data-route="' + r + '"]');
    const box = await b.boundingBox();
    if (!box || box.x < 0 || box.x + box.width > width) return false;
    await page.mouse.click(box.x + box.width/2, box.y + box.height/2);
    await new Promise(res => setTimeout(res, 550));
    return true;
  };
  console.log('viewport ' + width + 'px (' + (width >= 880 ? 'header nav' : 'dock') + '):');
  check(await tap('progress') && await vis('#progress') && !(await vis('.g-hero')), 'tap arrangements → view shown');
  check(await tap('home') && await vis('.g-hero') && !(await vis('#progress')), 'tap Home → home restored');
  const onscreen = await page.evaluate(s => {
    return [...document.querySelectorAll(s + '[data-route]')].every(b => {
      const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height > 0;
    });
  }, sel);
  check(onscreen, 'both nav controls fully on-screen');
  await page.close();
}
await browser.close();
console.log(fails ? fails + ' FAILURE(S)' : 'REAL-BROWSER MATRIX GREEN');
process.exit(fails ? 1 : 0);
