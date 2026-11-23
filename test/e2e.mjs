// Plays the game in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { playInto } from '../dev/play.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

const browser = await pw.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('requestfailed', r => problems.push('failed: ' + r.url()));
page.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });

const settled = () => page.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
const state = () => page.evaluate(() => window.patience.state);
const step = async () => { await page.waitForTimeout(260); await settled(); };

await page.goto(base);
await page.evaluate(() => document.fonts.ready);
await settled();

// A winnable deal comes up on its own.
let s = await state();
assert.equal(await page.locator('.card').count(), 52);
assert.equal(s.stock.length, 24);
assert.match(await page.textContent('#status'), /Klondike, draw one · Deal [\d,]+/);

// A known deal from here on.
await page.evaluate(() => window.patience.newGame('k1', 11705));
await page.waitForTimeout(1200);
await settled();

// Tap the stock to turn a card over, and Undo puts it back.
await page.click('.spot[data-pile="stock"]', { force: true });
await step();
s = await state();
assert.equal(s.stock.length, 23);
assert.equal(s.waste.length + s.found.flat().length, 1, 'the card is on the waste, or went up if it was an ace');
assert.equal(s.moves, 1);
await page.click('#b-undo');
await step();
s = await state();
assert.equal(s.waste.length, 0);
assert.equal(s.stock.length, 24);

// Space presses a button reached by keyboard, and otherwise uses the deck, even after a button was clicked.
await page.click('#b-menu');
await page.keyboard.press('Escape');
await page.keyboard.press(' ');
assert.equal(await page.isHidden('#sheet-menu'), false, 'Space pressed the Menu button');
assert.equal((await state()).stock.length, 24, 'and left the deck alone');
await page.keyboard.press('Escape');
await page.click('#b-hint');
await page.waitForSelector('.hint', { timeout: 10000 });
await page.keyboard.press(' ');
await step();
assert.equal((await state()).stock.length, 23, 'Space used the deck');
await page.click('#b-undo');
await step();

// The menu keeps the keyboard to itself, and closing it gives focus back to Menu.
const behind = () => page.evaluate(() => !!document.activeElement.closest('#game, #toast'));
await page.click('#b-menu');
for (let i = 0; i < 16; i++) { await page.keyboard.press('Tab'); assert.equal(await behind(), false, 'Tab left the menu'); }
await page.keyboard.press('Escape');
assert.equal(await page.evaluate(() => document.activeElement.id), 'b-menu', 'focus back on Menu');

// Find a card that can move somewhere, drawing until there is one.
async function findMove() {
  for (let i = 0; i < 40; i++) {
    const m = await page.evaluate(async () => {
      const k = await import('./js/games/klondike.js');
      const s = window.patience.state;
      for (const id of ['waste', ...k.TABLEAU]) {
        const v = k.visible(s, id);
        if (!v.length) continue;
        const to = k.bestTarget(s, id, 1);
        if (to) return { id, to, c: v[v.length - 1] };
      }
      return null;
    });
    if (m) return m;
    await page.click('.spot[data-pile="stock"]', { force: true });
    await step();
  }
  throw new Error('no move found');
}
const where = c => page.evaluate(c => {
  const s = window.patience.state;
  if (s.waste.includes(c)) return 'waste';
  const f = s.found.findIndex(f => f.includes(c));
  if (f >= 0) return 'f' + f;
  const t = s.tab.findIndex(t => t.up.includes(c));
  return t >= 0 ? 't' + t : 'stock';
}, c);

// Tap a card: it goes to the best place.
let m = await findMove();
await page.click(`.card[data-c="${m.c}"]`, { position: { x: 12, y: 10 } });
await step();
const after = await where(m.c);
assert.ok(after === m.to || after[0] === 'f', `tapped card went to ${after}, expected ${m.to}`);

// Drag a card onto a column it fits.
const drag = await page.evaluate(async () => {
  const k = await import('./js/games/klondike.js');
  const s = window.patience.state;
  for (const id of ['waste', ...k.TABLEAU]) {
    const v = k.visible(s, id);
    if (!v.length) continue;
    for (const to of k.TABLEAU) if (to !== id && k.canDrop(s, [v[v.length - 1]], to) && s.tab[+to.slice(1)].up.length) return { id, to, c: v[v.length - 1] };
  }
  return null;
});
if (drag) {
  const from = await page.locator(`.card[data-c="${drag.c}"]`).boundingBox();
  const target = await page.evaluate(to => {
    const s = window.patience.state, t = s.tab[+to.slice(1)];
    return t.up[t.up.length - 1];
  }, drag.to);
  const onto = await page.locator(`.card[data-c="${target}"]`).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + 10);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + from.width / 2 + ((onto.x - from.x) * i) / 8, from.y + 10 + ((onto.y + 30 - from.y) * i) / 8);
  await page.mouse.up();
  await step();
  assert.equal(await where(drag.c), drag.to, 'dragged card landed');
} else {
  console.log('(no drag move on this deal at this point; skipped the drag check)');
}

// Dropping a card where it doesn't fit sends it back.
s = await state();
const lone = s.tab.findIndex(t => t.up.length);
const card0 = s.tab[lone].up[s.tab[lone].up.length - 1];
const box = await page.locator(`.card[data-c="${card0}"]`).boundingBox();
await page.mouse.move(box.x + 10, box.y + 10);
await page.mouse.down();
await page.mouse.move(box.x + 10, box.y + 400, { steps: 6 });
await page.mouse.up();
await step();
assert.equal(await where(card0), 't' + lone, 'a bad drop goes back');

// Hint lights up a move.
await page.click('#b-hint');
await page.waitForSelector('.hint', { timeout: 10000 });

// The game is still there after a reload.
s = await state();
await page.reload();
await settled();
const back = await state();
assert.equal(back.deal, s.deal);
assert.deepEqual(back.tab, s.tab);
assert.equal(await page.isDisabled('#b-undo'), false, 'undo survives a reload');

// Each setting's name is its bold line, with the rest as its description, and the record's list says what it's for.
await page.click('#b-menu');
assert.equal(await page.getByRole('checkbox', { name: 'Send cards up by themselves', exact: true }).count(), 1, 'a setting named by its bold line');
assert.equal(await page.getAttribute('#o-auto', 'aria-describedby').then(id => page.textContent('#' + id)), 'Once nothing on the table could still need a card, it goes to its foundation. In Klondike and FreeCell; Spider always clears a finished run by itself.');
assert.equal(await page.getByRole('combobox', { name: 'Your record for', exact: true }).count(), 1);
await page.click('#sheet-menu .close');

// Settings stick.
await page.click('#b-menu');
await page.click('label:has(#o-four)');
assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-four')), true);
await page.click('#sheet-menu .close');
await page.reload();
await settled();
assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-four')), true);

// New game, drawing three.
await page.click('#b-new');
assert.equal(await page.isVisible('#new-note'), true, 'leaving a game part way is a loss');
await page.click('[data-v="k3"]');
await page.waitForTimeout(1500);
await settled();
s = await state();
assert.equal(s.draw, 3);
assert.match(await page.textContent('#status'), /Klondike, draw three/);
await page.waitForTimeout(800);
assert.equal(await page.evaluate(() => [...document.querySelectorAll('.card, .card .flip')].filter(el => el.style.transitionDelay).length), 0,
  'no card is left with a dealing delay');
await page.click('.spot[data-pile="stock"]', { force: true });
await step();
s = await state();
assert.ok(s.waste.length === 3 || s.found.some(f => f.length), 'three cards turned over');

// Win a game: the record counts it.
const before = await page.evaluate(() => ({ ...window.patience.stats.k3 }));
await page.evaluate(playInto, { v: 'k3', n: 11705, steps: 9999 });
await page.waitForSelector('#won:not([hidden])', { timeout: 20000 });
await page.mouse.click(30, 300);
await page.waitForSelector('#won .panel:not([hidden])');
assert.match(await page.textContent('#won-line'), /Klondike, draw three, deal\s11,705/);
const afterWin = await page.evaluate(() => window.patience.stats.k3);
assert.equal(afterWin.won, before.won + 1);
assert.equal(afterWin.streak, 1);
await page.click('#b-again');
await page.waitForTimeout(1500);
await settled();
assert.equal(await page.isHidden('#won'), true);
s = await state();
assert.equal(s.moves, 0);
assert.equal(await page.locator('.card[style*="visibility: hidden"]').count(), 0, 'every card is back on the table');

// FreeCell: every card face up, and a card with nowhere else to go goes to a free cell.
await page.click('#b-new');
await page.click('[data-v="fc"]');
await page.waitForTimeout(2000);
await settled();
s = await state();
assert.equal(s.v, 'fc');
assert.match(await page.textContent('#status'), /FreeCell · Deal [\d,]+/);
assert.equal(await page.locator('.card').count(), 52);
assert.equal(await page.locator('.card.down').count(), 0, 'all face up');
await page.evaluate(() => window.patience.newGame('fc', 617));
await page.waitForTimeout(2000);
await settled();
// A jack, queen or king with a card on it doesn't show the edge of its frame under that card (617 has six).
const peeks = await page.evaluate(() => window.patience.state.tab.flatMap(t => t.slice(0, -1).flatMap((c, i) => {
  if (c % 13 < 10) return [];
  const frame = document.querySelector(`.card[data-c="${c}"] .court`).getBoundingClientRect();
  return [document.querySelector(`.card[data-c="${t[i + 1]}"]`).getBoundingClientRect().top - frame.top];
})));
assert.equal(peeks.length, 6);
assert.ok(peeks.every(d => d <= 0), `a frame shows ${Math.max(...peeks).toFixed(1)}px under the next card`);
// New game opens on the game being played, so Enter deals another of the same, and says it's the one being played.
await page.keyboard.press('n');
assert.equal(await page.evaluate(() => document.activeElement.dataset.v), 'fc', 'FreeCell has focus');
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[aria-current]')].map(b => [b.dataset.v, b.getAttribute('aria-current')])), [['fc', 'true']]);
await page.keyboard.press('Escape');
// In deal 617 the 4 of hearts on top of the fourth column has nowhere to go but a free cell.
s = await state();
const four = s.tab[3][s.tab[3].length - 1];
await page.click(`.card[data-c="${four}"]`, { position: { x: 12, y: 10 } });
await step();
s = await state();
assert.equal(s.cells.filter(c => c !== null).length, 1, 'the card went to a free cell');
await page.click('#b-undo');
await step();
assert.equal((await state()).cells.filter(c => c !== null).length, 0);
await page.click('#b-hint');
await page.waitForSelector('.hint', { timeout: 15000 });
await page.evaluate(playInto, { v: 'fc', n: 617, steps: 9999 });
await page.waitForSelector('#won:not([hidden])', { timeout: 30000 });
await page.mouse.click(30, 300);
await page.waitForSelector('#won .panel:not([hidden])');
assert.match(await page.textContent('#won-line'), /FreeCell, deal\s617/);
assert.equal(await page.evaluate(() => window.patience.stats.fc.won), 1);

// Spider: two decks; the deck deals a row onto every column, but not while one is empty.
await page.click('#b-pick');
await page.waitForSelector('#sheet-new:not([hidden])');
await page.click('[data-v="s1"]');
await page.waitForTimeout(2200);
await settled();
s = await state();
assert.equal(s.v, 's1');
assert.equal(await page.locator('.card').count(), 104);
assert.equal(s.stock.length, 50);
await page.click('.spot[data-pile="stock"]', { force: true });
await page.waitForTimeout(900);
await settled();
s = await state();
assert.equal(s.stock.length, 40, 'a row was dealt');
await page.evaluate(() => {
  const s = structuredClone(window.patience.state);
  s.tab[9] = { down: [], up: [] };
  window.patience.load(s);
});
await page.click('.spot[data-pile="stock"]', { force: true });
await page.waitForSelector('#toast:not([hidden])');
assert.match(await page.textContent('#toast'), /empty column/);
assert.equal((await state()).stock.length, 40, 'no row while a column is empty');
assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.spot.hint')].map(el => el.dataset.pile)), ['t9'], 'the empty column lights up');
await page.waitForSelector('.spot[data-pile="t9"]:not(.hint)', { timeout: 3000 });

