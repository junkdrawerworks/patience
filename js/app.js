// Patience: the game, the buttons, the record and the settings.

import { VARIANTS, gameOf, label } from './games/index.js';
import { Table } from './table.js';
import { Dealer, hintFor, primeLine, deadEnd, backTo } from './deals.js';
import { cascade } from './win.js';
import { suitSprite } from './suits.js';
import { shortName } from './cards.js';
import { guardEdges } from './edge-guard.js';
import { moveWords, aftermath, upWords, hintWords } from './words.js';
import { DAILY_START, DAILY_DEALS } from './games/daily-deals.js';

const KEY = 'patience.v1';
const $ = id => document.getElementById(id);
const DEFAULTS = { variant: 'k1', winnable: true, auto: true, clock: true, four: false, left: false, look: 'phone' };
const LOOKS = ['phone', 'light', 'dark']; // Look in the menu: whatever the phone is set to, or light or dark whatever it says
// day: the last day a Today's deal was won (see dayOf()), 0 for none; dayTime: how long that win took; days: how many
// days in a row it had been won, up to that one.
const blank = () => ({ played: 0, won: 0, streak: 0, best: 0, fastest: 0, fewest: 0, day: 0, dayTime: 0, days: 0 });
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const shapes = {}; // a new deal of each way of playing, for the shape of a saved game (see sound())

const upgrade = s => (s && !s.v && s.draw ? { ...s, v: 'k' + s.draw } : s);
const settingsOf = saved => {
  const s = Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, typeof saved?.[k] === typeof d ? saved[k] : d]));
  if (!Object.keys(VARIANTS).includes(s.variant)) s.variant = 'k1';
  if (!LOOKS.includes(s.look)) s.look = 'phone';
  return s;
};
// Counts are whole numbers (the fewest moves a win took among them, 0 for none yet, and the day a number too), and the
// fastest win and Today's deal's a time; none of them below nothing. A save from before Today's deal has none won.
const TIMES = ['fastest', 'dayTime'];
const record = r => Object.fromEntries(Object.entries(blank()).map(([k, zero]) => {
  const x = r?.[k];
  return [k, Number.isFinite(x) && x >= 0 && (TIMES.includes(k) || Number.isInteger(x)) ? x : zero];
}));

// ---- Today's deal ----
// One deal a day for each way of playing, the same on every phone, from a list made in advance (js/games/daily-deals.js),
// so every one can be won and nothing has to be solved here. The day is the phone's own: a number, counting from
// 1 January 1970, so days in a row are a day apart. A game of Today's deal keeps the day it was dealt for, as `daily`.
const dayOf = (d = new Date()) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
const FIRST_DAY = Math.round(Date.parse(DAILY_START + 'T00:00:00Z') / 864e5);
const dailyDeal = (v, day) => { const list = DAILY_DEALS[v], i = (day - FIRST_DAY) % list.length; return list[i < 0 ? i + list.length : i]; };
// What a game is called: 'Today's deal' (or yesterday's, once midnight has passed), or else its deal number.
function dealName(s, lower) {
  const ago = s.daily ? dayOf() - s.daily : -1;
  const name = ago === 0 ? 'Today’s deal' : ago === 1 ? 'Yesterday’s deal' : `Deal ${s.deal.toLocaleString('en-US')}`;
  return lower ? name[0].toLowerCase() + name.slice(1) : name;
}

let lastWritten = stored(); // the save as this page last read or wrote it, to tell when another tab has saved since
const saved = read(lastWritten);
const settings = settingsOf(saved.settings);
const stats = Object.fromEntries(Object.keys(VARIANTS).map(v => [v, record(saved.stats?.[v])]));
// The games this phone has said its first word on (see firstWord()): 'klondike', 'freecell', 'spider'.
const introduced = new Set(Array.isArray(saved.introduced) ? saved.introduced.filter(g => typeof g === 'string') : []);
// This save's own name, made up the first time, which goes in a copy of the record so the copy isn't brought back
// here, and the names of the copies brought back already, so none is added twice (see bringBack()).
const newName = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
let saveName = typeof saved.name === 'string' ? saved.name : newName();
const brought = new Set(Array.isArray(saved.brought) ? saved.brought.filter(x => typeof x === 'string') : []);
// The game waiting for each other way of playing, put aside to play another (see newGame()), by way of playing:
// { state, history, elapsed, counted }, as saved. The game on the table isn't in it.
const waiting = {};

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
let pressed = false;  // Hint was pressed again while it was searching
let slowHint = 0;     // the timer that says Hint is still thinking
let lookingOn = 0;    // a look for a move that helps is carrying on past its first limit (its ticket; see lookForMoves)
const THINKING = 'Thinking…';
let stopBounce = null;

const G = () => gameOf(game);

document.body.prepend(suitSprite());
const table = new Table($('table'), {
  stock: () => {
    if (act(G().stock(game), { stock: true })) return;
    const note = G().stockNote(game);
    if (!note) return;
    toast(note.text);
    table.flagSpots(note.piles);
  },
  tap: (pile, n) => {
    if (pile[0] === 'f') return;
    const to = G().tapTarget(game, pile, n);
    if (!to || !act(G().move(game, pile, n, to), { from: pile, n, to })) table.shake(pile, n);
  },
  move: (pile, n, to) => { if (!act(G().move(game, pile, n, to), { from: pile, n, to })) table.render(game); },
  touched: deck => { if (!(deck && noting)) hideToast(); }, // a tap on the deck may be the draw Hint's note asks for
  // A drag the rules turned down, for a reason a newcomer mightn't know: say why, in a line (picking up, once a deal).
  refused: ({ from, cards, to, index }) => {
    if (over()) return;
    const why = to ? G().dropNote?.(game, cards, to) : !liftNoted && G().liftNote?.(game, from, index);
    if (!why) return;
    if (!to) liftNoted = true;
    toast(why);
  },
});
let liftNoted = false; // the game has said why cards couldn't be picked up, this deal
// A Back that comes while a card is held, or just after the browser took a touch away from the table (as Android's
// back gesture does to a finger picking up a card near the screen's side), is a slip: the game stays as it was.
// A Back meant to leave still leaves.
guardEdges({ surfaces: [table.el] });
const dealer = new Dealer(saved.next, () => write(), () => !!table.drag || table.locked || thinking || !!lookingOn);

// ---- playing ----

