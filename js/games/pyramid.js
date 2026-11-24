// The rules of Pyramid, as the table plays them. Twenty-eight cards are dealt face up in a pyramid of seven rows, each
// row covering half of each card in the row above. Take away pairs of cards that add up to 13 (a jack is 11, a queen 12),
// and kings, which are 13 already, by themselves. Only a card with nothing on it can go. The other 24 cards are the
// deck: a tap turns one up, and it can pair with a card in the pyramid or with the top card of the waste, where the card
// turned up before it went. Go through the deck three times. Clear the pyramid to win.
//
// Piles are 'p0'..'p27' (the pyramid's places, row by row from the top, each holding its card until it goes), 'stock',
// 'drawn' (the card turned up), 'waste' and 'out' (the cards taken away).

import { rankOf } from '../cards.js';
import { shuffle } from '../rng.js';
import { Search, Progress, PASSES, PLACES, ROW, COVER } from '../solvers/pyramid.js';

export { PASSES };
const P = Array.from({ length: PLACES }, (_, p) => 'p' + p);
const top = a => a[a.length - 1];
const place = id => (id[0] === 'p' ? +id.slice(1) : -1);

export function deal(n) {
  const cards = shuffle(Array.from({ length: 52 }, (_, i) => i), n * 2654435761 + 31337);
  // What's left after the pyramid is the deck; the last card in the array is the top one, turned up first.
  return { v: 'py', deal: n, pyr: cards.slice(0, PLACES), stock: cards.slice(PLACES), drawn: [], waste: [], out: [], pass: 1, moves: 0 };
}

function clone(s) {
  return { ...s, pyr: s.pyr.slice(), stock: s.stock.slice(), drawn: s.drawn.slice(), waste: s.waste.slice(), out: s.out.slice() };
}

// Whether the card in place p has nothing on it: both places below it empty (the bottom row has none).
const open = (s, p) => s.pyr[p] !== null && (!COVER[p] || COVER[p] === (COVER[p] & gone(s)));
// The places that are empty, as bits.
const gone = s => s.pyr.reduce((m, c, p) => (c === null ? m | (1 << p) : m), 0);

// The card on top of a pile that can be played now, or undefined.
function playable(s, id) {
  const p = place(id);
  if (p >= 0) return open(s, p) ? s.pyr[p] : undefined;
  if (id === 'drawn' || id === 'waste') return top(s[id]);
  return undefined;
}

const pairs = (a, b) => rankOf(a) + rankOf(b) === 13;

export function forSolver(s) {
  return {
    pyr: s.pyr.map(c => (c === null ? -1 : c)),
    talon: [...s.waste, ...s.drawn, ...s.stock.slice().reverse()],
    next: s.waste.length + s.drawn.length,
    drawn: s.drawn.length > 0,
    pass: s.pass,
  };
}

