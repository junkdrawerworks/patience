// Patience: the game, the buttons, the record and the settings.

import { VARIANTS, gameOf, label } from './games/index.js';
import { Table } from './table.js';
import { Dealer, hintFor } from './deals.js';
import { cascade } from './win.js';
import { suitSprite } from './suits.js';
import { shortName } from './cards.js';
import { guardEdges } from './edge-guard.js';

const KEY = 'patience.v1';
const $ = id => document.getElementById(id);
const DEFAULTS = { variant: 'k1', winnable: true, auto: true, clock: true, four: false, left: false };
const blank = () => ({ played: 0, won: 0, streak: 0, best: 0, fastest: 0 });
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);

const upgrade = s => (s && !s.v && s.draw ? { ...s, v: 'k' + s.draw } : s);
const settingsOf = saved => {
  const s = { ...DEFAULTS, ...saved };
  delete s.draw;
  if (!Object.keys(VARIANTS).includes(s.variant)) s.variant = 'k1';
  return s;
};
const record = r => Object.fromEntries(Object.entries(blank()).map(([k, zero]) => [k, Number.isFinite(r?.[k]) ? r[k] : zero]));
// The deal kept ready for each way of playing, by draw count in the first version.
const readyOf = next => {
  const kept = { k1: next?.[1], k3: next?.[3], ...next };
  return Object.fromEntries(Object.keys(VARIANTS).filter(v => Number.isInteger(kept[v]) && kept[v] > 0).map(v => [v, kept[v]]));
};

let lastWritten = stored(); // the save as this page last read or wrote it, to tell when another tab has saved since
const saved = read(lastWritten);
const settings = settingsOf(saved.settings);
const stats = Object.fromEntries(Object.keys(VARIANTS).map(v => [v, record(saved.stats?.[v])]));

let game = null;      // where the cards are now
let history = [];     // where they were before each move, for Undo
let elapsed = 0;      // time spent on this game, not counting time away
let since = 0;        // when the clock last started, or 0 while it's stopped
let counted = false;  // whether this game has been counted as played (it is from the first move)
let winCounted = false; // whether this game's win is in the record (from the moment it's sure, before the cards go up)
let chain = 0;        // the timer for the next card going up by itself
let dealing = 0;      // counts the deals asked for, so only the latest one is dealt
let slow = 0;         // the timer that says a deal is still being shuffled
let landed = 0;       // the timer that frees the table once a deal has landed
let thinking = false; // the Hint button is searching
let stopBounce = null;

const G = () => gameOf(game);

document.body.prepend(suitSprite());
const table = new Table($('table'), {
  stock: () => {
    if (act(G().stock(game))) return;
    const note = G().stockNote(game);
    if (note) toast(note);
  },
  tap: (pile, n) => {
    if (pile[0] === 'f') return;
    const to = G().tapTarget(game, pile, n);
    if (!to || !act(G().move(game, pile, n, to))) table.shake(pile, n);
  },
  move: (pile, n, to) => { if (!act(G().move(game, pile, n, to))) table.render(game); },
  touched: () => hideToast(),
});
// A Back that comes while a card is held, or just after the browser took a touch away from the table (as Android's
// back gesture does to a finger picking up a card near the screen's side), is a slip: the game stays as it was.
// A Back meant to leave still leaves.
guardEdges({ surfaces: [table.el] });
const dealer = new Dealer(readyOf(saved.next), () => write());

// ---- playing ----

// Make a move the player asked for. Returns false if there was nothing to do.
// A won game is finished: it can be looked at, but not played on or undone, so it can't be won twice.
function act(next) {
  if (!next || table.locked || over()) return false;
  cancelChain();
  table.clearHint();
  if (noting) hideToast(); // Hint's note on the card it was drawing for goes with the hint
  history.push(game);
  if (!counted) { counted = true; stats[next.v].played++; }
  startClock();
  set(next);
  return true;
}

function set(next) {
  game = next;
  if (G().won(game)) recordWin(); // before it's saved, so the save never holds a won game without its win
  table.render(game);
  showInfo();
  write();
  after();
}