// Win a Spider game: the cleared runs bounce off.
await page.evaluate(() => window.patience.newGame('s1', 3));
await page.waitForTimeout(2200);
await settled();
await page.evaluate(playInto, { v: 's1', n: 3, steps: 99999 });
await page.waitForSelector('#won:not([hidden])', { timeout: 30000 });
assert.equal(await page.evaluate(() => window.patience.stats.s1.won), 1);
await page.mouse.click(30, 300);
await page.click('#b-again');
await page.waitForTimeout(2200);
await settled();
assert.equal(await page.locator('.card[style*="visibility: hidden"]').count(), 0, 'every card is back on the table');

// A Spider game is still there after a reload, and each game's record has its own place in the menu.
await page.evaluate(() => window.patience.newGame('s2', 5));
await page.waitForTimeout(2200);
await settled();
await page.click('.spot[data-pile="stock"]', { force: true });
await page.waitForTimeout(900);
await settled();
s = await state();
await page.reload();
await settled();
const sp = await state();
assert.equal(sp.v, 's2');
assert.deepEqual(sp.tab, s.tab);
await page.click('#b-menu');
assert.equal(await page.inputValue('#stats-for'), 's2');
await page.selectOption('#stats-for', 'fc');
assert.match(await page.textContent('#stats'), /Won\s*1/);
await page.click('#sheet-menu .close');

// The install sheet and package.json describe it the way the link preview does, all three games.
const og = await page.getAttribute('meta[property="og:description"]', 'content');
const manifest = await page.evaluate(async () => (await (await fetch('manifest.webmanifest')).json()).description);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).description;
assert.deepEqual([manifest, pkg], [og, og]);

// The deal's name and the clock at the top read clearly on the felt, at least 4.5:1, in both palettes.
for (const colorScheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme });
  const ratio = await page.evaluate(() => {
    const felt = getComputedStyle(document.documentElement).getPropertyValue('--felt').trim();
    const bg = [1, 3, 5].map(i => parseInt(felt.slice(i, i + 2), 16));
    const [r, g, b, a = 1] = getComputedStyle(document.getElementById('status')).color.match(/[\d.]+/g).map(Number);
    const fg = [r, g, b].map((v, i) => v * a + bg[i] * (1 - a));
    const lum = c => c.map(v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    return (lum(fg) + 0.05) / (lum(bg) + 0.05);
  });
  assert.ok(ratio >= 4.5, `the header text is ${ratio.toFixed(2)}:1 on the ${colorScheme} felt`);
}
await page.emulateMedia({ colorScheme: 'light' });

// Fits a phone: nothing scrolls sideways.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

assert.deepEqual(problems, [], 'problems while playing');

// Works offline once it has been opened. (Offline, the browser's own requests can fail, and that's no problem.)
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 }).catch(() => {});
await ctx.setOffline(true);
await page.reload();
await settled();
assert.equal(await page.locator('.card').count(), 104, 'the Spider game did not load offline');
await ctx.setOffline(false);
assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems offline');
// A phone with the first version's game and record on it carries both over.
{
  const old = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p2 = await old.newPage();
  await p2.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    // A Klondike game part way, drawing three, saved the way the first version saved it (no `v`).
    const tab = Array.from({ length: 7 }, (_, i) => ({ down: Array.from({ length: i }, (_, k) => 12 + i * 4 + k), up: [i] }));
    localStorage.setItem('patience.v1', JSON.stringify({
      settings: { draw: 3, winnable: true, auto: true, clock: true, four: false, left: false },
      stats: { 1: { played: 9, won: 6, streak: 2, best: 4, fastest: 200000 }, 3: { played: 4, won: 1, streak: 0, best: 1, fastest: 400000 } },
      next: { 1: 1234, 3: 5678 },
      game: { state: { deal: 777, draw: 3, stock: [7, 8, 9], waste: [10, 11], fan: 2, found: [[], [], [], []], tab, moves: 12 }, history: [], elapsed: 60000, counted: true },
    }));
  });
  await p2.goto(base);
  await p2.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const kept = await p2.evaluate(() => ({ s: window.patience.state, stats: window.patience.stats, v: window.patience.settings.variant }));
  assert.equal(kept.s.v, 'k3');
  assert.equal(kept.s.deal, 777);
  assert.equal(kept.v, 'k3');
  assert.equal(kept.stats.k1.won, 6);
  assert.equal(kept.stats.k3.played, 4);
  assert.match(await p2.textContent('#status'), /Klondike, draw three · Deal 777/);
  await old.close();
}

// Choosing another game before the last one has landed: only the last choice is dealt, and nothing breaks.
{
  const c3 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p3 = await c3.newPage();
  const errors = [];
  p3.on('pageerror', e => errors.push(e.message));
  const ready = () => p3.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await p3.goto(base);
  await ready();
  // Deal 2 starts with an ace that goes up by itself; the first deal's timer mustn't try to send it up again.
  await p3.evaluate(() => { window.patience.newGame('k1', 1); setTimeout(() => window.patience.newGame('k1', 2), 50); });
  await p3.waitForTimeout(3000);
  await ready();
  const two = await p3.evaluate(() => window.patience.state);
  assert.equal(two.deal, 2);
  assert.ok(two.found.some(f => f.length), 'the ace went up');
  // Klondike chosen while four-suit Spider is still coming: Klondike stays, and so does its name at the top.
  await p3.evaluate(() => { window.patience.newGame('s4'); window.patience.newGame('k1', 5); });
  await p3.waitForTimeout(2500);
  await ready();
  const five = await p3.evaluate(() => ({ s: window.patience.state, v: window.patience.settings.variant }));
  assert.deepEqual([five.s.v, five.s.deal, five.v], ['k1', 5, 'k1']);
  assert.match(await p3.textContent('#status'), /Klondike, draw one · Deal 5/);

  // A won game is finished. Back at the table from Choose a game, it can't be played on, undone or hinted.
  const wonPanel = async () => {
    await p3.waitForSelector('#won:not([hidden])', { timeout: 30000 });
    await p3.mouse.click(30, 300);
    await p3.waitForSelector('#won .panel:not([hidden])');
  };
  const backToTable = async () => {
    await wonPanel();
    await p3.click('#b-pick');
    assert.equal(await p3.textContent('#b-keep'), 'Close', 'no Keep playing on a won game');
    await p3.click('#b-keep');
  };
  // FreeCell with everything up but the king and queen of diamonds, the king on the queen: tap the king to win.
  await p3.evaluate(() => {
    const D = 3, card = (suit, rank) => suit * 13 + rank - 1;
    window.patience.load({
      v: 'fc', deal: 617, cells: [null, null, null, null], moves: 90,
      tab: [[card(D, 12), card(D, 13)], [], [], [], [], [], [], []],
      found: [0, 1, 2, 3].map(suit => Array.from({ length: suit === D ? 11 : 13 }, (_, i) => card(suit, i + 1))),
    });
  });
  const tapKing = async () => { await p3.click('.card[data-c="51"]', { position: { x: 12, y: 10 } }); };
  await tapKing();
  await wonPanel();
  // The won panel keeps the keyboard to itself too: no starting a game under it.
  for (let i = 0; i < 6; i++) {
    await p3.keyboard.press('Tab');
    assert.equal(await p3.evaluate(() => !!document.activeElement.closest('#game, #toast')), false, 'Tab left the won panel');
  }
  await p3.click('#b-pick');
  await p3.click('#sheet-new button[data-close]');
  const fcWin = await p3.evaluate(() => ({ ...window.patience.stats.fc }));
  assert.equal(fcWin.won, 1);
  assert.equal(await p3.isDisabled('#b-undo'), true, 'no undoing a won game');
  await p3.keyboard.press('z');
  await p3.click('#b-undo', { force: true });
  await p3.waitForTimeout(400);
  assert.equal((await p3.evaluate(() => window.patience.state)).found.flat().length, 52, 'still won');
  // A king dragged back down from its foundation in won Klondike doesn't win it a second time.
  await p3.evaluate(playInto, { v: 'k3', n: 11705, steps: 9999 });
  await backToTable();
  const kWin = await p3.evaluate(() => ({ ...window.patience.stats.k3 }));
  const king = await p3.evaluate(() => window.patience.state.found[0][12]);
  const from = await p3.locator(`.card[data-c="${king}"]`).boundingBox(), to = await p3.locator('.spot[data-pile="t0"]').boundingBox();
  await p3.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await p3.mouse.down();
  await p3.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await p3.mouse.up();
  await p3.waitForTimeout(1500);
  assert.equal(await p3.isHidden('#won'), true, 'not won again');
  // Hint on won Spider says it's won, offers a new game, and stays ready.
  await p3.evaluate(playInto, { v: 's1', n: 3, steps: 99999 });
  await backToTable();
  await p3.click('#b-hint');
  await p3.waitForSelector('#toast:not([hidden])');
  assert.equal(await p3.textContent('#toast'), 'This one’s won.New game');
  assert.equal(await p3.evaluate(() => document.getElementById('b-hint').classList.contains('busy')), false, 'Hint is ready');
  await p3.click('#toast button');
  assert.equal(await p3.isHidden('#sheet-new'), false, 'New game opens the New game sheet');
  assert.equal(await p3.textContent('#b-keep'), 'Close');
  await p3.click('#b-keep');
  assert.deepEqual(await p3.evaluate(() => [window.patience.stats.fc, window.patience.stats.k3]), [fcWin, kWin], 'each win counts once');
  // Start this deal again while another game is still being shuffled: the game started again is the one remembered.
  await p3.evaluate(() => window.patience.newGame('k1', 5));
  await p3.waitForTimeout(2000);
  await ready();
  await p3.click('.spot[data-pile="stock"]', { force: true });
  await ready();
  await p3.evaluate(() => { window.patience.newGame('s2'); document.getElementById('b-restart').click(); });
  await p3.waitForTimeout(2500);
  await ready();
  const again = await p3.evaluate(() => [window.patience.state.v, window.patience.state.deal, window.patience.state.moves, window.patience.settings.variant]);
  assert.deepEqual(again, ['k1', 5, 0, 'k1'], 'Klondike deal 5 started again, and remembered');
  assert.deepEqual(errors, [], 'errors while switching games or after winning');
  await c3.close();
}