// Make a move the player asked for: `m` is { from, n, to }, or { stock: true } for a tap on the deck. Returns false if
// there was nothing to do. A won game is finished: it can be looked at, but not played on or undone, so it can't be
// won twice.
function act(next, m) {
  if (!next || table.locked || over()) return false;
  cancelChain();
  table.clearHint();
  // Hint's note on the card it's drawing for goes with the hint, unless this is a draw and that card isn't up yet:
  // then the note stays, and the deck lights up again for the next draw.
  const awaited = noting && m.stock ? drawingFor : null;
  if (noting && awaited === null) hideToast();
  history.push(game);
  if (!counted) { counted = true; stats[next.v].played++; }
  startClock();
  news = { said: [moveWords(G(), game, next, m)], up: [], later: [] };
  set(next);
  if (awaited !== null) {
    if (next.waste?.at(-1) !== awaited && !G().won(game)) drawFor(awaited, true);
    else hideToast();
  }
  return true;
}

// Hint is drawing for card c, further down the deck: light up the deck and say which card, until it turns up. The words
// go by where it is: with the deck empty, the tap turns it over; a card already passed on the waste (where it may even
// be showing, under the top card) comes round again. (`again`: the note is showing already, and isn't read out again
// after each draw unless its words change.)
function drawFor(c, again, lead) {
  table.showHint({ stock: true, c });
  const name = shortName(c);
  const words = (lead ? lead + ' ' : '') + (!game.stock.length ? `Turn the deck over for the ${name}.`
    : game.waste.includes(c) ? `Keep drawing: the ${name} comes round again.` : `Draw for the ${name}.`);
  const shown = !again || $('toast-words').textContent !== words;
  if (shown) toast(words, [], 0);
  noting = true;
  drawingFor = c;
  if (shown) placeToast(); // now it's known to be the note, clear of the deck (toast() placed it as any message)
}

// ---- the line a screen reader reads out ----

// What the player's last move did, said in one line once everything it set going has settled: the move, the cards that
// went up by themselves after it, and anything turned over or cleared away on the way.
let news = null;
function tell(extra) {
  if (!news) return;
  const { said, up, later } = news;
  news = null;
  say([...said, up.length ? upWords(up) : '', ...later, extra || ''].filter(Boolean).join(' '));
}

// One line, read out by a screen reader. Emptied first and filled on the next frame, so the same words again are
// read again. Only ever for something the player did, never the clock.
let saying = 0;
function say(text) {
  const el = $('said');
  cancelAnimationFrame(saying);
  el.textContent = '';
  saying = requestAnimationFrame(() => { el.textContent = text; });
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
  if (g.won(game)) { recordWin(); tell(); chain = setTimeout(victory, 700); return; }
  if (g.finishable(game)) { recordWin(); tell('The rest go up by themselves.'); finish(); return; }
  if (settings.auto) {
    const step = g.autoStep(game);
    if (step) {
      const go = () => {
        // Not while cards are held: they'd have to be let go, and the card going up may be one of them.
        if (table.drag) { chain = setTimeout(go, 140); return; }
        chain = 0;
        const next = G() === g && g.move(game, step.from, step.n, step.to);
        if (!next) { tell(); return; } // another game, or the card has gone
        next.moves = game.moves; // these aren't the player's moves
        if (news) { news.up.push(...g.pile(game, step.from).up.slice(-step.n)); news.later.push(...aftermath(g, game, next)); }
        set(next);
      };
      chain = setTimeout(go, 140);
      return;
    }
  }
  tell();
  if (counted) lookForMoves();
}

// Once nothing can help, say so: no move at all, or none that leads anywhere. The look can take a while in Spider, so
// it runs a slice at a time, and says nothing if another move has been made (or undone) by the time it knows. If it
// gets to its limit without knowing (late in a hard Spider game), it carries on further while the table is left as it
// is. That part waits while Hint thinks, as that's what the player is waiting for, and a deal being found in the
// background waits for it, so the two never hold their memory at once.
let looking = 0;
async function lookForMoves() {
  const at = game, ticket = ++looking, stale = () => ticket !== looking || game !== at;
  const g = G(), auto = settings.auto, wait = () => !!table.drag || table.locked;
  let d = await deadEnd(game, { auto }, { wait, stale });
  if (!d.result && g.budget.idle && !stale()) {
    lookingOn = ticket;
    try {
      d = await deadEnd(game, { auto }, { wait: () => wait() || thinking, stale, max: g.budget.idle, look: d });
    } finally {
      if (lookingOn === ticket) lookingOn = 0;
    }
  }
  if (stale() || over() || d.result !== 'dead') return;
  toast(d.none ? 'There are no moves left.' : 'There are no moves left that help.', [['Take me back', () => takeBack(at)], ['Undo', undo], ['New game', openNew]]);
}

function cancelChain() { clearTimeout(chain); chain = 0; }

// Every card is in order: put them all away, lowest first, drawing from the deck (Klondike drawing one) when none fits.
function finish() {
  table.locked = true;
  const g = G();
  const step = () => {
    const s = g.finishStep(game);
    if (!s) { table.locked = false; return; }
    const next = s.stock ? g.stock(game) : g.move(game, s.from, s.n, s.to);
    next.moves = game.moves;
    game = next;
    table.render(game);
    if (g.won(game)) { chain = setTimeout(victory, 320); return; }
    chain = setTimeout(step, s.stock ? 50 : 80);
  };
  chain = setTimeout(step, 260);
}

function undo() {
  if (!history.length || table.locked || over()) return;
  cancelChain();
  hideToast();
  news = null;
  game = history.pop();
  table.render(game);
  showInfo();
  write();
  say('Undone.');
}

// A new game of way `v` (deal `number`, or the next one; with `day`, that day's deal for Today's deal). Another way of
// playing, with a game waiting for it, carries on with that game instead, unless a deal is asked for by its number.
async function newGame(v, number, day) {
  if (number === undefined && game && v !== game.v && waiting[v]) { carryOn(v); return; }
  const ticket = ++dealing;
  // Chosen from a sheet or the won panel, the table takes focus, so the keyboard's Space and Enter play the new deal.
  if (closeSheets() + closeWon()) focusTable();
  hideToast();
  cancelChain();
  clearTimeout(landed);
  clearTimeout(slow);
  settings.variant = v;
  table.locked = true;
  const g = VARIANTS[v].game;
  slow = setTimeout(() => {
    const line = 'Shuffling for a deal that can be won…';
    $('status').textContent = line;
    say(line);
    // With no game on the table yet (the first time it's opened), the felt says so too, so it doesn't look broken.
    // With one, it fades and its clock stops, and Hint and Undo go off, so it doesn't look as if it can still be played.
    if (!game) { $('wait').textContent = line; $('wait').hidden = false; return; }
    stopClock();
    busy(true);
  }, 250);
  const n = number ?? (settings.winnable ? await dealer.take(v) : g.randomDeal());
  if (ticket !== dealing) return; // another game was chosen while this one was being shuffled
  clearTimeout(slow);
  // A new deal counts the game of the same way it replaces as a loss, if it was part way. A game of another way goes
  // aside, to carry on with later. Not until the new deal is here: a page closed while it's still being shuffled opens
  // on the same game again, which isn't lost.
  if (game?.v === v) { if (inPlay()) stats[v].streak = 0; }
  else {
    if (waiting[v]?.counted) stats[v].streak = 0; // only when a deal of it is asked for by number
    delete waiting[v];
    putAside();
  }
  start(day ? { ...g.deal(n, v), daily: day } : g.deal(n, v));
}