export const pyramid = {
  deal,

  layout(s, left) {
    const deck = left
      ? [{ id: 'stock', col: 0, kind: 'stock' }, { id: 'drawn', col: 1, kind: 'waste', name: 'Card turned up' }, { id: 'waste', col: 2, kind: 'waste' }, { id: 'out', col: 6, kind: 'stack', name: 'Taken away' }]
      : [{ id: 'out', col: 0, kind: 'stack', name: 'Taken away' }, { id: 'waste', col: 4, kind: 'waste' }, { id: 'drawn', col: 5, kind: 'waste', name: 'Card turned up' }, { id: 'stock', col: 6, kind: 'stock' }];
    let first = 0;
    const places = P.map((id, p) => {
      const r = ROW[p];
      if (p === r * (r + 1) / 2) first = p;
      return { id, col: p - first + (6 - r) / 2, row: r, under: r < 6 ? [P[p + r + 1], P[p + r + 2]] : [] };
    });
    return { cols: 7, rows: 5, top: deck, places, tableau: [], dealFrom: 'stock' };
  },

  pile(s, id) {
    const p = place(id);
    if (p >= 0) return { down: [], up: s.pyr[p] === null ? [] : [s.pyr[p]] };
    if (id === 'stock') return { down: s.stock, up: [] };
    return { down: [], up: s[id] };
  },

  cardIds: () => Array.from({ length: 52 }, (_, i) => i),

  // Only a card that can be played comes up, and only on its own.
  lift(s, id, index) {
    const c = playable(s, id);
    return c !== undefined && index === pyramid.pile(s, id).up.length - 1 ? [c] : null;
  },

  targets: () => [...P, 'drawn', 'waste', 'out'],

  // A king goes to the cards taken away by itself; any other card onto one it adds up to 13 with, taking that one too.
  canDrop(s, cards, to) {
    if (cards?.length !== 1) return false;
    const c = cards[0];
    if (to === 'out') return rankOf(c) === 13;
    const t = playable(s, to);
    return t !== undefined && t !== c && pairs(c, t);
  },

  move(s, from, n, to) {
    if (n !== 1 || from === to || from === 'out') return null;
    const cards = pyramid.lift(s, from, pyramid.pile(s, from).up.length - 1);
    if (!cards || !pyramid.canDrop(s, cards, to)) return null;
    const next = clone(s);
    const take = id => { const p = place(id); if (p >= 0) next.pyr[p] = null; else next[id].pop(); };
    take(from);
    if (to !== 'out') { next.out.push(top(pyramid.pile(s, to).up)); take(to); }
    next.out.push(cards[0]);
    next.moves++;
    return next;
  },

  // A tap on the deck turns a card up, sending the one turned up before it to the waste. With the deck gone, it turns the
  // waste back over to go through again, up to three times through in all.
  stock(s) {
    const next = clone(s);
    if (s.stock.length) {
      next.waste.push(...next.drawn);
      next.drawn = [next.stock.pop()];
    } else if (s.pass < PASSES && (s.waste.length || s.drawn.length)) {
      next.stock = [...s.waste, ...s.drawn].reverse();
      next.waste = [];
      next.drawn = [];
      next.pass++;
    } else return null;
    next.moves++;
    return next;
  },
  // How many more times the deck can be turned back over, and the card the last tap on it turned up.
  passes: s => PASSES - s.pass,
  turned: s => s.drawn[0],
  stockNote: s => (!s.stock.length && s.pass >= PASSES && (s.waste.length || s.drawn.length)
    ? { text: 'That was the third time through the deck, the last.', piles: [] } : null),

  // Why a card let go on another can't go there, for someone new to Pyramid.
  dropNote(s, cards, to) {
    const c = cards[0];
    if (to === 'out') return rankOf(c) === 13 ? null : 'Only a king goes by itself. Other cards go in pairs that add up to 13.';
    const t = top(pyramid.pile(s, to).up);
    if (t === undefined) return null;
    if (!pairs(c, t)) return 'A pair has to add up to 13: a jack counts 11 and a queen 12, so a queen pairs with an ace.';
    if (playable(s, to) === undefined) return 'That card is covered. A card can go once nothing is on it.';
    return null;
  },

  // A covered card in the pyramid, dragged anyway (a tap only shakes it).
  liftNote: (s, id) => (place(id) >= 0 && s.pyr[place(id)] !== null && !open(s, place(id)) ? 'A card can go once both cards on it have gone.' : null),

  // A tap on a king takes it away; a tap on another card picks it to pair with the next one tapped (see table.js).
  pairs: true,
  tapTarget: (s, from) => (rankOf(playable(s, from) ?? 0) === 13 ? 'out' : null),

  autoStep: () => null,
  won: s => s.pyr.every(c => c === null),
  finishable: () => false,
  finishStep: () => null,

  search: s => new Search(forSolver(s)),
  // A solver move as a table move: the cards from where they can be played now, or, when card c has still to be turned
  // up, a tap on the deck, with c, the card it's drawing for, so Hint can say which.
  fromSolver(s, m) {
    const at = c => (s.drawn[0] === c ? 'drawn' : top(s.waste) === c ? 'waste' : s.pyr.indexOf(c) >= 0 ? P[s.pyr.indexOf(c)] : null);
    const from = at(m.c), to = m.k === 'king' ? 'out' : at(m.d);
    return from && to ? { from, n: 1, to } : { stock: true, c: m.c };
  },

  // Whether anything can still help: a line of moves, taps on the deck among them, that takes a card from the pyramid.
  deadEnd: s => new Progress(forSolver(s)),
  outOfMoves: s => pyramid.deadEnd(s).run(pyramid.budget.dead) === 'dead',

  // The cards taken away come off the table the last first.
  bounceOrder: s => s.out.slice().reverse(),
  dealOrder: s => s.pyr.filter(c => c !== null),

  lastDeal: 999999,
  randomDeal: () => 1 + Math.floor(Math.random() * 999999),
  budget: { deal: 100000, hint: 100000, dead: 20000 },
};