// Saved values the page never writes, as from a damaged store, don't stop it starting: it deals a game,
// and keeps the settings and the record when only the game is damaged.
{
  const c4 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p4 = await c4.newPage();
  const errors = [];
  p4.on('pageerror', e => errors.push(e.message));
  await p4.addInitScript(() => {
    const v = sessionStorage.getItem('seed');
    if (v !== null) { localStorage.setItem('patience.v1', v); sessionStorage.removeItem('seed'); }
  });
  await p4.goto(base);
  for (const value of [
    '{"stats":"xx"}',
    '{"game":{"state":null,"history":"x"}}',
    '{"game":{"state":{"v":"k1","deal":5}}}',
    '{"next":"abc"}',
    '{"settings":{"four":true},"stats":{"fc":{"played":3,"won":2,"streak":1,"best":2,"fastest":90000}},"game":{"state":{"v":"fc","deal":5},"history":[null]}}',
  ]) {
    await p4.evaluate(v => sessionStorage.setItem('seed', v), value);
    await p4.reload();
    await p4.waitForFunction(() => window.patience?.state, null, { timeout: 20000 });
    assert.match(await p4.textContent('#status'), /· Deal \d[\d,]*$/, value);
    assert.equal(await p4.locator('.card').count(), 52, value);
  }
  assert.equal(await p4.evaluate(() => document.documentElement.hasAttribute('data-four')), true, 'settings kept');
  assert.equal(await p4.evaluate(() => window.patience.stats.fc.played), 3, 'record kept');
  // A game that can be played, with a damaged Undo history: the game comes back, and Undo stops where the damage is.
  const { klondike } = await import('../js/games/klondike.js');
  const deal3 = klondike.deal(3, 'k1'), drawn = { ...klondike.stock(deal3), moves: 1 }; // deal 3: nothing goes up by itself
  for (const history of [[{}], [{ v: 'k1' }], [deal3, { ...deal3, deal: 6 }], [deal3, { ...deal3, tab: 'x' }], [{ ...deal3, moves: -1 }]]) {
    const value = JSON.stringify({ game: { state: drawn, history, elapsed: -65000, counted: true } });
    await p4.evaluate(v => sessionStorage.setItem('seed', v), value);
    await p4.reload();
    await p4.waitForFunction(() => window.patience?.state, null, { timeout: 20000 });
    assert.deepEqual(await p4.evaluate(() => window.patience.state), drawn, value);
    assert.equal(await p4.textContent('#time'), '0:00', 'no time below nothing');
    assert.equal(await p4.isDisabled('#b-undo'), true, value);
    await p4.keyboard.press('z');
    await p4.click('.spot[data-pile="stock"]', { force: true });
    await p4.waitForFunction(() => window.patience.state.moves === 2, null, { timeout: 5000 });
  }
  // A sound history entry before the damaged one is dropped too, and Undo goes back only through the sound ones.
  await p4.evaluate(v => sessionStorage.setItem('seed', v), JSON.stringify({ game: { state: drawn, history: [{}, deal3], counted: true } }));
  await p4.reload();
  await p4.waitForFunction(() => window.patience?.state, null, { timeout: 20000 });
  await p4.keyboard.press('z');
  await p4.waitForFunction(() => window.patience.state.moves === 0, null, { timeout: 5000 });
  assert.equal(await p4.isDisabled('#b-undo'), true, 'Undo stops at the damage');
  // Settings and a record the page never writes come back as it would write them.
  await p4.evaluate(v => sessionStorage.setItem('seed', v), '{"settings":{"auto":"no","left":"x","clock":0},"stats":{"k1":{"played":2.5,"won":-3,"streak":1,"fastest":-1}}}');
  await p4.reload();
  await p4.waitForFunction(() => window.patience?.state, null, { timeout: 20000 });
  assert.deepEqual(await p4.evaluate(() => [window.patience.settings.auto, window.patience.settings.left, window.patience.settings.clock]), [true, false, true]);
  assert.deepEqual(await p4.evaluate(() => window.patience.stats.k1), { played: 0, won: 0, streak: 1, best: 0, fastest: 0 });
  assert.deepEqual(errors, [], 'errors starting from a damaged save');
  await c4.close();
}

// A long game: after the page is closed, Undo still goes all the way back to the deal (it used to stop 500 moves back).
// And starting a deal again keeps its clock, so a fastest win counts all the time spent on the deal, until it's won.
{
  const c5 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p5 = await c5.newPage();
  const errors = [];
  p5.on('pageerror', e => errors.push(e.message));
  const ready = () => p5.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const press = (key, times) => p5.evaluate(([key, times]) => {
    for (let i = 0; i < times; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key }));
  }, [key, times]);
  await p5.goto(base);
  await ready();
  await p5.evaluate(() => window.patience.newGame('k1', 11705));
  await p5.waitForTimeout(1500);
  await ready();
  await press('d', 600);
  await ready();
  assert.equal((await p5.evaluate(() => window.patience.state)).moves, 600);
  await p5.reload();
  await ready();
  await press('z', 600);
  await ready();
  const dealt = await p5.evaluate(() => window.patience.state);
  assert.deepEqual([dealt.moves, dealt.stock.length, dealt.waste.length], [0, 24, 0], 'Undo went all the way back to the deal');
  assert.equal(await p5.isDisabled('#b-undo'), true);

  await p5.evaluate(() => { const s = structuredClone(window.patience.state); s.moves = 3; window.patience.load(s, 65000); });
  await p5.click('#b-new');
  await p5.click('#b-restart');
  await p5.waitForTimeout(1500);
  await ready();
  assert.equal((await p5.evaluate(() => window.patience.state)).moves, 0, 'started again');
  assert.equal(await p5.textContent('#time'), '1:05', 'and the clock carries on from where it was');

  // Once the deal is won, starting it again is a new game, with a new clock.
  await p5.evaluate(() => {
    const card = (suit, rank) => suit * 13 + rank - 1;
    window.patience.load({
      v: 'k1', deal: 11705, draw: 1, stock: [], waste: [], fan: 0, moves: 140,
      found: [0, 1, 2, 3].map(suit => Array.from({ length: suit === 0 ? 12 : 13 }, (_, i) => card(suit, i + 1))),
      tab: [{ down: [], up: [card(0, 13)] }, ...Array.from({ length: 6 }, () => ({ down: [], up: [] }))],
    }, 65000);
  });
  await p5.waitForSelector('#won:not([hidden])', { timeout: 30000 });
  await p5.mouse.click(30, 300);
  await p5.waitForSelector('#won .panel:not([hidden])');
  await p5.click('#b-pick');
  await p5.click('#b-restart');
  await p5.waitForTimeout(1500);
  await ready();
  assert.equal((await p5.evaluate(() => window.patience.state)).moves, 0, 'the won deal started again');
  assert.equal(await p5.textContent('#time'), '0:00', 'with a new clock');
  assert.deepEqual(errors, [], 'errors in a long game');
  await c5.close();
}

// On a keyboard alone, H lights up a move and Enter plays it. A button the keyboard brought focus to still takes
// Enter itself; a button that kept focus after a click leaves it to the move, as it leaves Space to the deck.
{
  const c6 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p6 = await c6.newPage();
  const errors = [];
  p6.on('pageerror', e => errors.push(e.message));
  const ready = () => p6.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const now = () => p6.evaluate(() => window.patience.state);
  const lit = () => p6.waitForSelector('.hint', { timeout: 20000 });
  await p6.goto(base);
  await ready();
  // Klondike deal 11705 after 18 cards drawn: Hint's move is the 8 of hearts (20) onto the 9 of clubs (34) in the third column.
  await p6.evaluate(async () => {
    const k = await import('./js/games/klondike.js');
    const settle = s => { for (let st; (st = k.autoStep(s));) s = k.move(s, st.from, st.n, st.to); return s; };
    let s = settle(k.deal(11705, 1));
    for (let i = 0; i < 18; i++) s = settle(k.draw(s));
    window.patience.load(s);
  });
  await ready();
  const start = await now();
  assert.equal(start.tab[2].up.at(-1), 34);
  await p6.keyboard.press('Enter');
  await p6.waitForTimeout(300);
  assert.deepEqual(await now(), start, 'with no move lit up, Enter leaves the cards alone');
  await p6.keyboard.press('h');
  await lit();
  assert.equal(await p6.isHidden('#toast'), true, 'a move lit up on the table needs no note');
  await p6.keyboard.press('Enter');
  await ready();
  assert.deepEqual((await now()).tab[2].up.slice(-2), [34, 20], 'H then Enter put the 8 of hearts on the 9 of clubs');
  assert.equal(await p6.locator('.hint').count(), 0, 'and the move is no longer lit up');
  await p6.keyboard.press('z');
  await ready();
  // The table is the first stop for Tab, and New the next. Escape takes focus back to the table, where Enter plays
  // the move Hint is showing, as Space uses the deck.
  await p6.keyboard.press('Tab');
  assert.deepEqual(await p6.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('role'), document.activeElement.getAttribute('aria-label')]),
    ['table', 'group', 'Card table'], 'the first Tab goes to the table');
  await p6.keyboard.press('Tab');
  assert.equal(await p6.evaluate(() => document.activeElement.id), 'b-new');
  await p6.keyboard.press('h');
  await lit();
  await p6.keyboard.press('Escape');
  assert.equal(await p6.evaluate(() => document.activeElement.id), 'table', 'Escape took focus to the table');
  await p6.keyboard.press('Enter');
  await ready();
  assert.deepEqual((await now()).tab[2].up.slice(-2), [34, 20], 'Tab, Tab, H, Escape, Enter played the hint');
  await p6.keyboard.press('z');
  await ready();
  await p6.keyboard.press('Tab');
  assert.equal(await p6.evaluate(() => document.activeElement.id), 'b-new');
  await p6.keyboard.press('h');
  await lit();
  await p6.keyboard.press('Enter');
  assert.equal(await p6.isHidden('#sheet-new'), false, 'Enter pressed New, which the keyboard had brought focus to');
  assert.deepEqual((await now()).tab, start.tab, 'and left the cards alone');
  await p6.keyboard.press('Escape');
  await p6.click('#b-hint');
  await lit();
  await p6.keyboard.press('Enter');
  await ready();
  assert.deepEqual((await now()).tab[2].up.slice(-2), [34, 20], 'after Hint was clicked, Enter played its move');

  // Drawing for a card further down the deck, where only the deck lights up, Hint says which card, until the draw.
  // In deal 11705 the ace of hearts is the top card of the deck, and the ace of spades the 18th.
  await p6.evaluate(() => window.patience.newGame('k1', 11705));
  await p6.waitForTimeout(1500);
  await ready();
  await p6.keyboard.press('h');
  await lit();
  assert.equal(await p6.textContent('#toast'), 'Draw for the ace of hearts.');
  await p6.keyboard.press('Enter');
  await ready();
  assert.equal(await p6.isHidden('#toast'), true, 'the note went with the draw');
  assert.ok((await now()).found.some(f => f[0] === 13), 'and the ace of hearts went up by itself');
  await p6.keyboard.press('h');
  await lit();
  assert.equal(await p6.textContent('#toast'), 'Draw for the ace of spades.');
  // Escape takes the note away too.
  await p6.keyboard.press('Escape');
  assert.equal(await p6.isHidden('#toast'), true, 'Escape took the note away');
  // A key held down does what it does once, so holding Space doesn't flick through the deck; Z keeps stepping back.
  const drawn = (await now()).moves;
  for (let i = 0; i < 4; i++) await p6.keyboard.down(' ');
  await p6.keyboard.up(' ');
  await ready();
  assert.equal((await now()).moves, drawn + 1, 'holding Space drew one card');
  for (let i = 0; i < 2; i++) { await p6.keyboard.press(' '); await ready(); }
  for (let i = 0; i < 3; i++) await p6.keyboard.down('z');
  await p6.keyboard.up('z');
  await ready();
  assert.equal((await now()).moves, drawn, 'holding Z undid all three');

  // Won, while the cards bounce, Enter brings the panel up rather than waiting for it; Enter then deals again, and the
  // table has focus, so Space and Enter are the game's again.
  await p6.evaluate(playInto, { v: 'fc', n: 617, steps: 9999 });
  await p6.waitForSelector('#won:not([hidden])', { timeout: 30000 });
  assert.equal(await p6.isHidden('#won .panel'), true, 'the cards bounce first');
  await p6.keyboard.press('Enter');
  assert.equal(await p6.isHidden('#won .panel'), false, 'Enter brought the won panel up');
  assert.equal(await p6.evaluate(() => document.activeElement.id), 'b-again');
  await p6.keyboard.press('Enter');
  await p6.waitForSelector('#won', { state: 'hidden' });
  await p6.waitForTimeout(1500);
  await ready();
  assert.equal((await now()).moves, 0, 'a new deal');
  assert.equal(await p6.evaluate(() => document.activeElement.id), 'table', 'with the table focused');
  assert.deepEqual(errors, [], 'errors playing from the keyboard');
  await c6.close();
}