// After any move: finished? Ready to finish itself? Any cards to send up?
function after() {
  cancelChain(); // only one thing comes next
  const g = G();
  if (g.won(game)) { recordWin(); chain = setTimeout(victory, 700); return; }
  if (g.finishable(game)) { recordWin(); finish(); return; }
  if (settings.auto) {
    const step = g.autoStep(game);
    if (step) {
      chain = setTimeout(() => {
        chain = 0;
        const next = G() === g && g.move(game, step.from, step.n, step.to);
        if (!next) return; // another game, or the card has gone
        next.moves = game.moves; // these aren't the player's moves
        set(next);
      }, 140);
      return;
    }
  }
  if (counted && g.outOfMoves(game, { auto: settings.auto })) {
    toast('There are no moves left.', [['Undo', undo], ['New game', openNew]]);
  }
}

function cancelChain() { clearTimeout(chain); chain = 0; }

// Every card is in order: put them all away, lowest first.
function finish() {
  table.locked = true;
  const g = G();
  const step = () => {
    const s = g.finishStep(game);
    if (!s) { table.locked = false; return; }
    const next = g.move(game, s.from, s.n, s.to);
    next.moves = game.moves;
    game = next;
    table.render(game);
    if (g.won(game)) { chain = setTimeout(victory, 320); return; }
    chain = setTimeout(step, 80);
  };
  chain = setTimeout(step, 260);
}

function undo() {
  if (!history.length || table.locked || over()) return;
  cancelChain();
  hideToast();
  game = history.pop();
  table.render(game);
  showInfo();
  write();
}

async function newGame(v, number) {
  const ticket = ++dealing;
  closeSheets();
  closeWon();
  hideToast();
  cancelChain();
  clearTimeout(landed);
  clearTimeout(slow);
  settings.variant = v;
  table.locked = true;
  const g = VARIANTS[v].game;
  slow = setTimeout(() => { $('status').textContent = 'Shuffling for a deal that can be won…'; }, 250);
  const n = number ?? (settings.winnable ? await dealer.take(v) : g.randomDeal());
  if (ticket !== dealing) return; // another game was chosen while this one was being shuffled
  clearTimeout(slow);
  // Leaving a game part way counts as a loss. Not until the new deal is here: a page closed while it's still being
  // shuffled opens on the same game again, which isn't lost.
  if (inPlay()) stats[game.v].streak = 0;
  start(g.deal(n, v));
}

function restart() {
  closeSheets();
  if (!game || !game.moves) return;
  closeWon();
  dealing++; // a deal still being shuffled isn't wanted now
  settings.variant = game.v; // so this is the way of playing to remember, not the one given up on
  clearTimeout(slow);
  hideToast();
  table.locked = true;
  start(G().deal(game.deal, game.v), true);
}

function start(state, again) {
  cancelChain();
  clearTimeout(landed);
  game = state;
  history = [];
  // Starting the same deal again part way through keeps its clock (stopped until the next move), so a fastest win counts
  // all the time spent on that deal, not just the last try. Once it's won, starting it again is a new game with a new clock.
  if (again && counted) stopClock();
  else { elapsed = 0; since = 0; counted = false; }
  winCounted = false;
  table.render(game, { deal: true });
  showInfo();
  write();
  landed = setTimeout(() => { table.locked = false; after(); }, table.dealDuration + 150);
}

async function hint() {
  if (thinking || table.locked || !game || G().won(game)) return;
  if (chain) { setTimeout(hint, 120); return; } // let cards going up by themselves land first
  const at = game;
  thinking = true;
  $('b-hint').classList.add('busy');
  let h;
  try {
    h = await hintFor(game, { auto: settings.auto });
  } finally {
    thinking = false;
    $('b-hint').classList.remove('busy');
  }
  if (game !== at) return; // they moved on while it was thinking
  if (h.move) {
    table.showHint(h.move);
    // Drawing for a card further down the deck, only the deck lights up, so the note says which card.
    if (h.move.c !== undefined) { toast(`Draw for the ${shortName(h.move.c)}.`); noting = true; }
  } else if (h.lost) toast('Looks like there’s no way to win from here. Undo a few moves to try another way.', [['Undo', undo]]);
  else toast('There are no moves left.', [['New game', openNew]]);
}

// Play the move Hint is showing (Enter): a tap on the deck, or those cards to where it says.
function play(m) {
  if (m.stock) table.on.stock();
  else act(G().move(game, m.from, m.n, m.to));
}

// ---- winning ----

