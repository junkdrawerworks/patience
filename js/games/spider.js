// The rules of Spider, as the table plays them. Two decks, ten columns, and fifty cards in the stock
// to deal out a row at a time. Build down in any suit, but only a run of one suit moves together,
// and a whole run from king to ace of one suit clears away. Clear eight to win.
//
// Piles are 'stock', 'sets' (the cleared runs) and 't0'..'t9'.
// One suit plays with eight sets of spades, two suits with four each of spades and hearts, four suits with two of each.

import { suitOf, rankOf } from '../cards.js';
import { shuffle } from '../rng.js';
import { SpiderSearch, SpiderSure, SpiderStuck } from '../solvers/spider.js';

const T = Array.from({ length: 10 }, (_, i) => 't' + i);
const SUITS = { s1: [0], s2: [0, 1], s4: [0, 1, 2, 3] };
const top = a => a[a.length - 1];
const col = id => +id.slice(1);
const follows = (c, under) => suitOf(c) === suitOf(under) && rankOf(under) === rankOf(c) + 1;

// The 104 cards for a way of playing, each one distinct (see cards.js).
function deck(v) {
  const suits = SUITS[v], copies = 8 / suits.length, out = [];
  for (let k = 0; k < copies; k++) for (const s of suits) for (let r = 0; r < 13; r++) out.push(k * 52 + s * 13 + r);
  return out;
}

export function deal(n, v) {
  const cards = shuffle(deck(v), n * 2654435761 + 7919 * v.charCodeAt(1));
  const tab = T.map(() => ({ down: [], up: [] }));
  // Six cards in each of the first four columns and five in the rest, the top one face up.
  for (let k = 0; k < 54; k++) tab[k % 10].down.push(cards[k]);
  for (const t of tab) t.up.push(t.down.pop());
  return { v, deal: n, tab, stock: cards.slice(54), sets: [], moves: 0 };
}

function clone(s) {
  return { ...s, stock: s.stock.slice(), sets: s.sets.map(x => x.slice()), tab: s.tab.map(t => ({ down: t.down.slice(), up: t.up.slice() })) };
}

// A column whose face-up cards are gone turns its next card over.
function flip(t) {
  if (!t.up.length && t.down.length) t.up.push(t.down.pop());
}

// A finished king-to-ace run of one suit on top of a column goes away to the sets.
function clear(s, t) {
  const up = t.up, n = up.length;
  if (n < 13 || rankOf(up[n - 13]) !== 13) return;
  for (let i = n - 12; i < n; i++) if (!follows(up[i], up[i - 1])) return;
  s.sets.push(up.splice(n - 13, 13).reverse()); // ace at the bottom of its pile, king on top
  flip(t);
}

const isRun = cards => cards.every((c, i) => i === 0 || follows(c, cards[i - 1]));
// How many cards each column holds, face down and up.
const sizes = s => s.tab.map(t => t.down.length + t.up.length);
// A row can be dealt once every column has a card, or, with fewer cards on the table than columns, once each of them
// has a column to itself.
const canDeal = s => { const n = sizes(s); return n.every(k => k > 0) || (n.reduce((a, b) => a + b, 0) < 10 && n.every(k => k < 2)); };
// How many cards at the top of a column's face-up cards make a run of one suit.
const runOn = up => { let n = up.length ? 1 : 0; while (n < up.length && follows(up[up.length - n], up[up.length - n - 1])) n++; return n; };