// To a screen reader the table is its piles, in the order they're laid out, each named for what it is and what's in
// it, holding the cards that can be seen, in order: no face-down card's rank, no corner letters, and no empty place
// without a name. Klondike deal 52,817 as dealt, then FreeCell and Spider.
{
  const ca = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const pa = await ca.newPage();
  const ready = () => pa.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const cdp = await ca.newCDPSession(pa);
  // The table's part of the accessibility tree: [depth, role, name] for each node a screen reader can reach.
  const tree = async () => {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const byId = new Map(nodes.map(n => [n.nodeId, n])), out = [];
    const walk = (n, d) => {
      if (!n.ignored) out.push([d, n.role?.value, n.name?.value ?? '']);
      for (const k of n.childIds || []) if (byId.has(k)) walk(byId.get(k), n.ignored ? d : d + 1);
    };
    walk(nodes.find(n => n.name?.value === 'Card table' && n.role?.value === 'group'), 0);
    return out;
  };
  const deal = async (v, n) => { await pa.evaluate(([v, n]) => window.patience.newGame(v, n), [v, n]); await pa.waitForTimeout(2000); await ready(); };
  await pa.goto(base);
  await ready();
  await deal('k1', 52817);
  let t = await tree();
  const down = await pa.evaluate(async () => {
    const { cardName } = await import('./js/cards.js');
    const s = window.patience.state;
    return [...s.stock, ...s.tab.flatMap(c => c.down)].map(cardName);
  });
  assert.equal(down.length, 45);
  assert.deepEqual(t.filter(([, , name]) => down.includes(name)), [], 'no face-down card is named');
  assert.deepEqual(t.filter(([, role]) => role === 'StaticText'), [], 'no ranks or letters are read off the cards');
  assert.deepEqual(t.filter(([d]) => d === 1).map(([, role, name]) => `${role}: ${name}`), [
    'image: Foundation, empty', 'image: Foundation, empty', 'image: Foundation, empty', 'image: Foundation, empty',
    'image: Waste, empty', 'image: Deck, 24 cards',
    'group: Column 1', 'group: Column 2, 1 face down', 'group: Column 3, 2 face down', 'group: Column 4, 3 face down',
    'group: Column 5, 4 face down', 'group: Column 6, 5 face down', 'group: Column 7, 6 face down',
  ], 'every place on the table is named, in order');
  assert.deepEqual(t.filter(([d]) => d === 2).map(([, , name]) => name), ['king of hearts', 'queen of diamonds', 'nine of hearts', 'six of clubs', 'seven of clubs', 'four of diamonds', 'seven of spades'],
    'each column holds its face-up card');
  await deal('fc', 617);
  t = await tree();
  assert.deepEqual(t.filter(([d]) => d === 1).map(([, , name]) => name).slice(0, 9), [...Array(4).fill('Free cell, empty'), ...Array(4).fill('Foundation, empty'), 'Column 1']);
  const first = await pa.evaluate(async () => { const { cardName } = await import('./js/cards.js'); return window.patience.state.tab[0].map(cardName); });
  const col1 = t.findIndex(([d, , name]) => d === 1 && name === 'Column 1');
  assert.deepEqual(t.slice(col1 + 1, col1 + 1 + first.length).map(([d, , name]) => `${d} ${name}`), first.map(n => `2 ${n}`), 'the first column holds its cards, bottom to top');
  await deal('s2', 5);
  t = await tree();
  assert.deepEqual(t.filter(([d]) => d === 1).map(([, , name]) => name).slice(0, 3), ['Cleared runs, 0 of 8', 'Deck, 5 rows to deal', 'Column 1, 5 face down']);
  assert.deepEqual(t.filter(([, role]) => role === 'StaticText'), [], 'nor in Spider');
  await ca.close();
}

// Once a move has settled, one line for a screen reader says what happened, once: the cards that went up by themselves
// after it are in the same line. Undo and Hint say so too. The clock never touches it, and the deal's name at the top
// isn't read out after every move.
{
  const cl = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const pl = await cl.newPage();
  const errors = [];
  pl.on('pageerror', e => errors.push(e.message));
  const ready = () => pl.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  // Every line said since last asked.
  const heard = async () => { await pl.waitForTimeout(250); await ready(); return pl.evaluate(() => window.heard.splice(0)); };
  await pl.goto(base);
  await ready();
  assert.deepEqual(await pl.evaluate(() => [document.getElementById('status').getAttribute('aria-live'), document.getElementById('said').getAttribute('aria-live')]), [null, 'polite']);
  await pl.evaluate(() => {
    window.heard = [];
    const el = document.getElementById('said');
    new MutationObserver(() => { if (el.textContent) window.heard.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await pl.evaluate(() => window.patience.newGame('k1', 11705));
  await pl.waitForTimeout(1500);
  assert.deepEqual(await heard(), ['Klondike, draw one, deal 11,705.']);
  await pl.keyboard.press(' ');
  assert.deepEqual(await heard(), ['Drew the ace of hearts. Up by themselves: the ace of hearts.'], 'one line for the draw and the card going up after it');
  await pl.keyboard.press(' ');
  assert.deepEqual(await heard(), ['Drew the 7 of spades.']);
  await pl.keyboard.press('z');
  assert.deepEqual(await heard(), ['Undone.']);
  await pl.keyboard.press('z');
  assert.deepEqual(await heard(), ['Undone.'], 'the same words again are said again');
  await pl.evaluate(() => window.patience.newGame('fc', 617));
  await pl.waitForTimeout(1500);
  assert.deepEqual(await heard(), ['FreeCell, deal 617.']);
  await pl.keyboard.press('h');
  await pl.waitForSelector('.hint', { timeout: 20000 });
  assert.deepEqual(await heard(), ['Hint: the queen of hearts onto the king of clubs.']);
  await pl.keyboard.press('Enter');
  assert.deepEqual(await heard(), ['Queen of hearts onto the king of clubs.']);
  await pl.waitForTimeout(2500);
  assert.deepEqual(await heard(), [], 'nothing while the clock runs');
  assert.deepEqual(errors, [], 'errors saying what happened');
  await cl.close();
}

// Tapping the card Hint lit up plays Hint's move, even where a tap would send it somewhere else, and the hint stays
// lit until the next move. In FreeCell game 617 Hint's first move is the queen of hearts onto the king of clubs in the
// third column, where a tap alone sends it to the second; in Klondike a card Hint wants back down off a foundation,
// which a tap alone leaves where it is, comes down.
{
  const ct = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const pt = await ct.newPage();
  const errors = [];
  pt.on('pageerror', e => errors.push(e.message));
  const ready = () => pt.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const now = () => pt.evaluate(() => window.patience.state);
  const lit = () => pt.evaluate(() => [...document.querySelectorAll('.card.hint')].map(el => +el.dataset.c));
  const tapCard = async c => {
    const b = await pt.locator(`.card[data-c="${c}"]`).boundingBox();
    await pt.touchscreen.tap(b.x + 12, b.y + 10);
  };
  await pt.goto(base);
  await ready();
  await pt.evaluate(() => window.patience.newGame('fc', 617));
  await pt.waitForTimeout(1500);
  await ready();
  assert.equal(await pt.evaluate(async () => (await import('./js/games/freecell.js')).freecell.tapTarget(window.patience.state, 't7', 1)), 't1',
    'a tap alone sends the queen of hearts to the second column');
  await pt.tap('#b-hint');
  await pt.waitForSelector('.hint', { timeout: 20000 });
  assert.deepEqual((await lit()).sort((a, b) => a - b), [24, 38], 'Hint lit the queen of hearts and the king of clubs');
  await pt.waitForTimeout(3600);
  assert.deepEqual((await lit()).length, 2, 'the hint is still lit after it stops pulsing');
  await tapCard(24);
  await ready();
  assert.equal((await now()).tab[2].at(-1), 24, 'the tap put the queen of hearts on the king of clubs, where Hint said');
  assert.equal(await pt.locator('.hint').count(), 0, 'and the hint went with the move');

  // Klondike drawing three, deal 11,705 after 67 moves of Hint's: it wants the 5 of spades back down off the third
  // foundation onto the 6 of diamonds in the sixth column. Tapped, it comes down; and Enter plays a hint long after it's lit.
  const fd = {"v":"k3","deal":11705,"draw":3,"stock":[42,41],"waste":[29,10,9,49],"fan":2,"found":[[13,14,15],[26,27],[0,1,2,3,4],[]],"tab":[{"down":[],"up":[51,37,23,35,47,33,45,31,17]},{"down":[],"up":[38,24,36,22,34,20,6,18,30,16,28,40]},{"down":[],"up":[25]},{"down":[32],"up":[21,7,19,5,43]},{"down":[11],"up":[48,8,46]},{"down":[39],"up":[44]},{"down":[],"up":[12,50]}],"moves":67};
  await pt.evaluate(s => window.patience.load(s), fd);
  await ready();
  await pt.tap('#b-hint');
  await pt.waitForSelector('.hint', { timeout: 20000 });
  assert.deepEqual((await lit()).sort((a, b) => a - b), [4, 44], 'Hint lit the 5 of spades on its foundation and the 6 of diamonds');
  await tapCard(4);
  await ready();
  let s = await now();
  assert.deepEqual([s.found[2].at(-1), s.tab[5].up.at(-1)], [3, 4], 'the tap brought the 5 of spades down onto the 6 of diamonds');
  await pt.tap('#b-undo');
  await ready();
  await pt.tap('#b-hint');
  await pt.waitForSelector('.hint', { timeout: 20000 });
  await pt.waitForTimeout(3600);
  await pt.keyboard.press('Enter');
  await ready();
  assert.equal((await now()).tab[5].up.at(-1), 4, 'Enter played the hint after it stopped pulsing');
  assert.deepEqual(errors, [], 'errors tapping the lit card');
  await ct.close();
}

// A second press of Hint while it's still thinking about the first isn't lost when the cards move in between: it
// answers for the table as it is then. Four-suit Spider deal 35 takes the solver about 100,000 positions.
{
  const cp = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const pp = await cp.newPage();
  const errors = [];
  pp.on('pageerror', e => errors.push(e.message));
  const ready = () => pp.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await pp.goto(base);
  await ready();
  await pp.evaluate(() => window.patience.newGame('s4', 35));
  await pp.waitForTimeout(2000);
  await ready();
  await pp.click('#b-hint');
  assert.ok(await pp.evaluate(() => document.getElementById('b-hint').classList.contains('busy')), 'Hint is thinking');
  await pp.click('.spot[data-pile="stock"]', { force: true });
  assert.equal((await pp.evaluate(() => window.patience.state)).stock.length, 40, 'a row was dealt while Hint was thinking');
  await pp.click('#b-hint');
  await pp.waitForSelector('.hint', { timeout: 30000 });
  assert.deepEqual(errors, [], 'errors pressing Hint twice');
  await cp.close();
}

// Drawing for a card a few draws down the deck, Hint's note and the lit deck stay while the player taps the deck,
// until that card turns up. Klondike drawing one, deal 52,817: the ace of clubs is the fourth card down.
{
  const cd = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const pd = await cd.newPage();
  const errors = [];
  pd.on('pageerror', e => errors.push(e.message));
  const ready = () => pd.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const deckLit = () => pd.evaluate(() => {
    const s = window.patience.state, top = s.stock.at(-1);
    return !!document.querySelector(top === undefined ? '.spot[data-pile="stock"].hint' : `.card[data-c="${top}"].hint`);
  });
  await pd.goto(base);
  await ready();
  await pd.evaluate(() => window.patience.newGame('k1', 52817));
  await pd.waitForTimeout(1500);
  await ready();
  await pd.tap('#b-hint');
  await pd.waitForSelector('.hint', { timeout: 20000 });
  assert.equal(await pd.textContent('#toast'), 'Draw for the ace of clubs.');
  const draw = async () => { await pd.tap('.spot[data-pile="stock"]', { force: true }); await pd.waitForTimeout(400); await ready(); }; // once the card has flown
  for (let i = 1; i <= 3; i++) {
    await draw();
    if (i < 3) {
      assert.equal(await pd.isHidden('#toast'), false, `the note stays after draw ${i}`);
      assert.equal(await pd.textContent('#toast'), 'Draw for the ace of clubs.');
      assert.ok(await deckLit(), `and the deck is lit again after draw ${i}`);
    }
  }
  await pd.waitForTimeout(4500);
  assert.equal(await pd.isHidden('#toast'), false, 'the note has no time limit while it waits');
  await draw();
  assert.equal(await pd.isHidden('#toast'), true, 'the note went once the ace of clubs turned up');
  assert.ok((await pd.evaluate(() => window.patience.state)).found.some(f => f[0] === 26), 'and it went up by itself');
  assert.equal(await pd.locator('.hint').count(), 0, 'and nothing is lit');
  // Doing anything other than drawing ends it.
  await pd.tap('#b-undo');
  await ready();
  await pd.tap('#b-hint');
  await pd.waitForSelector('.hint', { timeout: 20000 });
  assert.equal(await pd.textContent('#toast'), 'Draw for the ace of clubs.');
  await pd.tap('#b-undo');
  await ready();
  assert.equal(await pd.isHidden('#toast'), true, 'Undo takes the note away');
  assert.deepEqual(errors, [], 'errors drawing for a card');
  await cd.close();
}

// When Hint takes more than a moment, the line at the top says it's thinking, and goes back once it has answered.
// Four-suit Spider deal 35 takes the solver about 100,000 positions; the processor is slowed to a phone's here.
{
  const ck = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const pk = await ck.newPage();
  const errors = [];
  pk.on('pageerror', e => errors.push(e.message));
  const ready = () => pk.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await pk.goto(base);
  await ready();
  await pk.evaluate(() => window.patience.newGame('s4', 35));
  await pk.waitForTimeout(2000);
  await ready();
  const cdp = await ck.newCDPSession(pk);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await pk.click('#b-hint');
  await pk.waitForFunction(() => document.getElementById('status').textContent === 'Thinking…', null, { timeout: 5000 });
  await pk.waitForFunction(() => document.getElementById('said').textContent === 'Thinking…', null, { timeout: 2000 }); // and a screen reader hears it
  await pk.waitForSelector('.hint', { timeout: 60000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  assert.equal(await pk.textContent('#status'), 'Spider, four suits · Deal 35', 'back to the game and deal once Hint answered');
  assert.deepEqual(errors, [], 'errors while Hint thought');
  await ck.close();
}

// Swipes near the screen's sides. On Android with gesture navigation a swipe that starts near either side is the
// phone's Back, and Chrome has its own swipe to go Back or Forward. A swipe sideways is nobody's, so it can't run on
// into Chrome's: the page doesn't overscroll, and the table takes every touch.
{
  const c7 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const p7 = await c7.newPage();
  await p7.goto(base);
  await p7.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const look = await p7.evaluate(() => ['html', 'body', '#table'].map(s => { const c = getComputedStyle(document.querySelector(s)); return [s, c.overscrollBehaviorX, c.touchAction]; }));
  assert.deepEqual(look.slice(0, 2).map(([s, o]) => [s, o]), [['html', 'none'], ['body', 'none']], 'the page should not overscroll sideways');
  assert.equal(look[2][2], 'none', 'the table should take every touch');
  await c7.close();
}

// On a phone's touch screen, every card and empty place keeps 24 px from the screen's sides, where Android's back
// gesture starts, in every game and at any phone width, with the deck on either side. The cards stay big enough to
// read: Spider's, the narrowest, are more than 22 px across at 320 px. With a mouse, the table is as it was.
{
  const c8 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const p8 = await c8.newPage();
  await p8.goto(base);
  await p8.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const edges = () => p8.evaluate(() => {
    const r = [...document.querySelectorAll('#table .card, #table .spot')].map(e => e.getBoundingClientRect()).filter(r => r.width);
    return { left: Math.min(...r.map(b => b.left)), right: innerWidth - Math.max(...r.map(b => b.right)), cw: r[0].width };
  });
  for (const [width, height] of [[320, 568], [360, 740], [390, 844], [412, 915]]) {
    await p8.setViewportSize({ width, height });
    for (const left of [false, true]) {
      await p8.evaluate(left => { const o = document.getElementById('o-left'); if (o.checked !== left) o.click(); }, left);
      for (const v of ['k1', 'k3', 'fc', 's2']) {
        await p8.evaluate(v => window.patience.newGame(v, 5), v);
        await p8.waitForTimeout(400);
        await p8.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
        const e = await edges();
        assert.ok(e.left >= 23.5 && e.right >= 23.5, `${v} at ${width} px${left ? ', deck on the left' : ''}: a card is ${Math.min(e.left, e.right).toFixed(1)} px from the screen's side`);
        assert.ok(e.cw >= 22.5, `${v} at ${width} px: the cards are ${e.cw} px across`);
      }
    }
  }
  await c8.close();
  const c9 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p9 = await c9.newPage();
  await p9.goto(base);
  await p9.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  assert.equal(await p9.evaluate(() => Math.round(Math.min(...[...document.querySelectorAll('#table .card, #table .spot')].map(e => e.getBoundingClientRect().left)))), 9, 'with a mouse, the table keeps its own margin');
  await c9.close();
}

// A Back that comes while a card is held, or within a second of the browser taking the touch away from the table (as
// Android's back gesture does to a finger picking up a card near the screen's side), is a slip: the game stays, as
// it was. A Back a while later leaves the game in one press, as it always has: the guard's extra history entry goes on
// when a finger touches the table and comes off a second after it lifts.
{
  const c10 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const p10 = await c10.newPage();
  const errors = [];
  p10.on('pageerror', e => errors.push(e.message));
  const ready = () => p10.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const now = () => p10.evaluate(() => JSON.stringify(window.patience.state));
  const onGame = async why => { await p10.waitForTimeout(300); assert.equal(p10.url(), base, why); assert.equal(await p10.locator('.card').count(), 52, why); };
  await p10.goto(base + 'icon.svg');
  await p10.goto(base);
  await ready();
  await p10.evaluate(() => window.patience.newGame('k1', 11705));
  await p10.waitForTimeout(1500);
  await ready();
  await p10.tap('#status');
  const guarded = () => p10.evaluate(() => history.state?.__edgeGuard === true);
  assert.equal(await guarded(), false, 'no extra history entry before the table is touched');
  const start = await now();
  // The card at the foot of the first column, by the screen's side, picked up and dragged with a finger: Back comes mid-drag, and the drag carries on.
  const cdp = await c10.newCDPSession(p10);
  const box = await p10.locator(`.card[data-c="${JSON.parse(start).tab[0].up.at(-1)}"]`).boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const touch = (type, dx = 0, dy = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x: x + dx, y: y + dy }] });
  await touch('touchStart');
  assert.equal(await guarded(), true, 'a finger down on the table adds the extra entry');
  await touch('touchMove', -10, 20); await touch('touchMove', -30, 60);
  assert.equal(await p10.locator('.card.drag').count(), 1, 'the card is being dragged');
  await p10.evaluate(() => history.back());
  await onGame('a Back mid-drag should stay in the game');
  assert.equal(await p10.locator('.card.drag').count(), 1, 'and the card is still in hand');
  await touch('touchEnd');
  await p10.waitForTimeout(300);
  assert.equal(await now(), start, 'let go off any pile, the card went back');
  await p10.waitForTimeout(1300);
  assert.equal(await guarded(), false, 'a second after the finger lifts, the extra entry is gone again');
  // Picked up again, the browser takes the touch, and a Back follows: the card goes back, and the game stays.
  await touch('touchStart'); await touch('touchMove', -10, 20);
  assert.equal(await p10.locator('.card.drag').count(), 1, 'the card is being dragged again');
  await touch('touchCancel');
  await p10.evaluate(() => history.back());
  await onGame('a Back just after the touch was taken should stay in the game');
  assert.equal(await now(), start, 'the game is as it was');
  assert.equal(await p10.locator('.card.drag').count(), 0);
  // The same with pointer events alone.
  await p10.waitForTimeout(1300);
  assert.equal(await guarded(), false, 'and a second after the touch was taken, too');
  await p10.evaluate(() => { const t = document.getElementById('table'); t.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, bubbles: true })); t.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9, bubbles: true })); });
  await p10.goBack({ waitUntil: 'commit', timeout: 1000 }).catch(() => {});
  await onGame('a Back just after a cancelled touch should stay in the game');
  assert.equal(await now(), start, 'the game is still as it was');
  // A second later, Back leaves in one press.
  await p10.tap('#status');
  await p10.waitForTimeout(1300);
  assert.equal(await guarded(), false, 'with nothing on the table, there is no extra entry to press Back through');
  await p10.goBack();
  await p10.waitForTimeout(300);
  assert.equal(p10.url(), base + 'icon.svg', 'a Back a while after should leave the game');
  assert.deepEqual(errors, []);
  await c10.close();
}

