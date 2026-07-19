const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const fileArg = process.argv.find(a => a.startsWith('--file='));
const html = fs.readFileSync(fileArg ? fileArg.slice(7) : './index.html', 'utf-8');
const suppressHash = process.argv.includes('--no-hashchange'); // simulate sandbox that blocks navigation
const startUrl = process.argv.find(a => a.startsWith('--hash='));

const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/scrollTo|scrollIntoView|Not implemented/.test(String(e))) console.error('JSDOM:', e.message); });

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://grace.test/' + (startUrl ? startUrl.slice(7) : ''),
  virtualConsole: vc,
  beforeParse(w) {
    w.requestAnimationFrame = (fn) => w.setTimeout(fn, 0); w.matchMedia = () => ({ matches: false, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} });
    if (suppressHash) {
      const orig = w.addEventListener.bind(w);
      w.addEventListener = (t, fn, o) => { if (t === 'hashchange') return; orig(t, fn, o); };
    }
  }
});
const d = dom.window.document;
const $ = id => d.getElementById(id);
let pass = 0, fail = 0;
const ok = (cond, name) => { cond ? pass++ : fail++; console.log((cond ? '  PASS' : '  FAIL') + '  ' + name); };
const vis = el => !el.hidden;

console.log(`mode: ${suppressHash ? 'navigation-blocked (sandbox sim)' : 'normal'}${startUrl ? ', boot ' + startUrl.slice(7) : ''}`);

if (startUrl) {
  ok(vis($('progress')), 'texted-link boot: arrangements view shown');
  ok(vis($('dashLive')) && !vis($('dashEmpty')), 'texted-link boot: live dashboard active');
} else {
  ok(!vis($('progress')), 'boot: arrangements hidden');
  ok(vis(d.querySelector('.g-hero')), 'boot: home visible');

  // ── the reported bug: tap second bottom-nav tab
  d.querySelector('.g-bn-item[data-route="progress"]').click();
  ok(vis($('progress')), 'tap "Your arrangements": view shown');
  ok(!vis(d.querySelector('.g-hero')), 'tap "Your arrangements": home hidden');
  ok(d.querySelector('.g-bn-item[data-route="progress"]').getAttribute('aria-current') === 'page', 'tab marked current');

  // back to Home
  d.querySelector('.g-bn-item[data-route="home"]').click();
  ok(vis(d.querySelector('.g-hero')) && !vis($('progress')), 'tap "Home": home restored');

  // footer link route
  d.querySelector('.g-site-foot [data-route="progress"]').click();
  ok(vis($('progress')), 'footer "Your arrangements" link routes');

  // regression: the host link-popup fires on <a> clicks — there must be none
  ok(d.querySelectorAll('a').length === 0, 'zero <a> elements in the document');

  // brand routes home; skip button moves focus to main
  d.querySelector('.g-bn-item[data-route="progress"]').click();
  d.querySelector('.g-brand').click();
  ok(vis(d.querySelector('.g-hero')), 'brand button routes home');
  $('skipBtn').click();
  ok(d.activeElement === $('main'), 'skip button focuses main');

  // master CTA components: every data-mode CTA is an identical instance
  const ctas = [...d.querySelectorAll('button[data-mode]')].filter(b => b.id !== 'headCall');
  ok(ctas.length >= 8, `found ${ctas.length} CTA instances`);
  ok(ctas.every(b => /\bbtn\b/.test(b.className) && /g-btn-(fill|line)/.test(b.className)), 'all CTAs use master btn classes');
  ok(ctas.every(b => b.querySelector('svg.g-ico use')), 'all CTAs carry the master icon');
  ok(!d.querySelector('.g-btn-sm') && !d.querySelector('.g-assure'), 'btn-sm variant and hero chips removed');

  // sample dashboard toggles
  $('dashPreview').click();
  ok(vis($('dashLive')) && !vis($('dashEmpty')), 'preview shows sample dashboard');
  $('dashHide').click();
  ok(!vis($('dashLive')) && vis($('dashEmpty')), 'hide restores empty state');

  // contact sheet opens from the dashboard CTA
  d.querySelector('#dashEmpty [data-mode="text"]').click();
  ok(!$('sheetRoot').hidden, 'dashboard CTA opens contact sheet');
  ok($('sendLabel').textContent.trim() === 'Send the first text', 'sheet preset to text mode');
}
console.log(fail ? `\n${fail} FAILURE(S)` : '\nall green');
process.exit(fail ? 1 : 0);