// The game on the table goes aside, Undo, clock and all, until its way of playing is chosen again. A game won is over,
// and doesn't.
function putAside() {
  if (!game || over()) return;
  stopClock();
  waiting[game.v] = { state: game, history: history.slice(-2000), elapsed, counted };
}

// Back to the game waiting for way `v`, as it was left, and the one on the table goes aside.
function carryOn(v) {
  dealing++; // a deal still being shuffled isn't wanted now
  if (closeSheets() + closeWon()) focusTable();
  hideToast();
  cancelChain();
  clearTimeout(landed);
  clearTimeout(slow);
  busy(false);
  table.clearHint();
  putAside();
  const g = waiting[v];
  delete waiting[v];
  settings.variant = v;
  news = null;
  winNews = null;
  liftNoted = false;
  take(g);
  write();
  say(`${label(v)}, ${dealName(game, true)}, as you left it.`);
  after();
  if (settings.winnable) dealer.prepare(v);
}

function restart() {
  closeSheets();
  if (!game || !game.moves) return;
  closeWon();
  focusTable();
  dealing++; // a deal still being shuffled isn't wanted now
  settings.variant = game.v; // so this is the way of playing to remember, not the one given up on
  clearTimeout(slow);
  hideToast();
  table.locked = true;
  const s = G().deal(game.deal, game.v);
  start(game.daily ? { ...s, daily: game.daily } : s, true);
}

// The table faded, and Hint and Undo off, while a new deal is being shuffled (see newGame).
function busy(on) {
  table.el.classList.toggle('busy', on);
  $('b-hint').disabled = on;
  if (on) $('b-undo').disabled = true;
}

function start(state, again) {
  cancelChain();
  clearTimeout(landed);
  busy(false);
  game = state;
  history = [];
  news = null;
  say(`${label(state.v)}, ${dealName(state, true)}.`);
  // Starting the same deal again part way through keeps its clock (stopped until the next move), so a fastest win counts
  // all the time spent on that deal, not just the last try. Once it's won, starting it again is a new game with a new clock.
  if (again && counted) stopClock();
  else { elapsed = 0; since = 0; counted = false; }
  winCounted = false;
  winNews = null;
  liftNoted = false;
  // A deal just checked comes with the way through, for Hint's first press.
  const way = !again && dealer.pathFor(state.v, state.deal);
  if (way) primeLine(state, way, settings.auto);
  table.render(game, { deal: true });
  showInfo();
  write();
  landed = setTimeout(() => { table.locked = false; after(); if (!again) firstWord(); }, table.dealDuration && table.dealDuration + 150);
}

// The first time each game is dealt on a phone to someone who hasn't played it here, a word on how it plays, with a
// button to its rules in the menu. Said once a game, and remembered.
const FIRST_WORDS = {
  klondike: 'Tap a card to send it where it fits, or drag it. Red on black, down to the ace.',
  freecell: 'Park a card in a free cell, top left. Any card can go in an empty column.',
  spider: 'Tap the deck to deal a row. Runs of one suit, king to ace, clear away.',
};
const phone = matchMedia('(pointer: coarse)');
function firstWord() {
  const name = VARIANTS[game.v].name, key = name.toLowerCase();
  if (introduced.has(key) || !phone.matches || game.moves || over() || !$('toast').hidden || sheetOpen()) return;
  if (Object.keys(VARIANTS).some(v => VARIANTS[v].name === name && stats[v].played)) return;
  introduced.add(key);
  write();
  toast(FIRST_WORDS[key], [['How to play', () => openMenu(true)]], 0);
}

// Hint's search, or Take me back's, for table `at`, with the Hint button pulsing and, after a moment, Thinking… where the
// deal's name goes. Resolves with what `search()` found, or with nothing if the table has gone by the time it knows (a
// move, Undo or a new game): then a press of Hint since then is answered for the table as it is now.
async function thinkAbout(at, search) {
  thinking = true;
  pressed = false;
  $('b-hint').classList.add('busy');
  clearTimeout(slowHint);
  slowHint = setTimeout(() => { if (game === at && !table.locked) { $('status').textContent = THINKING; say(THINKING); } }, 700);
  let found;
  try {
    // A search for a table that has gone stops at once, so a press since then needn't wait.
    found = await search(() => game !== at);
  } finally {
    thinking = false;
    $('b-hint').classList.remove('busy');
    clearTimeout(slowHint);
    if ($('status').textContent === THINKING) showInfo();
  }
  if (game === at) return found;
  if (pressed) hint();
  return null;
}

// `lead`: words to say first (where Take me back went), with the move Hint shows.
async function hint(lead) {
  if (thinking) { pressed = true; return; } // answered once this search is done, for the table as it is then
  if (table.locked || !game) return;
  if (over()) { toast('This one’s won.', [['New game', openNew]]); return; }
  if (chain) { setTimeout(hint, 120, lead); return; } // let cards going up by themselves land first
  const at = game;
  const h = await thinkAbout(at, stale => hintFor(game, { auto: settings.auto }, { stale }));
  if (!h) return;
  const back = [['Take me back', () => takeBack(at)], ['Undo', undo], ['New game', openNew]];
  if (h.move) {
    // Drawing for a card further down the deck, only the deck lights up, so the note says which card.
    // (That note is read out as it shows, so the line a screen reader reads says nothing more.)
    if (h.move.c !== undefined) drawFor(h.move.c, false, lead);
    else {
      table.showHint(h.move);
      if (lead) toast(lead, [], 6000);
      say(hintWords(G(), game, h.move));
    }
  } else if (h.lost && !history.length) {
    // As dealt, with nothing to undo. (Looks like: Klondike's first search can stand, so it isn't always proven.)
    toast('Looks like this deal can’t be won, however it’s played.', [['New game', openNew]]);
  } else if (h.lost) toast('Looks like there’s no way to win from here.', back);
  else toast('There are no moves left.', history.length ? back : [['New game', openNew]]);
}