// A win counts the moment it's sure. Reloading 50 ms after the last card goes up, before the won panel, keeps the win,
// and a second reload doesn't count it again: the game is gone from the save, and a new one is dealt.
{
  const c11 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const p11 = await c11.newPage();
  const errors = [];
  p11.on('pageerror', e => errors.push(e.message));
  const ready = () => p11.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const saved = () => p11.evaluate(() => JSON.parse(localStorage.getItem('patience.v1')));
  await p11.goto(base);
  await ready();
  // Klondike with every card up but the king of spades, the last card on the waste.
  const lastCard = () => p11.evaluate(() => {
    window.patience.settings.auto = false;
    window.patience.load({
      v: 'k1', deal: 11705, draw: 1, stock: [], waste: [51], fan: 0, moves: 150,
      found: [0, 1, 2, 3].map(suit => Array.from({ length: suit === 3 ? 12 : 13 }, (_, r) => suit * 13 + r)),
      tab: Array.from({ length: 7 }, () => ({ down: [], up: [] })),
    });
  });
  await lastCard();
  const before = (await saved()).stats.k1;
  await p11.click('.card[data-c="51"]', { position: { x: 12, y: 10 } });
  await p11.waitForTimeout(50);
  await p11.reload();
  await ready();
  const once = (await saved()).stats.k1;
  assert.deepEqual([once.played, once.won, once.streak], [before.played + 1, before.won + 1, before.streak + 1], 'the win was kept through a reload');
  assert.notEqual((await p11.evaluate(() => window.patience.state)).moves, 151, 'and the won game is gone');
  await p11.reload();
  await ready();
  assert.deepEqual((await saved()).stats.k1, once, 'a second reload counts nothing more');
  // N pressed just after the last card, and a new game chosen before the won panel: the win counts, and the streak goes on.
  await lastCard();
  await p11.click('.card[data-c="51"]', { position: { x: 12, y: 10 } });
  await p11.waitForTimeout(150);
  await p11.keyboard.press('n');
  assert.equal(await p11.isHidden('#new-note'), true, 'a won game is no loss');
  await p11.click('[data-v="k1"]');
  await p11.waitForTimeout(1500);
  await ready();
  const k1 = await p11.evaluate(() => window.patience.stats.k1);
  assert.deepEqual([k1.won, k1.streak], [once.won + 1, once.streak + 1], 'New game straight after the last card');
  assert.equal(await p11.isHidden('#won'), true, 'no won panel over the new deal');
  assert.deepEqual(errors, []);
  await c11.close();
}

// A Klondike game finishing itself is won already. New game then, by N and Enter, keeps the streak and counts the win,
// with no word of a loss, and no won panel comes up over the new deal. Left open while the cards go up, the sheet
// then deals a game with the won panel put away.
{
  const c12 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const p12 = await c12.newPage();
  const errors = [];
  p12.on('pageerror', e => errors.push(e.message));
  const ready = () => p12.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await p12.goto(base);
  await ready();
  // A real move, so the game counts, and a streak of 3 going in.
  const finishing = async () => {
    await p12.evaluate(() => window.patience.newGame('k1', 11705));
    await p12.waitForTimeout(1500);
    await ready();
    await p12.click('.spot[data-pile="stock"]', { force: true });
    await p12.waitForTimeout(400);
    await ready();
    await p12.evaluate(() => {
      Object.assign(window.patience.stats.k1, { played: 10, won: 5, streak: 3, best: 3 });
      // Every card face up in four runs from the king down to the 5: the rest goes up by itself.
      const card = (suit, rank) => suit * 13 + rank - 1;
      const run = (a, b) => ({ down: [], up: Array.from({ length: 9 }, (_, i) => card(i % 2 ? b : a, 13 - i)) });
      window.patience.load({ v: 'k1', deal: 11705, draw: 1, stock: [], waste: [], fan: 0, moves: 120,
        found: [0, 1, 2, 3].map(s => [1, 2, 3, 4].map(r => card(s, r))),
        tab: [run(0, 1), run(1, 0), run(2, 3), run(3, 2), ...Array.from({ length: 3 }, () => ({ down: [], up: [] }))] }, 200000);
    });
  };
  await finishing();
  await p12.waitForTimeout(400);
  assert.equal(await p12.evaluate(() => window.patience.state.found.flat().length < 52), true, 'still finishing');
  await p12.keyboard.press('n');
  assert.equal(await p12.isHidden('#new-note'), true, 'no word of a loss');
  await p12.keyboard.press('Enter');
  await p12.waitForTimeout(1500);
  await ready();
  await p12.waitForTimeout(1500);
  let k1 = await p12.evaluate(() => window.patience.stats.k1);
  assert.deepEqual([k1.played, k1.won, k1.streak, k1.best], [10, 6, 4, 4], 'the win counted, and the streak went on');
  assert.equal(await p12.isHidden('#won'), true, 'no won panel over the new deal');
  assert.equal((await p12.evaluate(() => window.patience.state)).moves, 0);

  await finishing();
  await p12.click('#b-new');
  await p12.waitForSelector('#won:not([hidden])', { state: 'attached', timeout: 10000 });
  assert.equal(await p12.isHidden('#sheet-new'), false, 'the sheet stays open while the game is won under it');
  await p12.click('[data-v="k3"]');
  await p12.waitForTimeout(1500);
  await ready();
  assert.equal(await p12.isHidden('#won'), true, 'no won panel over the new deal');
  assert.match(await p12.textContent('#status'), /Klondike, draw three/);
  assert.equal(await p12.locator('.card[style*="visibility: hidden"]').count(), 0, 'every card is on the table');
  k1 = await p12.evaluate(() => window.patience.stats.k1);
  assert.deepEqual([k1.won, k1.streak], [6, 4]);
  assert.deepEqual(errors, []);
  await c12.close();
}

