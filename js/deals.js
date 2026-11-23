// Finding deals that can be won, the Hint button's search, and the look for a move that can still help. All run a
// search a slice at a time between frames, so the cards keep moving while it thinks.

import { VARIANTS, gameOf } from './games/index.js';
import { FOUR_SUIT_DEALS } from './games/spider-deals.js';
import { shuffle } from './rng.js';

// Run a search in slices of a few milliseconds. Resolves with the search once it knows,
// or once it has looked at `max` positions. Each step is sized by how long the last one took, aiming at about 4 ms
// (a position can take ten times longer on a slow phone than here), and a slice ends once 8 ms have gone. The limit is
// still counted in positions, so a search finds the same answer however fast the phone is. While `wait()` says so
// (a card being dragged, cards being dealt), it doesn't step at all, and looks again a little later. Once `stale()` says
// the answer isn't wanted any more (the table it was for has gone), it stops where it is and resolves.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function think(search, max, wait, stale) {
  return new Promise(resolve => {
    let n = 100;
    const tick = () => {
      if (stale?.()) { resolve(search); return; }
      if (wait?.()) { setTimeout(tick, 60); return; }
      const t0 = performance.now();
      for (;;) {
        const t1 = performance.now();
        if (search.step(Math.min(n, max - search.nodes)) || search.nodes >= max) { resolve(search); return; }
        const t2 = performance.now();
        n = Math.round(clamp((n * 4) / Math.max(t2 - t1, 0.1), 20, 2000));
        if (t2 - t0 >= 8) break;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

// Whether anything can still help from here (the game's deadEnd), looked at a slice at a time. Resolves with the look:
// its result is 'dead' once it's sure nothing can, 'live' once something can, and null if it got to `max` positions
// (the game's budget.dead unless given) without knowing; none says there's no move at all. Given `look`, one of these
// that ended without knowing, it carries on with that look, up to the new `max`. While `wait()` says so, it waits,
// like think(); once `stale()` says the answer isn't wanted any more (another move made), it stops.
export async function deadEnd(state, { auto = true } = {}, { wait, stale, max, look } = {}) {
  const game = gameOf(state);
  look ??= game.deadEnd(state, { auto });
  if (!look.result) await think(look, max ?? game.budget.dead, wait, stale);
  return look;
}

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);

// Keeps a winnable deal ready for the way you're playing, so New game doesn't have to wait.
// `kept` is what the save keeps for it (see kept()). busy(): whether the page is busy (a card being dragged, cards
// being dealt, Hint thinking), so a deal being found in the background should wait. One a new game is waiting for doesn't.
export class Dealer {
  constructor(kept, onReady, busy) {
    this.jobs = {};
    this.onReady = onReady;
    this.busy = busy;
    this.ways = new Map(); // 'v:deal' -> the way through the solver found, for Hint (see pathFor)
    this.load(kept);
  }

  // What the save keeps: the deal ready for each way of playing (k1: 123456, ...), in `ways` the way through each,
  // so Hint's first press on it needn't search again after the page is closed and opened, and in `s4list` the
  // four-suit deals checked in advance still to come (see take()).
  kept() {
    const ways = {};
    for (const [v, n] of Object.entries(this.ready)) {
      const path = this.ways.get(v + ':' + n);
      if (path) ways[v] = path;
    }
    return { ...this.ready, ways, s4list: this.s4list };
  }

  // Take up what the save kept (this page's, or another tab's), leaving out anything of the wrong shape. The first
  // version kept the deal by draw count.
  load(next) {
    const kept = { k1: next?.[1], k3: next?.[3], ...next };
    this.ready = Object.fromEntries(Object.keys(VARIANTS).filter(v => Number.isInteger(kept[v]) && kept[v] > 0).map(v => [v, kept[v]]));
    for (const [v, n] of Object.entries(this.ready)) {
      const path = isObj(kept.ways) && kept.ways[v];
      if (Array.isArray(path) && path.every(isObj)) this.ways.set(v + ':' + n, path);
    }
    const list = Array.isArray(next?.s4list) ? next.s4list.filter(n => FOUR_SUIT_DEALS.includes(n)) : [];
    this.s4list = [...new Set(list)];
  }

  // The way through a deal this Dealer found, found with cards going up by themselves on, once: after that it's Hint's.
  pathFor(v, n) {
    const key = v + ':' + n, path = this.ways.get(key);
    this.ways.delete(key);
    return path;
  }

  async find(v, job) {
    const game = VARIANTS[v].game;
    const wait = job && (() => !job.claimed && !!this.busy?.());
    for (;;) {
      const n = game.randomDeal();
      const s = await think(game.search(game.deal(n, v)), game.budget.deal, wait);
      if (s.result === 'won') {
        this.ways.set(v + ':' + n, s.path);
        while (this.ways.size > 12) this.ways.delete(this.ways.keys().next().value); // only the latest few
        return n;
      }
    }
  }

  // A deal number for a new game. Takes the one that's ready if there is one, and starts on the next.
  // Four-suit Spider deals can take a while to check, so until one is ready it uses one checked in advance: the next
  // in a shuffled order of the list, so none comes round again until every one has been dealt (and then not straight
  // after itself).
  async take(v) {
    let n = this.ready[v];
    if (n) {
      delete this.ready[v];
    } else if (v === 's4' && FOUR_SUIT_DEALS.length) {
      if (!this.s4list.length) this.s4list = shuffle(FOUR_SUIT_DEALS.slice(), Math.random() * 2 ** 32);
      n = this.s4list.shift();
      if (!this.s4list.length) { // round again, in a new order that doesn't start with this one
        this.s4list = shuffle(FOUR_SUIT_DEALS.slice(), Math.random() * 2 ** 32);
        if (this.s4list.length > 1 && this.s4list[0] === n) this.s4list.push(this.s4list.shift());
      }
    } else if (this.jobs[v]) {
      const job = this.jobs[v];
      job.claimed = true;
      n = await job.promise;
    } else {
      n = await this.find(v);
    }
    this.prepare(v);
    return n;
  }

  prepare(v) {
    if (this.ready[v] || this.jobs[v]) return;
    const job = { claimed: false };
    job.promise = this.find(v, job).then(n => {
      delete this.jobs[v];
      if (!job.claimed) { this.ready[v] = n; this.onReady?.(this.ready); }
      return n;
    });
    this.jobs[v] = job;
  }
}

// The last few ways through Hint found, the latest first: each is every table it passes through, as the page plays it,
// with the move to show there (map), and the setting it was found with (auto). While the player does what Hint says,
// or comes back to a table on one of them (by Undo, after asking Hint somewhere else on the way), the next move comes
// from there instead of a new search. That's quicker, it's the same move as before, and it can't lead back where it
// came from: a new search from each table sometimes did, a card up to its foundation and straight back down, round and
// round for good. A way is used only with the setting it was found with: one found with cards going up by themselves
// off can count on a card waiting on the waste that, with the setting switched on, goes up by itself instead.
const WAYS = 3;
let ways = [];
const keep = (map, auto) => { ways = [{ map, auto }, ...ways].slice(0, WAYS); return map; };

// The tables Hint has suggested a move at without a way through ("the move that looked best", below), while the player
// does what it says, and the table its last such move leads to. Each new search from the next table can find a
// different move looking best, and two of them can take a card back and forth for ever; so none may lead back to a
// table on this list. It starts again when the player does something else.
let circling = new Set(), circlingNext = null;

// A table, the same however many moves it took to get there.
const where = s => JSON.stringify(s, (k, x) => (k === 'moves' || k === 'fan' ? undefined : x));

// What the page does after a move: cards that can go up by themselves do, unless the game is about to finish itself.
function settle(game, s, auto) {
  for (let step; auto && !game.won(s) && !game.finishable(s) && (step = game.autoStep(s));) s = game.move(s, step.from, step.n, step.to);
  return s;
}

// Play a solver's winning line on the table from here, noting the move to show at each table on the way.
// A card the line sends up that has already gone up by itself is skipped, and a card it wants from the stock is
// drawn for, a tap at a time. Once the line ends (as good as won) the easy hints carry on until the game finishes itself.
function follow(game, s, path, auto) {
  const out = new Map();
  let i = 0, taps = []; // the taps on the stock so far toward the card the line wants next
  for (let guard = 0; guard < 5000 && !game.won(s) && !game.finishable(s); guard++) {
    while (i < path.length && game.upAlready?.(s, path[i])) { i++; taps = []; }
    const m = i < path.length ? game.fromSolver(s, path[i]) : game.easyHint?.(s);
    const next = m && (m.stock ? game.stock(s) : game.move(s, m.from, m.n, m.to));
    const here = where(s);
    if (!next || out.has(here)) { // the line doesn't fit the table after all, so Hint will search again from here
      for (const t of taps) out.delete(t); // drawing for a card that wasn't coming
      break;
    }
    out.set(here, m);
    // A tap on the stock on the way to a card isn't a step of the line, but dealing a row in Spider is.
    if (m.stock && !path[i]?.deal) taps.push(here);
    else { taps = []; if (i < path.length) i++; }
    s = settle(game, next, auto);
  }
  return out;
}

// Start Hint off on a new deal with the way through found when the deal was checked, so its first press needn't search
// again (which takes seconds for Spider on a slow phone). `state` is the deal as dealt, and `auto` the setting for
// cards going up by themselves. The way was found with it on, and plays with it off too: the cards it sends up are
// moves of its own, made by hand.
export function primeLine(state, path, auto = true) {
  const game = gameOf(state);
  try {
    keep(follow(game, settle(game, state, auto), path, auto), auto);
  } catch { /* a way kept in the save that doesn't fit this deal (it never should): Hint searches instead */ }
}

// What to suggest from here, with cards going up by themselves or not (the setting). Resolves with one of:
//   { move: { from, n, to } }   play this
//   { move: { stock: true } }   tap the stock; in Klondike, with c, the card it's drawing for, when Hint knows it
//   { lost: true }              the search looked everywhere and there's no way through
//   { none: true }              nothing left to do at all
//   { stale: true }             stale() said the answer wasn't wanted any more, so it stopped looking
// The ways kept and the tables it has been circling stay as they were when it stops early.
export async function hintFor(state, { auto = true } = {}, { stale } = {}) {
  const game = gameOf(state);
  const here = where(state);
  if (here !== circlingNext) circling = new Set();
  circlingNext = null;
  const i = ways.findIndex(w => w.auto === auto && w.map.has(here));
  if (i >= 0) {
    const [way] = ways.splice(i, 1);
    ways.unshift(way); // the way being followed again
    return { move: way.map.get(here) };
  }
  // Drawing three with cards going up by themselves off, look first for a way with them on. That search is far smaller
  // (a card that could go up never waits on the waste), and a way it finds can be played with the setting off too: the
  // cards it sends up are moves of its own, made by hand. The search with the setting off often ran out of time and
  // guessed, and a guess could lose a game that could be won. It's the only game whose search the setting changes.
  let search = null;
  if (!auto && state.v === 'k3') {
    const on = await think(game.search(state, { auto: true }), game.budget.hint, null, stale);
    if (stale?.()) return { stale: true };
    if (on.result === 'won') search = on;
  }
  search ??= await think(game.search(state, { auto }), game.budget.hint, null, stale);
  if (stale?.()) return { stale: true };
  // A search that leaves out moves which seldom help can't say there's no way through; look again with every move.
  // If that runs out too, Klondike's answer stands: its first search leaves out so little that a way through it missed
  // turns up quickly when there is one. Spider's leaves out more, so Hint suggests the move that looked best.
  if (search.result === 'lost' && game.searchAll) {
    const again = await think(game.searchAll(state, { auto }), game.budget.all, null, stale);
    if (stale?.()) return { stale: true };
    if (again.result || !game.lostStands) search = again;
  }
  if (search.result) circling = new Set();
  if (search.result === 'won') {
    const line = keep(follow(game, state, search.path, auto), auto);
    const m = search.path[0];
    const move = line.get(where(state)) ?? (m ? game.fromSolver(state, m) : game.easyHint?.(state));
    return move ? { move } : { none: true };
  }
  if (search.result === 'lost') return { lost: true };
  // Ran out of time: suggest the move that looked best, unless it leads back to a table this has already happened at.
  // If every move does, it's going round in circles, and there's no way through to be found from here.
  const first = search.firstMove();
  if (!first) return game.stock(state) ? { move: { stock: true } } : { none: true };
  circling.add(here);
  for (const m of [first, ...search.firstMoves().filter(x => x !== first)]) {
    const move = game.fromSolver(state, m);
    const next = move && (move.stock ? game.stock(state) : game.move(state, move.from, move.n, move.to));
    if (!next) continue;
    const there = where(settle(game, next, auto));
    if (circling.has(there)) continue;
    circlingNext = there;
    return { move };
  }
  return { lost: true };
}