// Back to the last table on the way to `at` that the game can still be won from, when Hint, or the game by itself, has
// said it can't be won from `at`: as many moves back as that takes, saying how many, and then Hint shows the way on.
// It looks over the moves made a few at a time, halving them, at about Hint's speed each look, with Hint pulsing.
async function takeBack(at) {
  if (thinking || table.locked || over() || game !== at || !history.length) return;
  cancelChain();
  table.clearHint();
  const tables = [...history, game];
  const r = await thinkAbout(at, stale => backTo(tables, { auto: settings.auto }, { stale }));
  if (!r) return;
  if (r.none) { toast('Looks like this deal can’t be won, however it’s played.', [['New game', openNew]]); return; }
  const moves = tables.length - 1 - r.at;
  news = null;
  game = tables[r.at];
  history = tables.slice(0, r.at);
  table.render(game);
  showInfo();
  write();
  hint(`Back ${plural(moves, 'move')}, to where it can still be won.`);
}

// Play the move Hint is showing (Enter): a tap on the deck, or those cards to where it says.
function play(m) {
  if (m.stock) table.on.stock();
  else act(G().move(game, m.from, m.n, m.to), m);
}

// ---- winning ----

// The game is won, or is sure to be, all its cards in order and going up by themselves: into the record it goes, and
// the save lets the game go, so neither leaving now nor a reload can lose the win or count it twice. Only once a game.
function recordWin() {
  if (winCounted) return;
  winCounted = true;
  stopClock();
  const st = stats[game.v];
  winNews = newsOf(st, elapsed, game.v);
  if (game.daily > st.day) {
    // Today's deal (or another day's, not won yet): the first win of it is that day's time. Days in a row count on.
    st.days = game.daily === st.day + 1 ? st.days + 1 : 1;
    st.day = game.daily;
    st.dayTime = elapsed;
    const done = `${dealName(game)} done${st.days > 1 ? `: ${st.days} days in a row` : ''}.`;
    winNews = { text: winNews ? `${winNews.text} ${done}` : done, tile: winNews?.tile };
  }
  if (!counted) st.played++;
  st.won++;
  st.streak++;
  st.best = Math.max(st.best, st.streak);
  st.fastest = st.fastest ? Math.min(st.fastest, elapsed) : elapsed;
  if (game.moves) st.fewest = st.fewest ? Math.min(st.fewest, game.moves) : game.moves;
  counted = false;
  write();
}

// What a win in `ms` sets in record `st`, as it is before the win counts, for the won panel to say: the first win at this
// way of playing, the fastest yet, or the longest streak yet, whichever comes first; null if none.
let winNews = null;
function newsOf(st, ms, v) {
  if (!st.won) return { text: `Your first win at ${label(v)}.`, tile: 'Won' };
  if (!st.fastest || ms < st.fastest) {
    // By as much as the two times shown differ, in whole seconds.
    const by = Math.floor(st.fastest / 1000) - Math.floor(ms / 1000), m = Math.floor(by / 60), sec = by % 60;
    const span = [m && plural(m, 'minute'), sec && plural(sec, 'second')].filter(Boolean).join(' ');
    return { text: st.fastest && by > 0 ? `Your fastest yet, by ${span}.` : 'Your fastest yet.', tile: 'Fastest' };
  }
  if (st.streak + 1 > Math.max(1, st.best)) return { text: `Your best streak yet: ${st.streak + 1} in a row.`, tile: 'Streak' };
  return null;
}

// A game won (or sure to be, so it can't be lost) is over: it can be looked at, but not played on.
function over() { return winCounted || G().won(game); }
// A game that would count as a loss if left now.
function inPlay() { return !!game && counted && !over(); }

let showWon = 0; // the timer that brings up the won panel once the cards have bounced a while
// (Under the New game sheet, if that was opened while the cards went up, focus stays there.)
function showPanel() {
  clearTimeout(showWon);
  const panel = $('won').querySelector('.panel');
  if (!panel.hidden) return;
  panel.hidden = false;
  if (!sheetOpen()) $('b-again').focus({ preventScroll: true });
}
function victory() {
  chain = 0;
  recordWin();
  table.locked = true;
  showInfo(); // the last cards may have gone up by themselves; Undo goes off
  const st = stats[game.v];

  $('won-line').textContent = `${label(game.v)}, ${dealName(game, true).replace(' ', '\u00a0')}, in ${clock(elapsed)} and ${plural(game.moves, 'move')}.`;
  $('won-stats').innerHTML = tiles([
    ['Won', `${st.won} of ${st.played}`],
    ['Streak', st.streak],
    ['Fastest', clock(st.fastest)],
  ], winNews?.tile);
  $('won-news').textContent = winNews?.text || '';
  $('won-news').hidden = !winNews;
  const overlay = $('won'), panel = overlay.querySelector('.panel');
  hideToast();
  overlay.hidden = false;
  panel.hidden = true;
  modal();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    showPanel();
  } else {
    table.unbury();
    stopBounce = cascade($('bounce'), G().bounceOrder(game), c => table.rectOf(c), c => table.hide(c, true));
    showWon = setTimeout(showPanel, 3500);
    // A tap, or Space, Enter or Escape (see the keys below), brings it up at once.
    overlay.addEventListener('pointerdown', showPanel, { once: true });
  }
}

// Put the won panel away, if it's up. Returns whether it was.
function closeWon() {
  if ($('won').hidden) return false;
  clearTimeout(showWon);
  stopBounce?.();
  stopBounce = null;
  const canvas = $('bounce');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  $('won').hidden = true;
  modal();
  table.showAllCards();
  table.locked = false;
  return true;
}
$('b-again').addEventListener('click', () => newGame(game.v));
// The same deal from the start, on a new clock: a game won is over, so this one counts as another game played.
$('b-replay').addEventListener('click', restart);
$('b-pick').addEventListener('click', () => { closeWon(); openNew(); });

// ---- the clock, the counts and the record ----

function startClock() { if (!since && !document.hidden) since = performance.now(); }
function stopClock() { if (since) { elapsed += performance.now() - since; since = 0; } }
const played = () => elapsed + (since ? performance.now() - since : 0);