export const spider = {
  deal,

  layout(s, left) {
    return {
      cols: 10,
      rows: 6.6,
      top: [
        { id: 'sets', col: left ? 9 : 0, kind: 'sets', dir: left ? -1 : 1, label: 'K' },
        { id: 'stock', col: left ? 0 : 9, kind: 'deals', dir: left ? 1 : -1 },
      ],
      tableau: T,
      dealFrom: 'stock',
    };
  },

  pile(s, id) {
    if (id === 'stock') return { down: s.stock, up: [] };
    if (id === 'sets') return { down: [], up: s.sets.flat() };
    return s.tab[col(id)];
  },

  cardIds(s) { return deck(s.v); },

  // Only a run of one suit, in order, comes off a column together.
  lift(s, id, index) {
    if (id[0] !== 't') return null;
    const cards = s.tab[col(id)].up.slice(index);
    return cards.length && isRun(cards) ? cards : null;
  },

  targets() { return T; },

  canDrop(s, cards, to) {
    if (!cards?.length || to[0] !== 't' || !isRun(cards)) return false;
    const t = s.tab[col(to)];
    if (!t.up.length && !t.down.length) return true;
    return t.up.length > 0 && rankOf(top(t.up)) === rankOf(cards[0]) + 1;
  },

  move(s, from, n, to) {
    if (from === to || from[0] !== 't') return null;
    const src = s.tab[col(from)].up;
    const cards = spider.lift(s, from, src.length - n);
    if (!cards || !spider.canDrop(s, cards, to)) return null;
    const next = clone(s);
    next.tab[col(from)].up.splice(src.length - n, n);
    next.tab[col(to)].up.push(...cards);
    flip(next.tab[col(from)]);
    clear(next, next.tab[col(to)]);
    next.moves++;
    return next;
  },

  // Deal a row: one card face up on every column. Not while a column is empty, unless there are too few cards to fill
  // them all and each has a column to itself.
  stock(s) {
    if (!s.stock.length || !canDeal(s)) return null;
    const next = clone(s);
    for (const t of next.tab) t.up.push(next.stock.pop());
    for (const t of next.tab) clear(next, t);
    next.moves++;
    return next;
  },

  // A card with cards on it that aren't all one suit, going down in order.
  liftNote: (s, id, index) => (id[0] === 't' && index < s.tab[col(id)].up.length - 1 ? 'Only a run of one suit moves together.' : null),

  stockNote(s) {
    const empty = T.filter((id, i) => !s.tab[i].up.length && !s.tab[i].down.length);
    if (!s.stock.length || canDeal(s)) return null;
    if (sizes(s).reduce((a, b) => a + b, 0) < 10) return { text: 'With fewer than ten cards left, give each one a column of its own before dealing a new row.', piles: empty };
    return { text: 'Put a card in every empty column before dealing a new row.', piles: empty };
  },

  // A tap sends a run onto a card one higher of its own suit if there is one, then any card one higher,
  // then an empty column (unless the run is the whole column already). Of the cards of its own suit, the one that makes
  // the longest run of that suit comes first (so one finishing king to ace does), then the nearest to the right.
  // A run already on a card one higher of its own
  // suit goes only onto another like it: anywhere else would split a longer run, which is seldom what's wanted, so
  // with nowhere like it the cards shake (a drag still puts them anywhere the rules allow).
  tapTarget(s, from, n) {
    const cards = spider.lift(s, from, s.tab[col(from)].up.length - n);
    if (!cards) return null;
    const base = cards[0], src = s.tab[col(from)];
    const whole = !src.down.length && src.up.length === n;
    const under = src.up[src.up.length - n - 1];
    const inRun = under !== undefined && follows(base, under);
    const start = col(from);
    const order = T.map((id, i) => ({ id, i, t: s.tab[i] }))
      .filter(x => x.id !== from && spider.canDrop(s, cards, x.id))
      .map(x => {
        const empty = !x.t.up.length && !x.t.down.length;
        const rank = empty ? 2 : suitOf(top(x.t.up)) === suitOf(base) ? 0 : 1;
        return { ...x, empty, rank, run: rank === 0 ? runOn(x.t.up) + cards.length : 0 };
      })
      .filter(x => !(x.empty && whole) && !(inRun && x.rank !== 0));
    order.sort((a, b) => a.rank - b.rank || b.run - a.run || ((a.i - start + 10) % 10) - ((b.i - start + 10) % 10));
    return order[0]?.id ?? null;
  },

  autoStep() { return null; },
  won: s => s.sets.length === 8,
  finishable: () => false,
  finishStep: () => null,

  position(s) {
    return { tab: s.tab.map(t => [...t.down, ...t.up]), down: s.tab.map(t => t.down.length), stock: s.stock.slice(), sets: s.sets.length };
  },
  search(s) { return new SpiderSearch(spider.position(s)); },
  searchAll(s) { return new SpiderSure(spider.position(s), { first: spider.budget.all / 2 }); },

  fromSolver(s, m) {
    if (m.deal) return { stock: true };
    const t = s.tab[m.a];
    return { from: T[m.a], n: t.down.length + t.up.length - m.i, to: T[m.b] };
  },

  // Whether anything can still help: a row to deal, or a move or string of moves that turns a card over, clears a run or
  // empties a column. Every move counts, splitting a run too, since one that seldom helps can still be the only way.
  deadEnd(s) { return new SpiderStuck(spider.position(s)); },
  outOfMoves: s => spider.deadEnd(s).run(spider.budget.dead) === 'dead',

  // The cleared runs come down off the table kings first, the last one cleared first.
  bounceOrder(s) {
    const out = [];
    for (let i = s.sets.length - 1; i >= 0; i--) for (let k = 12; k >= 0; k--) out.push(s.sets[i][k]);
    return out;
  },

  dealOrder(s) {
    const out = [];
    for (let k = 0; k < 54; k++) {
      const t = s.tab[k % 10], all = [...t.down, ...t.up];
      out.push(all[(k / 10) | 0]);
    }
    return out;
  },

  lastDeal: 999999,
  randomDeal: () => 1 + Math.floor(Math.random() * 999999),
  // Hint gets as long as a deal was checked for, so its first press on a new deal finds the way through. Making sure
  // there's no way to win, the first half of `all` goes to the quick moves with spreading, the rest to every move.
  // Making sure nothing can help, `dead` goes to looking at every table the moves reach, straight after a move; while
  // the table is then left as it is, the same look carries on to `idle`.
  budget: { deal: 120000, hint: 120000, all: 40000, dead: 20000, idle: 100000 },
};