// The game is won, or is sure to be, all its cards in order and going up by themselves: into the record it goes, and
// the save lets the game go, so neither leaving now nor a reload can lose the win or count it twice. Only once a game.
function recordWin() {
  if (winCounted) return;
  winCounted = true;
  stopClock();
  const st = stats[game.v];
  if (!counted) st.played++;
  st.won++;
  st.streak++;
  st.best = Math.max(st.best, st.streak);
  st.fastest = st.fastest ? Math.min(st.fastest, elapsed) : elapsed;
  counted = false;
  write();
}

// A game won (or sure to be, so it can't be lost) is over: it can be looked at, but not played on.
function over() { return winCounted || G().won(game); }
// A game that would count as a loss if left now.
function inPlay() { return !!game && counted && !over(); }

let showWon = 0; // the timer that brings up the won panel once the cards have bounced a while
function victory() {
  chain = 0;
  recordWin();
  table.locked = true;
  showInfo(); // the last cards may have gone up by themselves; Undo goes off
  const st = stats[game.v];

  $('won-line').textContent = `${label(game.v)}, deal ${game.deal.toLocaleString('en-US')}, in ${clock(elapsed)} and ${plural(game.moves, 'move')}.`;
  $('won-stats').innerHTML = tiles([
    ['Won', `${st.won} of ${st.played}`],
    ['Streak', st.streak],
    ['Fastest', clock(st.fastest)],
  ]);
  const overlay = $('won'), panel = overlay.querySelector('.panel');
  hideToast();
  overlay.hidden = false;
  panel.hidden = true;
  modal();
  // (Under the New game sheet, if that was opened while the cards went up, focus stays there.)
  const showPanel = () => { panel.hidden = false; if (!sheetOpen()) $('b-again').focus({ preventScroll: true }); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    showPanel();
  } else {
    table.unbury();
    stopBounce = cascade($('bounce'), G().bounceOrder(game), c => table.rectOf(c), c => table.hide(c, true));
    showWon = setTimeout(showPanel, 3500);
    overlay.addEventListener('pointerdown', () => { clearTimeout(showWon); showPanel(); }, { once: true });
  }
}

// Put the won panel away, if it's up.
function closeWon() {
  if ($('won').hidden) return;
  clearTimeout(showWon);
  stopBounce?.();
  stopBounce = null;
  const canvas = $('bounce');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  $('won').hidden = true;
  modal();
  table.showAllCards();
  table.locked = false;
}
$('b-again').addEventListener('click', () => { closeWon(); newGame(game.v); });
$('b-pick').addEventListener('click', () => { closeWon(); openNew(); });

// ---- the clock, the counts and the record ----

function startClock() { if (!since && !document.hidden) since = performance.now(); }
function stopClock() { if (since) { elapsed += performance.now() - since; since = 0; } }
const played = () => elapsed + (since ? performance.now() - since : 0);

function clock(ms) {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function showInfo() {
  if (!game) return;
  $('status').textContent = `${label(game.v)} · Deal ${game.deal.toLocaleString('en-US')}`;
  $('moves').textContent = plural(game.moves, 'move');
  $('time').textContent = clock(played());
  $('b-undo').disabled = !history.length || over();
  document.documentElement.dataset.game = VARIANTS[game.v].name.toLowerCase();
}
setInterval(() => { if (game && since) $('time').textContent = clock(played()); }, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopClock(); write(); return; }
  adopt(); // in case this page was frozen while another one saved
  if (inPlay()) startClock();
});
window.addEventListener('pagehide', () => { stopClock(); write(); });