function clock(ms) {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function showInfo() {
  if (!game) return;
  $('wait').hidden = true;
  $('status').textContent = `${label(game.v)} · ${dealName(game)}`;
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

// `hot`: the one a win has just set, which stands out.
function tiles(list, hot) {
  return list.map(([k, v]) => `<div${k === hot ? ' class="new"' : ''}><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function showStats(v) {
  const st = stats[v];
  askNoMore();
  $('stats-for').value = v;
  $('stats').innerHTML = tiles([
    ['Played', st.played.toLocaleString('en-US')],
    ['Won', st.won.toLocaleString('en-US')],
    ['Win rate', st.played ? `${Math.round((100 * st.won) / st.played)}%` : '–'],
    ['Streak', st.streak.toLocaleString('en-US')],
    ['Best streak', st.best.toLocaleString('en-US')],
    ['Fastest', st.fastest ? clock(st.fastest) : '–'],
    ['Fewest moves', st.fewest ? st.fewest.toLocaleString('en-US') : '–'],
    ['Today’s deal', st.day === dayOf() ? `Won in ${clock(st.dayTime)}` : '–'],
    ['Days in a row', (st.day >= dayOf() - 1 ? st.days : 0).toLocaleString('en-US')],
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
  for (const k of ['settings', 'stats', 'next', 'games']) if (!isObj(s[k])) delete s[k];
  if (!Array.isArray(s.introduced)) delete s.introduced;
  if (!Array.isArray(s.brought)) delete s.brought;
  // The first version only played Klondike, and kept the draw count where the way of playing now goes.
  if (s.settings && !s.settings.variant && s.settings.draw) s.settings.variant = 'k' + s.settings.draw;
  if (s.stats?.[1] || s.stats?.[3]) { s.stats.k1 ??= s.stats[1]; s.stats.k3 ??= s.stats[3]; }
  // Saves before November 2026 kept one game, under `game` (null once it was won): it's the game of its way of playing.
  if (!s.games && isObj(s.game)) {
    const g = { ...s.game, state: upgrade(s.game.state), history: (Array.isArray(s.game.history) ? s.game.history : []).map(upgrade) };
    if (typeof g.state?.v === 'string') s.games = { [g.state.v]: g };
  }
  s.games ??= {};
  delete s.game;
  return s;
}

// The games waiting don't change while they wait, so each is made into text once, not at every move.
const texts = new WeakMap();
const textOf = g => { let t = texts.get(g); if (t === undefined) texts.set(g, (t = JSON.stringify(g))); return t; };

function write() {
  let ok = false;
  try {
    // The whole undo list goes too, so Undo still goes all the way back after the page is closed. The last 2,000 moves
    // is more than a game takes, and keeps a game to about a megabyte even in Spider. A game won is left out.
    const now = game && !over() ? { state: game, history: history.slice(-2000), elapsed: played(), counted } : null;
    const games = Object.entries(waiting).filter(([v]) => v !== game?.v);
    if (now) games.push([game.v, now]);
    const head = JSON.stringify({ settings, stats, next: dealer?.kept(), introduced: [...introduced], name: saveName, brought: [...brought] }).slice(0, -1);
    // `cut`: the games whose Undo history is cut to its last 200 moves.
    const build = (cut = () => false) => `${head},"games":{${games.map(([v, g]) =>
      `${JSON.stringify(v)}:${cut(v) && g.history.length > 200 ? JSON.stringify({ ...g, history: g.history.slice(-200) }) : g === now ? JSON.stringify(g) : textOf(g)}`).join(',')}}}`;
    let text = build();
    try {
      localStorage.setItem(KEY, text);
    } catch (e) {
      // With the browser's storage full, the record and the games still go, with less of the Undo history: the games
      // waiting lose theirs first, then the game on the table.
      if (games.every(([, g]) => g.history.length <= 200)) throw e;
      try {
        text = build(v => v !== game?.v || !now);
        localStorage.setItem(KEY, text);
      } catch {
        text = build(() => true);
        localStorage.setItem(KEY, text);
      }
    }
    lastWritten = text;
    ok = true;
  } catch { /* storage full or blocked */ }
  kept(ok);
}

// Whether the browser is keeping the save. When it stops (site data blocked, or storage full), the player hears so
// once, and the menu says so under the record for as long as it lasts.
let unkept = false, told = false;
function kept(ok) {
  if (unkept === !ok) return;
  unkept = !ok;
  $('unkept').hidden = ok;
  if (unkept && !told) { told = true; toast('This browser isn’t keeping your games, so your record won’t be here next time.'); }
}

// Another tab, or the installed app beside a browser tab, shares this save. When it saves, this page takes up what it
// saved, so neither one writes its own old copy over the other's record or games: the record and the settings at once,
// and the games once nothing is being dragged or dealt here. This page then shows the game the other one is playing,
// with the others waiting as it left them. The other page having won the game this one shows, this one's is won too,
// and isn't counted or played again.
let adopting = 0;
function adopt() {
  clearTimeout(adopting);
  const text = stored();
  if (text === null || text === lastWritten) return;
  const s = read(text);
  for (const v of Object.keys(VARIANTS)) Object.assign(stats[v], record(s.stats?.[v]));
  Object.assign(settings, settingsOf(s.settings));
  for (const g of s.introduced ?? []) if (typeof g === 'string') introduced.add(g);
  for (const x of s.brought ?? []) if (typeof x === 'string') brought.add(x);
  if (typeof s.name === 'string') saveName = s.name;
  apply();
  dealer.load(s.next);
  if (!$('sheet-menu').hidden) showStats($('stats-for').value);
  if (table.drag || (table.locked && $('won').hidden)) { adopting = setTimeout(adopt, 250); return; }
  lastWritten = text;
  const v = settings.variant; // the way of playing the other page is on
  for (const k of Object.keys(waiting)) delete waiting[k];
  for (const [k, g] of Object.entries(s.games)) {
    const ok = k !== v && playable(g);
    if (ok && ok.state.v === k) waiting[k] = ok;
  }
  const g = playable(s.games[v]);
  if (!g || g.state.v !== v) {
    // No game of that way saved: the other page has won it. If it's the one here, it's won here too. Otherwise this page
    // keeps its own game.
    if (game) { delete waiting[game.v]; settings.variant = game.v; }
    if (!game || game.v !== v || over()) return;
    winCounted = true;
    counted = false;
    stopClock();
    cancelChain();
    table.clearHint();
    showInfo();
    return;
  }
  if (JSON.stringify(g.state) === JSON.stringify(game)) return;
  cancelChain();
  clearTimeout(landed);
  closeWon();
  closeSheets();
  hideToast();
  take(g);
}
window.addEventListener('storage', e => { if (e.key === KEY) adopt(); });

// ---- a copy of the record, to keep or take to another phone ----

// The file: { patience: 'record', version: 1, saved (when, as an ISO date), from (the save it came from), holds (the
// saves whose copies were brought back into it, so a record inside another is never added twice; a file without it
// holds none), settings, stats (by way of playing, as the save keeps them) }. A later version of Patience still reads
// version 1.
const RECORD_VERSION = 1;
$('b-save').addEventListener('click', () => {
  const when = new Date();
  const copy = { patience: 'record', version: RECORD_VERSION, saved: when.toISOString(), from: saveName, holds: [...brought], settings, stats };
  const day = [when.getFullYear(), when.getMonth() + 1, when.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  const name = `patience-record-${day}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 1)], { type: 'application/json' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  $('keep-says').textContent = `Saved as ${name}. Keep it somewhere safe, and bring it back here or on another phone.`;
});
$('b-bring').addEventListener('click', () => $('f-bring').click());
$('f-bring').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = ''; // so the same file can be chosen again
  if (!file) return;
  let copy = null;
  try { copy = JSON.parse(await file.text()); } catch { /* not a record */ }
  $('keep-says').textContent = bringBack(copy);
  if (!$('sheet-menu').hidden) showStats($('stats-for').value);
});