// Two tabs (or the installed app beside a browser tab) share one save. Each takes up what the other saves, so a win in
// one isn't lost when the other moves, and each shows the game the other left.
{
  const c13 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const [a, b] = [await c13.newPage(), await c13.newPage()];
  const errors = [];
  for (const p of [a, b]) p.on('pageerror', e => errors.push(e.message));
  const ready = p => p.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const now = p => p.evaluate(() => JSON.stringify(window.patience.state));
  const same = async why => {
    for (let i = 0; (await now(a)) !== (await now(b)); i++) { assert.ok(i < 40, why); await a.waitForTimeout(50); }
  };
  await a.goto(base);
  await ready(a);
  await a.evaluate(() => window.patience.newGame('k1', 11705));
  await a.waitForTimeout(1500);
  await ready(a);
  await b.goto(base);
  await ready(b);
  await a.click('.spot[data-pile="stock"]', { force: true });
  await ready(a);
  await same('B shows the move made in A');
  // A wins: every card up but the king of spades, the last card on the waste.
  const before = await a.evaluate(() => ({ ...window.patience.stats.k1 }));
  await a.evaluate(() => {
    window.patience.settings.auto = false;
    window.patience.load({
      v: 'k1', deal: 11705, draw: 1, stock: [], waste: [51], fan: 0, moves: 150,
      found: [0, 1, 2, 3].map(suit => Array.from({ length: suit === 3 ? 12 : 13 }, (_, r) => suit * 13 + r)),
      tab: Array.from({ length: 7 }, () => ({ down: [], up: [] })),
    });
  });
  await a.click('.card[data-c="51"]', { position: { x: 12, y: 10 } });
  await a.waitForSelector('#won:not([hidden])');
  await b.waitForTimeout(200);
  assert.equal(await b.evaluate(() => window.patience.stats.k1.won), before.won + 1, "B has A's win in its record");
  // The game B shows was won in A: leaving it now is no loss, and the streak stays.
  await b.click('#b-new');
  assert.equal(await b.isHidden('#new-note'), true, 'no loss for a game won in the other tab');
  assert.equal(await b.textContent('#b-keep'), 'Close', 'and no playing on');
  await b.keyboard.press('Escape');
  await b.keyboard.press('h');
  assert.equal(await b.textContent('#toast'), 'This one’s won.New game');
  // A deals again, and B makes a move in the new game: A's win stays in the record, and A shows B's move.
  await a.mouse.click(30, 300);
  await a.click('#b-again');
  await a.waitForTimeout(1500);
  await ready(a);
  await same("B shows A's new deal");
  await ready(b);
  await b.click('.spot[data-pile="stock"]', { force: true });
  await ready(b);
  await same("A shows B's move");
  const k1 = await a.evaluate(() => JSON.parse(localStorage.getItem('patience.v1')).stats.k1);
  assert.deepEqual([k1.won, k1.streak], [before.won + 1, before.streak + 1], "A's win is still in the record");
  assert.equal(await b.evaluate(() => window.patience.state.moves), 1);
  assert.deepEqual(errors, []);
  await c13.close();
}