function tiles(list) {
  return list.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function showStats(v) {
  const st = stats[v];
  $('stats-for').value = v;
  $('stats').innerHTML = tiles([
    ['Played', st.played],
    ['Won', st.won],
    ['Win rate', st.played ? `${Math.round((100 * st.won) / st.played)}%` : '–'],
    ['Streak', st.streak],
    ['Best streak', st.best],
    ['Fastest', st.fastest ? clock(st.fastest) : '–'],
  ]);
}

// ---- saving ----

function stored() {
  try { return localStorage.getItem(KEY); } catch { return null; } // blocked
}

// What was saved, leaving out any part that isn't the shape this page writes (it never should be).
// A game of null means none is being played: the last one was won.
function read(text) {
  let s = null;
  try { s = JSON.parse(text); } catch { /* none, or not readable */ }
  if (!isObj(s)) return {};
  for (const k of ['settings', 'stats', 'next', 'game']) if (!isObj(s[k]) && !(k === 'game' && s[k] === null)) delete s[k];
  // The first version only played Klondike, and kept the draw count where the way of playing now goes.
  if (s.settings && !s.settings.variant && s.settings.draw) s.settings.variant = 'k' + s.settings.draw;
  if (s.stats?.[1] || s.stats?.[3]) { s.stats.k1 ??= s.stats[1]; s.stats.k3 ??= s.stats[3]; }
  if (s.game) { s.game.state = upgrade(s.game.state); s.game.history = (Array.isArray(s.game.history) ? s.game.history : []).filter(isObj).map(upgrade); }
  return s;
}

function write() {
  try {
    // The whole undo list goes too, so Undo still goes all the way back after the page is closed. The last 2,000 moves
    // is more than a game takes, and keeps the save to about a megabyte even in Spider. A game won is left out.
    const g = game && !over() ? { state: game, history: history.slice(-2000), elapsed: played(), counted } : null;
    const text = JSON.stringify({ settings, stats, next: dealer?.ready, game: g });
    localStorage.setItem(KEY, text);
    lastWritten = text;
  } catch { /* storage full or blocked */ }
}

// Another tab, or the installed app beside a browser tab, shares this save. When it saves, this page takes up what it
// saved, so neither one writes its own old copy over the other's record or game: the record and the settings at once,
// and the game once nothing is being dragged or dealt here. The other page having won the game this one shows, this
// one's is won too, and isn't counted or played again.
let adopting = 0;
function adopt() {
  clearTimeout(adopting);
  const text = stored();
  if (text === null || text === lastWritten) return;
  const s = read(text);
  for (const v of Object.keys(VARIANTS)) Object.assign(stats[v], record(s.stats?.[v]));
  Object.assign(settings, settingsOf(s.settings));
  apply();
  for (const v of Object.keys(dealer.ready)) delete dealer.ready[v];
  Object.assign(dealer.ready, readyOf(s.next));
  if (!$('sheet-menu').hidden) showStats($('stats-for').value);
  if (table.drag || (table.locked && $('won').hidden)) { adopting = setTimeout(adopt, 250); return; }
  lastWritten = text;
  if (s.game === null) {
    if (!game || over()) return;
    winCounted = true;
    counted = false;
    stopClock();
    cancelChain();
    table.clearHint();
    showInfo();
    return;
  }
  const g = playable(s.game);
  if (!g || JSON.stringify(g.state) === JSON.stringify(game)) return;
  cancelChain();
  clearTimeout(landed);
  closeWon();
  closeSheets();
  hideToast();
  take(g);
}
window.addEventListener('storage', e => { if (e.key === KEY) adopt(); });

// ---- settings ----

const toggles = { winnable: 'o-winnable', auto: 'o-auto', clock: 'o-clock', four: 'o-four', left: 'o-left' };
for (const [k, id] of Object.entries(toggles)) {
  $(id).addEventListener('change', e => {
    settings[k] = e.target.checked;
    apply();
    write();
    if (k === 'auto' && settings.auto && game && !table.locked) after();
    if (k === 'winnable' && settings.winnable && game) dealer.prepare(game.v);
  });
}

function apply() {
  for (const [k, id] of Object.entries(toggles)) $(id).checked = settings[k];
  document.documentElement.toggleAttribute('data-four', settings.four);
  $('clock').hidden = !settings.clock;
  if (table.left !== settings.left) {
    table.left = settings.left;
    if (game) table.render(game, { still: true });
  }
}

// ---- buttons, sheets and messages ----

$('b-new').addEventListener('click', openNew);
$('b-undo').addEventListener('click', undo);
$('b-hint').addEventListener('click', hint);
$('b-menu').addEventListener('click', () => {
  showStats(game?.v || settings.variant);
  const name = VARIANTS[game?.v || settings.variant].name;
  document.querySelectorAll('.howto details').forEach(d => { d.open = d.dataset.game === name.toLowerCase(); });
  openSheet('sheet-menu');
});
$('b-restart').addEventListener('click', restart);
$('stats-for').addEventListener('change', e => showStats(e.target.value));
document.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => newGame(b.dataset.v)));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));

function openNew() {
  hideToast();
  $('new-note').hidden = !inPlay();
  $('b-restart').hidden = !game || !game.moves;
  document.querySelectorAll('[data-v]').forEach(b => b.classList.toggle('current', b.dataset.v === (game?.v || settings.variant)));
  openSheet('sheet-new');
}