// Add a copy of a record to this one: games played and won added together, the best streak, fastest and fewest
// moves the better of the two, and the streak the longer. Its settings come back too. Says what happened.
function bringBack(copy) {
  if (!isObj(copy) || copy.patience !== 'record' || !Number.isInteger(copy.version) || !isObj(copy.stats)) return 'That isn’t a copy of a Patience record.';
  if (copy.version > RECORD_VERSION) return 'That record was saved by a newer Patience. Reload this page to bring it back.';
  if (copy.from === saveName) return 'That’s this phone’s own record. It’s here already.';
  if (typeof copy.from === 'string' && brought.has(copy.from)) return 'A record from that phone is here already.';
  // A copy from a phone that a record from here, or one brought back here, was added to has those games in it too.
  const holds = Array.isArray(copy.holds) ? copy.holds.filter(x => typeof x === 'string') : [];
  if (holds.includes(saveName)) return 'That record has this phone’s own record in it, so it would count games twice.';
  if (holds.some(x => brought.has(x))) return 'That record holds one that’s here already, so it would count games twice.';
  for (const v of Object.keys(VARIANTS)) {
    const st = stats[v], r = record(copy.stats[v]);
    st.played += r.played;
    st.won += Math.min(r.won, r.played);
    st.streak = Math.max(st.streak, r.streak);
    st.best = Math.max(st.best, r.best, st.streak);
    for (const k of ['fastest', 'fewest']) st[k] = st[k] && r[k] ? Math.min(st[k], r[k]) : st[k] || r[k];
    // Today's deal: the later day won, with its time and days in a row; won on both phones the same day, the quicker
    // time and the longer run.
    if (r.day > st.day) Object.assign(st, { day: r.day, dayTime: r.dayTime, days: r.days });
    else if (r.day && r.day === st.day) Object.assign(st, { dayTime: Math.min(st.dayTime, r.dayTime), days: Math.max(st.days, r.days) });
  }
  if (isObj(copy.settings)) {
    Object.assign(settings, settingsOf({ ...settings, ...copy.settings, variant: settings.variant }));
    apply();
  }
  if (typeof copy.from === 'string') brought.add(copy.from);
  for (const x of holds) brought.add(x);
  write();
  const when = new Date(copy.saved);
  const day = Number.isNaN(when.getTime()) ? '' : ` from ${when.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  return `Your record${day} is added to this one, and its settings are back.`;
}

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

document.querySelectorAll('input[name="look"]').forEach(r => r.addEventListener('change', () => {
  settings.look = r.value;
  apply();
  write();
}));

// Look set to Light or Dark puts data-theme on the page, which the stylesheet follows, and colours the phone's own bar to
// match. Set to the phone's setting, it leaves data-theme as it found it (a page this one is shown inside may set it).
const hostTheme = settings.look === 'phone' ? document.documentElement.dataset.theme : undefined;
const barColours = [...document.querySelectorAll('meta[name="theme-color"]')].map(m => [m, m.content]);
function applyLook() {
  const root = document.documentElement, forced = settings.look !== 'phone';
  if (forced) root.dataset.theme = settings.look;
  else if (hostTheme) root.dataset.theme = hostTheme;
  else delete root.dataset.theme;
  for (const [m, own] of barColours) m.content = forced ? (settings.look === 'dark' ? '#0f2a20' : '#1f5a42') : own;
  document.querySelectorAll('input[name="look"]').forEach(r => { r.checked = r.value === settings.look; });
}

function apply() {
  for (const [k, id] of Object.entries(toggles)) $(id).checked = settings[k];
  applyLook();
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
$('b-hint').addEventListener('click', () => hint());
$('b-menu').addEventListener('click', () => openMenu());
$('b-howto').addEventListener('click', () => openMenu(true));
// The menu, with the rules of the game being played open under How to play; `howto`: opened at them.
function openMenu(howto) {
  showStats(game?.v || settings.variant);
  const name = VARIANTS[game?.v || settings.variant].name;
  document.querySelectorAll('.howto details').forEach(d => { d.open = d.dataset.game === name.toLowerCase(); });
  openSheet('sheet-menu');
  if (!howto) return;
  const rules = document.querySelector('.howto details[open]');
  $('howto-title').scrollIntoView({ block: 'start' });
  rules.querySelector('summary').focus({ preventScroll: true });
}
$('b-restart').addEventListener('click', restart);
$('stats-for').addEventListener('change', e => showStats(e.target.value));

// Clear this record: it asks once, in place ('Clear your FreeCell record? This can't be undone.'), and then the way of
// playing chosen above the record starts again from nothing. A game of it part way through counts again from its next
// move, as a game played.
$('b-clear').addEventListener('click', () => {
  $('clear-q').textContent = `Clear your ${label($('stats-for').value)} record? This can’t be undone.`;
  $('b-clear').hidden = true;
  $('clear-ask').hidden = false;
  $('b-clear-no').focus({ preventScroll: true });
});
$('b-clear-no').addEventListener('click', () => askNoMore(true));
$('b-clear-yes').addEventListener('click', () => {
  const v = $('stats-for').value;
  Object.assign(stats[v], blank());
  if (game?.v === v) counted = false;
  if (waiting[v]) waiting[v] = { ...waiting[v], counted: false };
  write();
  showStats(v);
  askNoMore(true);
  say(`Your ${label(v)} record is cleared.`);
});
// Put Clear this record's question away; `focus`: back to the button.
function askNoMore(focus) {
  $('clear-ask').hidden = true;
  $('b-clear').hidden = false;
  if (focus) $('b-clear').focus({ preventScroll: true });
}
document.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => {
  const v = b.dataset.v, n = askedFor();
  if (todayOn) todayFor(v).go();
  else if (n) newGame(v, n);
  else newGame(v);
}));
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));

function openNew() {
  hideToast();
  $('new-note').hidden = !inPlay();
  showToday(false);
  showNumber(false);
  $('b-restart').hidden = !game || !game.moves;
  $('b-keep').textContent = game && over() ? 'Close' : 'Keep playing'; // a game won is over, so there's no playing on
  document.querySelectorAll('[data-v]').forEach(b => {
    const now = b.dataset.v === (game?.v || settings.variant);
    b.classList.toggle('current', now);
    if (now) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  openSheet('sheet-new');
}

// A deal by number, in the New game sheet (under By number): the number typed (only its digits, so 52,817 as the game shows it will do),
// or 0 for none. With one, each game's button plays that deal of it, as long as the game has a deal of that number,
// and the deal is played as asked, without the check that it can be won.
const askedFor = () => Number($('deal-n').value.replace(/\D/g, '').slice(0, 9)) || 0;
const fmt = n => n.toLocaleString('en-US');
// Under each game's name in the sheet: with Today's deal pressed, how today's deal of it stands; the deal a number typed
// would play (or how high its deals go, if it hasn't one so high); or else Carry on, for another way of playing with a
// game waiting.
function showChoices() {
  const n = askedFor();
  document.querySelectorAll('[data-v]').forEach(b => {
    const v = b.dataset.v, last = VARIANTS[v].game.lastDeal;
    b.querySelector('.waits')?.remove();
    b.disabled = !todayOn && n > last;
    const words = todayOn ? todayFor(v).line : n ? (n > last ? `Up to ${fmt(last)}` : `Deal ${fmt(n)}`) : waiting[v] && v !== game?.v ? 'Carry on' : '';
    if (!words) return;
    const line = document.createElement('span');
    line.className = 'waits';
    line.textContent = words;
    b.append(line);
  });
  const says = $('deal-n-says');
  says.hidden = !n;
  says.textContent = !n ? '' : n > 999999 ? 'Deals go up to 999,999, and FreeCell’s to 32,000.'
    : `Choose a game for deal ${fmt(n)}. A deal by number isn’t checked first, so it may be one that can’t be won, as FreeCell’s 11,982 famously can’t.`;
}
$('deal-n').addEventListener('input', showChoices);
// By number opens the field, and closes it again, leaving the games as they were. Today's deal and By number don't go
// together: pressing one lets the other go.
function showNumber(open) {
  $('by-number').hidden = !open;
  $('b-number').setAttribute('aria-expanded', String(open));
  $('deal-n').value = '';
  if (open) showToday(false);
  showChoices();
}
$('b-number').addEventListener('click', () => {
  const open = $('by-number').hidden;
  showNumber(open);
  if (open) $('deal-n').focus();
});

// Enter (Go on a phone's keyboard) plays the deal in the way of playing the sheet opened on.
$('deal-n').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  const n = askedFor(), v = game?.v || settings.variant;
  if (n && n <= VARIANTS[v].game.lastDeal) newGame(v, n);
});

// Today's deal, pressed, turns each game's button into today's deal of it, saying how it stands: Won in 3:12, Carry on
// (it's waiting), Playing (it's on the table), or else Today's deal. `go` is what pressing it does.
let todayOn = false;
function todayFor(v) {
  const day = dayOf(), st = stats[v];
  if (game?.v === v && game.daily === day && !over()) return { line: 'Playing', go: closeSheets };
  if (game?.v !== v && waiting[v]?.state.daily === day) return { line: 'Carry on', go: () => carryOn(v) };
  return { line: st.day === day ? `Won in ${clock(st.dayTime)}` : 'Today’s deal', go: () => newGame(v, dailyDeal(v, day), day) };
}
function showToday(on) {
  todayOn = on;
  $('b-today').setAttribute('aria-pressed', String(on));
  $('today-says').hidden = !on;
  if (on && !$('by-number').hidden) showNumber(false);
  showChoices();
}
$('b-today').addEventListener('click', () => showToday(!todayOn));

let opener = null;
function openSheet(id) {
  closeSheets();
  hideToast();
  opener = document.activeElement; // before the page behind goes inert, which takes focus away from it
  $(id).hidden = false;
  modal();
  ($(id).querySelector('.current') || $(id).querySelector('.close, button'))?.focus({ preventScroll: true });
}
// Returns how many were open.
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
  return open.length;
}
const sheetOpen = () => !!document.querySelector('.sheet:not([hidden])');
// (Its ring shows only when the keyboard brought it there: a player who clicks and then presses H doesn't need one.)
function focusTable() {
  if (sheetOpen() || !$('won').hidden) return;
  table.el.classList.toggle('keyed', byKey);
  table.el.focus({ preventScroll: true });
}

// While a sheet or the won panel is open, the table, its buttons and any message behind it can't be reached.
function modal() {
  const blocked = sheetOpen() || !$('won').hidden;
  $('game').inert = blocked;
  $('toast').inert = blocked;
}

let toastTimer = 0;
let noting = false; // the message showing is Hint's note on the card it's drawing for
let drawingFor = null; // and that card
// A message, with buttons that do something and close it. It goes after `ms` (none: until something else closes it).
// Only the words are read out as it shows (they're a role="status"), not the buttons after them.
function toast(text, actions = [], ms = actions.length ? 9000 : 4000) {
  const t = $('toast');
  noting = false;
  drawingFor = null;
  t.querySelector('.acts')?.remove();
  $('toast-words').textContent = text;
  // The buttons stay together, and go onto a line of their own together when there isn't room beside the words.
  if (actions.length) {
    const acts = document.createElement('span');
    acts.className = 'acts';
    for (const [name, fn] of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.addEventListener('click', () => { hideToast(); fn(); });
      acts.append(b);
    }
    t.append(acts);
  }
  t.hidden = false;
  placeToast();
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('toast').hidden = true; clearTimeout(toastTimer); noting = false; drawingFor = null; }

// Held sideways, the columns reach down to where a message sits, at the bottom in the middle. If it would cover a card
// there, it goes where it covers none: the bottom left of the table, the bottom right, or the top in the middle (but not
// Hint's note on the card it's drawing for, if the deck it lights up would be under it), or else where it covers fewest.
// Upright, the columns don't reach it.
const sideways = matchMedia('(orientation: landscape) and (max-height: 520px)');
function placeToast() {
  const t = $('toast');
  delete t.dataset.place;
  if (t.hidden || !sideways.matches || !table.m) return;
  const r = table.el.getBoundingClientRect();
  t.style.setProperty('--table-left', `${r.left}px`);
  t.style.setProperty('--table-right', `${innerWidth - r.right}px`);
  t.style.setProperty('--table-top', `${r.top}px`);
  t.style.setProperty('--table-middle', `${(r.left + r.right) / 2}px`);
  t.style.setProperty('--table-width', `${r.width}px`);
  let best = null;
  for (const place of ['', 'left', 'right', 'top']) {
    if (place) t.dataset.place = place;
    // Measured as it settles: it rises into place from 8 px lower.
    const b = t.getBoundingClientRect(), under = table.under({ left: b.left, right: b.right, top: b.top - 8, bottom: b.bottom });
    if (noting && under.deck) continue;
    if (!best || under.cards < best.cards) best = { place, cards: under.cards };
    if (!under.cards) break;
  }
  if (best?.place) t.dataset.place = best.place; else delete t.dataset.place;
}
// Again once the table has its new size, when the phone is turned.
new ResizeObserver(() => requestAnimationFrame(placeToast)).observe(table.el);

document.addEventListener('keydown', e => {
  if (!$('sheet-new').hidden || !$('sheet-menu').hidden) { if (e.key === 'Escape') closeSheets(); return; }
  const k = e.key.toLowerCase();
  if (!$('won').hidden) {
    // While the cards bounce, before the panel is up, Space, Enter or Escape brings it up, as a tap does. (Held down,
    // it doesn't go on to press Next deal.)
    if (e.repeat) { if (k === ' ' || k === 'enter') e.preventDefault(); return; }
    if ((k === ' ' || k === 'enter' || k === 'escape') && $('won').querySelector('.panel').hidden) { e.preventDefault(); showPanel(); }
    return;
  }
  if (e.altKey || !game) return;
  // Escape lets go: of a card held with the mouse, or else the message showing, and focus goes back to the table.
  if (k === 'escape') {
    if (table.drag) table.letGo();
    else hideToast();
    focusTable();
    return;
  }
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } // held down, it keeps stepping back
  else if (e.ctrlKey || e.metaKey) return;
  else if (e.repeat) { if (k === ' ' || k === 'enter') e.preventDefault(); } // the others, held down, do it once
  else if ((k === ' ' || k === 'enter') && keyFocus && e.target.closest?.('button, a, summary')) return; // the key presses it
  else if (k === ' ' || k === 'd') { e.preventDefault(); table.on.stock(); }
  else if (k === 'enter' && table.shown) { e.preventDefault(); play(table.shown); }
  else if (k === 'h') hint();
  else if (k === 'n') openNew();
});

// Whether the keyboard brought focus to where it is (Tab, or Escape closing a sheet). A button there takes Space and
// Enter; a button that kept focus after a click or tap leaves Space to the deck, and Enter to the move Hint is showing.
let byKey = false, keyFocus = false;
document.addEventListener('pointerdown', () => { byKey = false; table.el.classList.remove('keyed'); }, true);
document.addEventListener('keydown', () => { byKey = true; }, true);
document.addEventListener('focusin', e => {
  keyFocus = byKey;
  if (e.target === table.el) table.el.classList.toggle('keyed', byKey);
});

// ---- offline ----

if ('serviceWorker' in navigator && !('single' in document.documentElement.dataset) && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Installed on a home screen, it asks the browser to keep the save for good, not clear it to make room (Chrome agrees
// without a word to an installed app). Not in a browser tab, where Firefox would ask the player about it.
if ((matchMedia('(display-mode: standalone)').matches || navigator.standalone === true) && navigator.storage?.persist) {
  navigator.storage.persisted().then(yes => yes || navigator.storage.persist()).catch(() => {});
}

// ---- starting up: carry on with the saved game, or deal a new one ----

apply();
for (const [v, g] of Object.entries(saved.games ?? {})) {
  const ok = v !== settings.variant && playable(g);
  if (ok && ok.state.v === v) waiting[v] = ok;
}
if (!resume(saved.games?.[settings.variant])) newGame(settings.variant);

// A saved game, if it's one that can be played: { state, history, elapsed, counted }, or null. Undo goes back as far
// as the history is sound: a damaged entry, and every one before it, is left out.
function playable(g) {
  const s = g?.state;
  try {
    if (!sound(s) || gameOf(s).won(s)) return null;
  } catch { return null; }
  const h = Array.isArray(g.history) ? g.history : [];
  let i = h.length;
  while (i > 0 && sound(h[i - 1], s)) i--;
  return { state: s, history: h.slice(i), elapsed: Number.isFinite(g.elapsed) ? Math.max(0, g.elapsed) : 0, counted: !!g.counted };
}

// Whether a saved state has the shape a new deal of its game has, enough to play from: the same piles, each a list
// (the columns, foundations and free cells as many as a deal has), the same draw, and a count of moves. With `of`, it
// must also be from the same game, as an Undo history entry is.
function sound(s, of) {
  if (!isObj(s) || !Object.hasOwn(VARIANTS, s.v) || (of && (s.v !== of.v || s.deal !== of.deal))) return false;
  const like = (shapes[s.v] ??= VARIANTS[s.v].game.deal(1, s.v));
  return Object.entries(like).every(([k, x]) => {
    const y = s[k];
    if (k === 'v') return true;
    if (k === 'draw') return y === x;
    if (typeof x === 'number') return Number.isInteger(y) && y >= 0;
    if (!Array.isArray(y)) return false;
    if (k === 'stock' || k === 'waste' || k === 'sets') return true;
    if (y.length !== x.length) return false;
    if (k === 'cells') return true;
    return y.every(p => (Array.isArray(x[0]) ? Array.isArray(p) : isObj(p) && Array.isArray(p.down) && Array.isArray(p.up)));
  });
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
  if (!g || g.state.v !== settings.variant) return false;
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

// For the tests and the screenshot tool. load(state, ms, past): a table to play from, with the time spent so far and the
// tables before it, for Undo.
window.patience = {
  get state() { return game; },
  get busy() { return table.locked || !!chain || table.moving; },
  load(state, ms = 0, past = []) { cancelChain(); clearTimeout(landed); game = state; history = past.slice(); elapsed = ms; since = 0; winCounted = false; table.locked = false; table.render(game, { still: true }); showInfo(); after(); },
  newGame,
  settings,
  stats,
  waiting,
};