// A browser that isn't keeping the save (site data blocked): the player is told once, and the menu says so under the
// record. With storage full, the save still goes, with the last 200 moves of the Undo history, and nothing is said.
{
  const c14 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const p14 = await c14.newPage();
  const errors = [];
  p14.on('pageerror', e => errors.push(e.message));
  await p14.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); }; });
  const ready = () => p14.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await p14.goto(base);
  await ready();
  const told = 'This browser isn’t keeping your games, so your record won’t be here next time.';
  assert.equal(await p14.textContent('#toast'), told);
  assert.equal(await p14.isVisible('#toast'), true, 'the player is told');
  await p14.evaluate(() => {
    window.told = 0;
    new MutationObserver(() => { if (!document.getElementById('toast').hidden && document.getElementById('toast').textContent.includes('keeping')) window.told++; })
      .observe(document.getElementById('toast'), { attributes: true, childList: true });
    document.getElementById('toast').hidden = true;
  });
  for (let i = 0; i < 3; i++) { await p14.click('.spot[data-pile="stock"]', { force: true }); await ready(); }
  await p14.evaluate(() => window.patience.newGame('fc', 617));
  await p14.waitForTimeout(1500);
  await ready();
  assert.equal(await p14.evaluate(() => window.told), 0, 'once is enough');
  await p14.click('#b-menu');
  assert.equal(await p14.isVisible('#unkept'), true, 'the menu says so under the record');
  assert.deepEqual(errors, []);
  await c14.close();

  const c15 = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p15 = await c15.newPage();
  await p15.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (JSON.parse(v).game?.history.length > 200) throw new DOMException('full', 'QuotaExceededError');
      return set.call(this, k, v);
    };
  });
  await p15.goto(base);
  await p15.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await p15.evaluate(() => { for (let i = 0; i < 250; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' })); });
  const save = await p15.evaluate(() => JSON.parse(localStorage.getItem('patience.v1')).game);
  assert.deepEqual([save.state.moves, save.history.length], [250, 200], 'the game saved, with the last 200 moves to undo');
  assert.equal(await p15.isHidden('#toast'), true, 'and nothing to say');
  await c15.close();
}

// Once no move can help, the game says so after the move, with Undo and New game: in FreeCell with one card going back
// and forth (deal 3001), in Spider with too few cards on the table to deal the last row, and in Spider where it takes a
// look at about a thousand tables, a slice at a time, to be sure (deal 68,977). Undo takes the message away.
{
  const c18 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const p18 = await c18.newPage();
  const ready = () => p18.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await p18.goto(base);
  await ready();
  const told = async (text, why) => {
    await p18.waitForSelector('#toast:not([hidden])', { timeout: 5000 });
    assert.equal(await p18.textContent('#toast'), text + 'UndoNew game', why);
    // Only the words are read out as the message shows, not the buttons after them.
    assert.equal(await p18.textContent('#toast [role="status"]'), text);
  };
  const fc = { v: 'fc', deal: 3001, moves: 1500, cells: [28, 51, 7, 27], found: [[39, 40, 41, 42, 43, 44, 45, 46], [], [], []],
    tab: [[15, 30, 16, 0, 5, 13, 38, 24, 10, 22, 34], [21, 1, 37, 49, 9], [17, 47, 48, 8, 20, 32], [33, 19, 31], [50, 29, 6, 18, 4],
      [14, 26, 36], [3, 2, 35, 25, 11, 23], [12]] };
  await p18.evaluate(s => window.patience.load(s), fc);
  await ready();
  assert.equal(await p18.isHidden('#toast'), true, 'nothing said before a move');
  await p18.click('.card[data-c="9"]', { position: { x: 12, y: 10 } });
  await told('There are no moves left that help.', 'FreeCell, the 10 of spades back and forth');
  await p18.click('#toast button:text("Undo")');
  assert.equal(await p18.isHidden('#toast'), true);
  assert.deepEqual((await p18.evaluate(() => window.patience.state)).tab[1].slice(-1), [9], 'the 10 is back on the jack');

  const tab = Array.from({ length: 10 }, (_, i) => ({ down: [], up: i < 3 ? [7 * 52 + 12 - i] : [] }));
  const few = { v: 's1', deal: 1, moves: 300, tab, stock: Array.from({ length: 10 }, (_, r) => 7 * 52 + r),
    sets: Array.from({ length: 7 }, (_, k) => Array.from({ length: 13 }, (_, r) => k * 52 + r)) };
  await p18.evaluate(s => window.patience.load(s), few);
  await ready();
  await p18.click(`.card[data-c="${7 * 52 + 10}"]`, { position: { x: 8, y: 8 } });
  await told('There are no moves left that help.', 'Spider, three cards and a row left');
  await p18.click('.spot[data-pile="stock"]', { force: true });
  await p18.waitForFunction(() => document.getElementById('toast').textContent.startsWith('There aren’t'));
  assert.equal(await p18.textContent('#toast'), 'There aren’t enough cards left to fill every column, so this row can’t be dealt.');

  const stuck = {"v":"s1","deal":68977,"tab":[{"down":[369,371,114,322,372],"up":[113,315,8,111,318]},{"down":[63,211,264,376],"up":[212,12,108,3,54,105]},{"down":[161,367,156,316,216],"up":[56,165,319,263,210]},{"down":[374,10,219,266],"up":[6,373,366,157,62,268,215,214,109,160,107,106,209,52]},{"down":[321,53,1,116],"up":[272]},{"down":[2,9,0,5],"up":[115,60,370]},{"down":[168,317,269],"up":[164]},{"down":[163,4,166,167],"up":[7,265,112,57,208,262,365]},{"down":[220,375,159,61],"up":[58,312,64,323,270]},{"down":[11,267,110],"up":[260,158,261,104]}],"stock":[],"sets":[[364,313,314,55,368,213,162,59,320,217,218,271,324]],"moves":106};
  await p18.evaluate(s => window.patience.load(s), stuck);
  await ready();
  const c = await p18.evaluate(async () => {
    const { spider } = await import('./js/games/spider.js');
    const s = window.patience.state;
    const from = s.tab.findIndex((t, i) => spider.tapTarget(s, 't' + i, 1));
    return s.tab[from].up.at(-1);
  });
  await p18.click(`.card[data-c="${c}"]`, { position: { x: 8, y: 8 } });
  await told('There are no moves left that help.', 'Spider, after a long look');
  await c18.close();
}

// Start this deal again is offered only once there's something to start again: not on a fresh deal.
{
  const c16 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const p16 = await c16.newPage();
  const ready = () => p16.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await p16.goto(base);
  await ready();
  await p16.click('#b-new');
  assert.equal(await p16.isVisible('#b-restart'), false, 'no Start this deal again at 0 moves');
  await p16.keyboard.press('Escape');
  await p16.click('.spot[data-pile="stock"]', { force: true });
  await ready();
  await p16.click('#b-new');
  assert.equal(await p16.isVisible('#b-restart'), true, 'Start this deal again after a move');
  assert.equal(await p16.textContent('#b-keep'), 'Keep playing');
  await c16.close();
}

// Cards on their way somewhere don't take a tap or a press: a quick second tap on the Spider deck, while the last
// cards of the row just dealt are still leaving it, deals a second row instead of moving one of them. And no card in
// flight passes under a card at rest, even when the next move starts before it lands: FreeCell finishing itself
// sends a card up every 80 ms, each a long way from the foot of its column.
{
  const cf = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const pf = await cf.newPage();
  const errors = [];
  pf.on('pageerror', e => errors.push(e.message));
  const ready = () => pf.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await pf.goto(base);
  await ready();
  for (const n of [5, 6, 7]) {
    await pf.evaluate(n => window.patience.newGame('s2', n), n);
    await pf.waitForTimeout(500);
    await ready();
    const deck = await pf.locator('.spot[data-pile="stock"]').boundingBox();
    const twice = await pf.evaluate(async () => {
      const { spider } = await import('./js/games/spider.js');
      const s = window.patience.state;
      return spider.stock(spider.stock(s)).tab;
    });
    await pf.touchscreen.tap(deck.x + deck.width / 2, deck.y + deck.height / 2);
    await pf.waitForTimeout(200);
    await pf.touchscreen.tap(deck.x + deck.width / 2, deck.y + deck.height / 2);
    await pf.waitForTimeout(400);
    await ready();
    const s = await pf.evaluate(() => window.patience.state);
    assert.deepEqual([s.stock.length, s.moves], [30, 2], `two-suit Spider deal ${n}: a quick second tap on the deck deals a second row`);
    assert.deepEqual(s.tab, twice, `two-suit Spider deal ${n}: and no card moved`);
  }

  // A press where a card is landing is for that card, not the one it's landing on. FreeCell: the 7 of hearts goes onto
  // the 8 of spades, and a tap there straight after sends the 7 on to the only empty column, leaving the 8 where it is.
  await pf.evaluate(() => {
    const card = (suit, rank) => suit * 13 + rank - 1;
    window.patience.load({ v: 'fc', deal: 617, cells: [null, null, null, null], found: [[], [], [], []], moves: 3,
      tab: [[card(2, 13), card(0, 8)], [card(0, 13), card(1, 9)], [card(1, 7)], [card(2, 12)], [card(2, 11)], [card(3, 13)], [card(3, 12)], [card(3, 11)]] });
  });
  await ready();
  const eight = await pf.locator('.card[data-c="7"]').boundingBox(), seven = await pf.locator('.card[data-c="19"]').boundingBox();
  await pf.touchscreen.tap(seven.x + seven.width / 2, seven.y + seven.height / 2);
  await pf.waitForTimeout(60);
  await pf.touchscreen.tap(eight.x + eight.width / 2, eight.y + eight.height * 0.36 + eight.height * 0.3);
  await pf.waitForTimeout(400);
  await ready();
  const on = await pf.evaluate(() => [window.patience.state.moves, ...window.patience.state.tab.slice(0, 3).map(t => t.join(' '))]);
  assert.deepEqual(on, [5, '38 7', '12 21', '19'], 'the 7 of hearts went on to the empty column, and the 8 of spades stayed');

  // FreeCell, every column in order, so the game finishes itself.
  const under = await pf.evaluate(async () => {
    const card = (suit, rank) => suit * 13 + rank - 1;
    // Kings of spades and clubs head runs with hearts and diamonds between, and the red kings the other way round:
    // each run split in two columns, K to 8 and 7 to A.
    const run = (black, red, startBlack) => Array.from({ length: 13 }, (_, i) => card((i % 2 === 0) === startBlack ? black : red, 13 - i));
    const runs = [run(0, 1, true), run(0, 1, false), run(2, 3, true), run(2, 3, false)];
    const tab = runs.flatMap(r => [r.slice(0, 6), r.slice(6)]);
    const seen = { hits: 0, samples: 0, first: null };
    let going = true;
    const tick = () => {
      const cards = [...document.querySelectorAll('.card')];
      // Moving: part way there. At rest: not on its way at all (a card only just setting off is still in its place, but
      // isn't at rest).
      const trips = el => el.getAnimations().filter(a => a.transitionProperty === 'transform' && a.playState === 'running');
      const moving = cards.filter(el => trips(el).some(a => a.currentTime > 0)), resting = cards.filter(el => !trips(el).length);
      if (moving.length) seen.samples++;
      for (const f of moving) {
        const fr = f.getBoundingClientRect(), fz = +f.style.zIndex || 0;
        const over = resting.filter(o => getComputedStyle(o).visibility !== 'hidden' && (+o.style.zIndex || 0) > fz).filter(o => {
          const r = o.getBoundingClientRect();
          return Math.min(fr.right, r.right) - Math.max(fr.left, r.left) > 8 && Math.min(fr.bottom, r.bottom) - Math.max(fr.top, r.top) > 8;
        });
        if (over.length) { seen.hits++; seen.first ??= `card ${f.dataset.c} under ${over[0].dataset.c}`; }
      }
      if (going) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.patience.load({ v: 'fc', deal: 617, cells: [null, null, null, null], found: [[], [], [], []], tab, moves: 80 });
    await new Promise(res => { const wait = () => (document.querySelector('#won:not([hidden])') ? res() : setTimeout(wait, 50)); wait(); });
    going = false;
    return seen;
  });
  assert.ok(under.samples > 20, `cards were seen moving (${under.samples} frames)`);
  assert.equal(under.hits, 0, `a card in flight passed under a card at rest: ${under.first}`);
  assert.deepEqual(errors, [], 'errors with cards in flight');
  await cf.close();
}

// A card held while others go up by themselves stays under the finger, and those cards wait for it to be let go; the
// drop then moves the card held. Undo while a card is held takes it back to where it was, and letting go then moves
// nothing.
{
  const ch = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  const ph = await ch.newPage();
  const errors = [];
  ph.on('pageerror', e => errors.push(e.message));
  const ready = () => ph.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await ph.goto(base);
  await ready();
  // Klondike: the four aces on the four twos, ready to go up, then the twos; the jack of clubs and the queen of hearts
  // in the last two columns.
  const card = (suit, rank) => suit * 13 + rank - 1, JC = card(2, 11), QH = card(1, 12);
  const low = [0, 1, 2, 3].flatMap(suit => [card(suit, 2), card(suit, 1)]);
  // (With cards going up by themselves off until the jack is held; then the same table again with it on.)
  await ph.evaluate(([low, JC, QH]) => {
    const all = Array.from({ length: 52 }, (_, c) => c), used = [...low, JC, QH];
    window.patience.settings.auto = false;
    window.patience.load(window.heldTable = {
      v: 'k1', deal: 11705, draw: 1, fan: 0, moves: 7, waste: [], found: [[], [], [], []],
      stock: all.filter(c => !used.includes(c)),
      tab: [0, 1, 2, 3].map(i => ({ down: [], up: low.slice(2 * i, 2 * i + 2) })).concat([{ down: [], up: [] }, { down: [], up: [QH] }, { down: [], up: [JC] }]),
    });
  }, [low, JC, QH]);
  const jack = await ph.locator(`.card[data-c="${JC}"]`).boundingBox(), queen = await ph.locator(`.card[data-c="${QH}"]`).boundingBox();
  await ph.mouse.move(jack.x + 15, jack.y + 15);
  await ph.mouse.down();
  await ph.mouse.move(jack.x + 15, jack.y + 160, { steps: 4 });
  await ph.evaluate(() => { window.patience.settings.auto = true; window.patience.load(window.heldTable); });
  for (let i = 0; i < 6; i++) {
    await ph.waitForTimeout(200);
    const now = await ph.locator(`.card[data-c="${JC}"]`).boundingBox();
    assert.ok(Math.abs(now.x - jack.x) < 2 && Math.abs(now.y - (jack.y + 145)) < 2, `the jack held stays under the finger (${now.x}, ${now.y})`);
  }
  assert.equal((await ph.evaluate(() => window.patience.state.found.flat().length)), 0, 'nothing goes up while the jack is held');
  await ph.mouse.move(queen.x + 15, queen.y + 40, { steps: 4 });
  await ph.mouse.up();
  await ready();
  let s = await ph.evaluate(() => window.patience.state);
  assert.deepEqual(s.tab[5].up, [QH, JC], 'the jack went onto the queen');
  assert.equal(s.found.flat().length, 8, 'and then the aces and twos went up');

  // Hold the jack again, Undo, and let go over the empty column.
  const held = await ph.locator(`.card[data-c="${JC}"]`).boundingBox(), empty = await ph.locator('.spot[data-pile="t4"]').boundingBox();
  await ph.mouse.move(held.x + 15, held.y + 15);
  await ph.mouse.down();
  await ph.mouse.move(held.x + 15, held.y + 100, { steps: 4 });
  await ph.keyboard.press('z');
  await ph.waitForTimeout(100);
  assert.equal(await ph.locator('.card.drag').count(), 0, 'Undo lets go of the jack');
  await ph.mouse.move(empty.x + 15, empty.y + 15, { steps: 4 });
  await ph.mouse.up();
  await ready();
  s = await ph.evaluate(() => window.patience.state);
  assert.deepEqual([s.tab[5].up, s.tab[6].up, s.moves], [[QH], [JC], 7], 'the jack is back where it was, and letting go moved nothing');
  assert.deepEqual(errors, [], 'errors while holding a card');
  await ch.close();
}

// A card let go where it was picked up, nudged a little, stays in its column, though it would fit on the next; one let
// go mostly over a column it can't go on goes back, though it touches one it could; one let go mostly over a column
// it can go on goes there. One-suit Spider with a mouse, where the columns are close together.
{
  const cn = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const pn = await cn.newPage();
  const errors = [];
  pn.on('pageerror', e => errors.push(e.message));
  const ready = () => pn.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await pn.goto(base);
  await ready();
  // Deal 1 with a 5 on top of the ninth column, a 6 on the tenth and the seventh, and a 9 on the eighth.
  const five = await pn.evaluate(async () => {
    const { spider } = await import('./js/games/spider.js');
    const s = spider.deal(1, 's1'), cards = [...s.stock, ...s.tab.flatMap(t => [...t.down, ...t.up])];
    const find = (rank, not) => cards.find(c => c % 13 === rank - 1 && !not.includes(c));
    const want = [[8, 5], [9, 6], [6, 6], [7, 9]], used = [];
    for (const [col, rank] of want) {
      const c = find(rank, used), t = s.tab[col], top = t.up.pop();
      used.push(c);
      // Swap it with the card that was there, wherever it is.
      for (const pile of [s.stock, ...s.tab.flatMap(t => [t.down, t.up])]) { const i = pile.indexOf(c); if (i >= 0) pile[i] = top; }
      t.up.push(c);
    }
    window.patience.load(s);
    return used[0];
  });
  await ready();
  const drop = async (dx, dy) => {
    const b = await pn.locator(`.card[data-c="${five}"]`).boundingBox();
    await pn.mouse.move(b.x + b.width / 2, b.y + 20);
    await pn.mouse.down();
    await pn.mouse.move(b.x + b.width / 2 + dx, b.y + 20 + dy, { steps: 6 });
    await pn.mouse.up();
    await ready();
    return pn.evaluate(c => [window.patience.state.moves, window.patience.state.tab.findIndex(t => t.up.includes(c))], five);
  };
  const box = id => pn.locator(`.spot[data-pile="${id}"]`).boundingBox();
  const [t6, t7, t8] = [await box('t6'), await box('t7'), await box('t8')];
  assert.deepEqual(await drop(10, 0), [0, 8], 'nudged 10 px towards a column it fits on, it stays');
  assert.deepEqual(await drop(t7.x - t8.x - 12, 0), [0, 8], 'let go mostly over the 9, 12 px towards a 6, it goes back');
  assert.deepEqual(await drop(t6.x - t8.x + 12, 0), [1, 6], 'let go mostly over a 6, it goes there');
  // While a card is held, where it would go is outlined: the 6 on the tenth column, then nothing over the 9.
  const outlined = () => pn.evaluate(() => [...document.querySelectorAll('.target')].map(el => el.dataset.c || el.dataset.pile));
  const held = await pn.locator(`.card[data-c="${five}"]`).boundingBox(), t9 = await box('t9');
  const sixOn9 = await pn.evaluate(() => String(window.patience.state.tab[9].up.at(-1)));
  await pn.mouse.move(held.x + held.width / 2, held.y + 20);
  await pn.mouse.down();
  await pn.mouse.move(held.x + held.width / 2 + t9.x - t6.x, held.y + 60, { steps: 6 });
  await pn.waitForTimeout(100);
  assert.deepEqual(await outlined(), [sixOn9], 'the 6 it would go on is outlined');
  await pn.mouse.move(held.x + held.width / 2 + t7.x - t6.x, held.y + 60, { steps: 6 });
  await pn.waitForTimeout(100);
  assert.deepEqual(await outlined(), [], 'nothing is outlined over the 9');
  await pn.mouse.move(held.x + held.width / 2 + t9.x - t6.x, held.y + 60, { steps: 6 });
  await pn.waitForTimeout(100);
  await pn.mouse.up();
  await ready();
  assert.deepEqual(await outlined(), [], 'and nothing once it is let go');
  assert.equal(await pn.evaluate(() => window.patience.state.tab[9].up.length), 2, 'onto the 6');
  assert.deepEqual(errors, [], 'errors dropping cards');
  await cn.close();
}

// With reduced motion asked for, a deal is on the table at once, rows and cleared runs in Spider don't come a card at
// a time, and nothing shakes or slides in: a card that can't go shows an outline instead of shaking.
{
  const cr = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const pr = await cr.newPage();
  const errors = [];
  pr.on('pageerror', e => errors.push(e.message));
  const ready = () => pr.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  await pr.goto(base);
  await ready();
  for (const [v, n] of [['fc', 617], ['s1', 3]]) {
    const took = await pr.evaluate(async ([v, n]) => {
      const t0 = performance.now();
      await window.patience.newGame(v, n);
      await new Promise(res => { const f = () => (window.patience.busy ? requestAnimationFrame(f) : res()); f(); });
      return performance.now() - t0;
    }, [v, n]);
    assert.ok(took < 400, `${v} deal ${n} was ready in ${Math.round(took)} ms`);
  }
  // A row dealt in Spider: no card waits for the one before.
  await pr.click('.spot[data-pile="stock"]', { force: true });
  assert.equal(await pr.evaluate(() => [...document.querySelectorAll('.card')].filter(el => parseFloat(el.style.transitionDelay) > 0).length), 0, 'no card waits its turn');
  await ready();
  // A card that can't go anywhere (the 9 of clubs, with the free cells full and no red 10): an outline, no shake.
  await pr.evaluate(() => {
    const card = (suit, rank) => suit * 13 + rank - 1;
    window.patience.load({ v: 'fc', deal: 617, cells: [card(0, 13), card(1, 13), card(2, 13), card(3, 13)], found: [[], [], [], []], moves: 4,
      tab: [[card(0, 5), card(2, 9)], [card(0, 7)], [card(0, 9)], [card(0, 11)], [card(2, 5)], [card(2, 7)], [card(2, 3)], [card(2, 11)]] });
  });
  await ready();
  await pr.click('.card[data-c="34"]', { position: { x: 12, y: 10 } });
  const look = await pr.evaluate(() => {
    const el = document.querySelector('.card[data-c="34"]');
    return { shake: el.classList.contains('shake'), anim: getComputedStyle(el.firstChild).animationName, ring: getComputedStyle(el.querySelector('.face')).boxShadow };
  });
  assert.equal(look.shake, true, 'the card was refused');
  assert.equal(look.anim, 'none', 'it doesn\'t shake');
  assert.match(look.ring, /2px/, 'it shows an outline');
  // The New game sheet comes up without sliding in.
  await pr.click('#b-new');
  assert.deepEqual(await pr.evaluate(() => ['#sheet-new .panel', '#sheet-new .scrim'].map(q => getComputedStyle(document.querySelector(q)).animationName)), ['none', 'none']);
  await pr.keyboard.press('Escape');
  assert.deepEqual(errors, [], 'errors with reduced motion');
  await cr.close();
}

// With a Windows contrast theme on (forced colours), which takes away backgrounds and shadows, the deck and the
// face-down cards keep their backs, the empty places are outlined, and the switches in the menu can still be seen.
{
  const cc = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', forcedColors: 'active', colorScheme: 'dark' });
  const pc = await cc.newPage();
  await pc.goto(base);
  await pc.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const look = await pc.evaluate(() => {
    const css = el => getComputedStyle(el);
    const back = document.querySelector('.card.down .back'), spot = document.querySelector('.spot[data-pile="f0"]'), sw = document.getElementById('o-auto');
    return { back: css(back).forcedColorAdjust, spot: css(spot).outlineStyle, switch: css(sw).backgroundColor !== css(sw.closest('.panel')).backgroundColor };
  });
  assert.deepEqual(look, { back: 'none', spot: 'solid', switch: true });
  await cc.close();
}

// Klondike's deck shows its turn-over arrow only while there's something to turn over.
{
  const ca = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  const pa = await ca.newPage();
  await pa.goto(base);
  await pa.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  const arrow = async (stock, waste) => {
    await pa.evaluate(([stock, waste]) => {
      const rest = Array.from({ length: 52 }, (_, c) => c).filter(c => ![...stock, ...waste].includes(c));
      window.patience.load({ v: 'k1', deal: 11705, draw: 1, fan: 0, moves: 30, stock, waste, found: [[], [], [], []],
        tab: Array.from({ length: 7 }, (_, i) => { const col = rest.filter((c, k) => k % 7 === i); return { down: col.slice(0, -1), up: col.slice(-1) }; }) });
    }, [stock, waste]);
    await pa.waitForTimeout(400);
    return pa.evaluate(() => +getComputedStyle(document.querySelector('.spot[data-pile="stock"] svg')).opacity);
  };
  assert.equal(await arrow([], []), 0, 'no arrow with the deck and the waste both empty');
  assert.equal(await arrow([], [51]), 1, 'the arrow with cards on the waste to turn over');
  await ca.close();
}

// Opened for the first time, while the first deal is still being shuffled, the felt says so in the middle, not just
// the line at the top, and Undo is dimmed. Drawing three, with the random numbers fixed so that the first few deals
// tried can't be won, it takes a few seconds to find one.
{
  const cw = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
  const pw1 = await cw.newPage();
  const errors = [];
  pw1.on('pageerror', e => errors.push(e.message));
  await pw1.addInitScript(() => {
    localStorage.setItem('patience.v1', JSON.stringify({ settings: { variant: 'k3', winnable: true, auto: true, clock: true, four: false, left: false } }));
    let x = 6;
    Math.random = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  });
  await pw1.goto(base);
  await pw1.waitForSelector('#wait:not([hidden])', { timeout: 5000 });
  assert.equal(await pw1.textContent('#wait'), 'Shuffling for a deal that can be won…');
  assert.equal(await pw1.isDisabled('#b-undo'), true, 'Undo is dimmed while there is no game');
  const middle = await pw1.evaluate(() => {
    const w = document.getElementById('wait').getBoundingClientRect(), t = document.getElementById('table').getBoundingClientRect();
    return Math.abs((w.top + w.bottom) / 2 - (t.top + t.bottom) / 2) < 2 && Math.abs((w.left + w.right) / 2 - (t.left + t.right) / 2) < 2;
  });
  assert.ok(middle, 'in the middle of the felt');
  await pw1.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 60000 });
  assert.equal(await pw1.isHidden('#wait'), true, 'gone once the deal is here');
  assert.equal(await pw1.isDisabled('#b-undo'), true, 'and Undo still dimmed on the new deal');
  assert.deepEqual(errors, [], 'errors on a first open');
  await cw.close();
}

// Offline, checked the junkdrawer house kit's way, from a server that answers like GitHub Pages: a browser may keep
// each file for ten minutes, and asks again by its ETag. `net` is the connection: 'up', 'down' (the server drops every
// connection) or 'stalled' (a plane's or a train's wifi: it takes each request and holds on to it). With `release`
// set it serves the next release. The server's own switches are needed because the browser's offline switch can't
// make a stall, and in some Chromium builds it doesn't stop the service worker's own requests.
{
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { join, extname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createHash } = await import('node:crypto');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
  let net = 'up', release = false;
  const held = [];
  const server = createServer((req, res) => {
    if (net === 'down') { req.socket.destroy(); return; }
    if (net === 'stalled') { held.push([req, res]); return; }
    serve(req, res);
  }).listen(0);
  async function serve(req, res) {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    let body;
    try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
    if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'").replace(/const CACHE = '[^']*'/, "const CACHE = 'patience-v999'"));
    if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
    res.writeHead(200, head);
    res.end(body);
  }
  const base = `http://localhost:${server.address().port}/`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push(e.message));
  // Every file the page asks for on its first visit is one the offline copy keeps.
  const sw = await readFile(join(root, 'sw.js'), 'utf8');
  const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
  const asked = new Set();
  page.on('request', r => { if (r.url().startsWith(base)) asked.add(r.url().slice(base.length) || './'); });
  await page.goto(base);
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 });
  await page.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 15000 });
  assert.ok(asked.has('js/app.js') && asked.has('js/games/spider.js'), 'every file the page loads is seen');
  assert.deepEqual([...asked].filter(f => !shell.includes(f)), [], 'files the page loads that the offline copy leaves out');
  const title = await page.title();
  const dealt = () => page.waitForFunction(() => window.patience?.state && document.querySelectorAll('.card').length === 52, null, { timeout: 15000 });

  // Works offline once it has been opened, and deals a game there.
  net = 'down';
  await ctx.setOffline(true);
  await page.reload();
  assert.equal(await page.title(), title, 'the page did not open offline');
  await dealt();
  await page.evaluate(() => window.patience.newGame('fc'));
  await page.waitForFunction(() => window.patience.state.v === 'fc' && !window.patience.busy, null, { timeout: 15000 });
  await dealt();
  await ctx.setOffline(false);

  // On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
  // the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
  net = 'stalled';
  const t0 = Date.now();
  await page.reload({ timeout: 10000 }).catch(() => {});
  const took = Date.now() - t0;
  assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
  assert.equal(await page.title(), title, 'the page did not open on a stalled connection');
  await dealt();
  net = 'up';
  for (const [req, res] of held.splice(0)) serve(req, res);

  // A new release: every file in the new copy comes from the server, though the browser still has its own copies of
  // the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does; this
  // one bumps the cache's name too.) The old copies go, and a cache that isn't the app's own is left alone.
  const before = await page.evaluate(async () => { await caches.open('patience-v1'); await caches.open('someone-else'); return caches.keys(); });
  assert.ok(before.some(k => /^patience-v[0-9]+$/.test(k) && k !== 'patience-v1'), 'the offline copy is kept in a cache named patience-v and a number');
  release = true;
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  for (const end = Date.now() + 10000; !(await page.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')));) {
    assert.ok(Date.now() < end, "the new release's offline copy kept the old index.html");
    await new Promise(r => setTimeout(r, 100));
  }
  for (const end = Date.now() + 10000; (await page.evaluate(() => caches.keys())).sort().join() !== 'patience-v999,someone-else';) {
    assert.ok(Date.now() < end, `caches after the release: ${await page.evaluate(() => caches.keys())}`);
    await new Promise(r => setTimeout(r, 100));
  }
  assert.deepEqual(problems, [], 'problems while offline or on a stalled connection');
  await ctx.close();
  server.close();

  // sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js
  // is a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
  // index.html; the first 8 hex of the sha1 of those).
  const all = createHash('sha1');
  for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
  const files = all.digest('hex').slice(0, 8);
  assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
}