let opener = null;
function openSheet(id) {
  closeSheets();
  hideToast();
  opener = document.activeElement; // before the page behind goes inert, which takes focus away from it
  $(id).hidden = false;
  modal();
  ($(id).querySelector('.current') || $(id).querySelector('.close, button'))?.focus({ preventScroll: true });
}
function closeSheets() {
  const open = document.querySelectorAll('.sheet:not([hidden])');
  open.forEach(s => { s.hidden = true; });
  modal(); // before focus goes back, since nothing inert can take it
  if (open.length) {
    // Back to the won panel, if the game was won under the sheet, or else to what opened it.
    const back = $('won').hidden ? opener : $('won').querySelector('.panel:not([hidden]) .primary');
    back?.focus?.({ preventScroll: true });
  }
  opener = null;
}
const sheetOpen = () => !!document.querySelector('.sheet:not([hidden])');

// While a sheet or the won panel is open, the table, its buttons and any message behind it can't be reached.
function modal() {
  const blocked = sheetOpen() || !$('won').hidden;
  $('game').inert = blocked;
  $('toast').inert = blocked;
}

let toastTimer = 0;
let noting = false; // the message showing is Hint's note on the card it's drawing for
function toast(text, actions = []) {
  const t = $('toast');
  noting = false;
  t.textContent = text;
  for (const [name, fn] of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = name;
    b.addEventListener('click', () => { hideToast(); fn(); });
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actions.length ? 9000 : 4000);
}
function hideToast() { $('toast').hidden = true; clearTimeout(toastTimer); noting = false; }

document.addEventListener('keydown', e => {
  if (!$('sheet-new').hidden || !$('sheet-menu').hidden) { if (e.key === 'Escape') closeSheets(); return; }
  if (!$('won').hidden || e.altKey || !game) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (e.ctrlKey || e.metaKey) return;
  else if ((k === ' ' || k === 'enter') && keyFocus && e.target.closest?.('button, a, summary')) return; // the key presses it
  else if (k === ' ' || k === 'd') { e.preventDefault(); table.on.stock(); }
  else if (k === 'enter' && table.shown) { e.preventDefault(); play(table.shown); }
  else if (k === 'h') hint();
  else if (k === 'n') openNew();
});

// Whether the keyboard brought focus to where it is (Tab, or Escape closing a sheet). A button there takes Space and
// Enter; a button that kept focus after a click or tap leaves Space to the deck, and Enter to the move Hint is showing.
let byKey = false, keyFocus = false;
document.addEventListener('pointerdown', () => { byKey = false; }, true);
document.addEventListener('keydown', () => { byKey = true; }, true);
document.addEventListener('focusin', () => { keyFocus = byKey; });

// ---- offline ----

if ('serviceWorker' in navigator && !('single' in document.documentElement.dataset) && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---- starting up: carry on with the saved game, or deal a new one ----

apply();
if (!resume(saved.game)) newGame(settings.variant);

// A saved game, if it's one that can be played: { state, history, elapsed, counted }, or null.
function playable(g) {
  const s = g?.state;
  try {
    if (!isObj(s) || !Object.hasOwn(VARIANTS, s.v) || gameOf(s).won(s)) return null;
  } catch { return null; }
  return { state: s, history: g.history, elapsed: Number.isFinite(g.elapsed) ? g.elapsed : 0, counted: !!g.counted };
}

// Put a saved game on the table, as it was.
function take(g) {
  game = g.state;
  history = g.history;
  elapsed = g.elapsed;
  since = 0;
  counted = g.counted;
  winCounted = false;
  table.locked = false;
  table.render(game, { still: true });
  showInfo();
}

// Carry on with a saved game, if there's one that can be played. A saved game that can't (it never should be)
// is dropped, and a new one dealt, keeping the settings and the record.
function resume(kept) {
  const g = playable(kept);
  if (!g) return false;
  try {
    take(g);
    after();
  } catch {
    cancelChain();
    game = null;
    history = [];
    elapsed = 0;
    counted = false;
    table.state = null; // so the table doesn't try to draw it again
    return false;
  }
  if (settings.winnable) setTimeout(() => dealer.prepare(game.v), 4000);
  return true;
}

// For the tests and the screenshot tool.
window.patience = {
  get state() { return game; },
  get busy() { return table.locked || !!chain; },
  load(state, ms = 0) { cancelChain(); clearTimeout(landed); game = state; history = []; elapsed = ms; since = 0; winCounted = false; table.locked = false; table.render(game, { still: true }); showInfo(); after(); },
  newGame,
  settings,
  stats,
};