// The one-file copy (npm run build) plays by itself, opened straight from the disk: no errors, and no file asked for
// beyond itself.
{
  let built = true;
  try {
    execSync('node scripts/build.mjs', { cwd: root, stdio: 'pipe' });
  } catch (e) {
    if (!/esbuild/.test(e.stderr)) throw e;
    built = false;
    console.log('(esbuild is not installed, so the one-file copy was not checked: npm install, then npm test again)');
  }
  if (built) {
    const c17 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const p17 = await c17.newPage();
    const file = pathToFileURL(join(root, 'dist/patience.html')).href;
    const trouble = [];
    p17.on('pageerror', e => trouble.push(e.message));
    p17.on('console', m => { if (m.type() === 'error') trouble.push(m.text()); });
    p17.on('request', r => { if (r.url() !== file && !r.url().startsWith('data:')) trouble.push('asked for ' + r.url()); });
    const ready = () => p17.waitForFunction(() => window.patience?.state && !window.patience.busy, null, { timeout: 20000 });
    await p17.goto(file);
    await ready();
    assert.equal(await p17.locator('.card').count(), 52, 'the one-file copy deals');
    await p17.click('.spot[data-pile="stock"]', { force: true });
    await ready();
    assert.equal((await p17.evaluate(() => window.patience.state)).moves, 1);
    await p17.evaluate(() => window.patience.newGame('fc', 617));
    await p17.waitForTimeout(1500);
    await ready();
    await p17.keyboard.press('h');
    await p17.waitForSelector('.hint', { timeout: 20000 });
    await p17.keyboard.press('Enter');
    await ready();
    assert.deepEqual(await p17.evaluate(() => [window.patience.state.v, window.patience.state.moves]), ['fc', 1], 'and plays FreeCell too');
    assert.deepEqual(trouble, [], 'problems in the one-file copy');
    await c17.close();
  }
}

await browser.close();
server.close();
console.log('all good');
