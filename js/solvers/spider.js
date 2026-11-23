// A Spider solver, for checking deals and for the Hint button. It plays the game best first (see best-first.js),
// seeing the face-down cards and the order the stock will come out in.
//
// It takes the position from spider.js:
//   tab[i]   the cards in column i, bottom to top; the first down[i] of them are face down
//   stock    the cards still to deal, the last ten being the next row (dealt once every column has a card, or with
//            fewer than ten cards on the table, once each has a column to itself)
//   sets     how many king-to-ace runs have been cleared away
//
// Moves are { a, i, b }: the cards from position i of column a up to its top, onto column b.
// Or { deal: true }: a row from the stock, one card on each column.

import { BestFirst, Progress } from './best-first.js';
import { suitOf, rankOf } from '../cards.js';

const top = a => a[a.length - 1];
const follows = (c, under) => suitOf(c) === suitOf(under) && rankOf(under) === rankOf(c) + 1;
// Whether a row can be dealt: there is one, and every column has a card or, with fewer cards on the table than
// columns, each of them has a column to itself.
const canDeal = s => s.stock.length > 0 && (s.tab.every(t => t.length) || (s.tab.every(t => t.length < 2) && s.tab.reduce((n, t) => n + t.length, 0) < 10));

const rules = {
  start(p) {
    const s = { tab: p.tab.map(c => c.slice()), down: p.down.slice(), stock: p.stock.slice(), sets: p.sets };
    for (let a = 0; a < 10; a++) clear(s, a);
    return { state: s, autos: [] };
  },

  apply(s, m) {
    const n = { tab: s.tab.slice(), down: s.down.slice(), stock: s.stock, sets: s.sets };
    if (m.deal) {
      n.stock = s.stock.slice(0, -10);
      for (let a = 0; a < 10; a++) n.tab[a] = [...s.tab[a], s.stock[s.stock.length - 1 - a]];
      for (let a = 0; a < 10; a++) clear(n, a);
    } else {
      const src = s.tab[m.a];
      n.tab[m.b] = s.tab[m.b].concat(src.slice(m.i));
      n.tab[m.a] = src.slice(0, m.i);
      if (n.down[m.a] && n.tab[m.a].length === n.down[m.a]) n.down[m.a]--;
      clear(n, m.b);
    }
    return { state: n, autos: [] };
  },

  // The whole suited run at the top of a column moves, and only somewhere that usually helps:
  // off a face-down card, off a card it doesn't belong on, or onto a card of its own suit.
  // Moving a run from one card of the wrong suit to another, or only part of a run, seldom helps, so neither is tried.
  moves(s) {
    const out = [], { tab, down } = s;
    let firstEmpty = -1;
    for (let a = 0; a < 10; a++) if (!tab[a].length) { firstEmpty = a; break; }
    for (let a = 0; a < 10; a++) {
      const t = tab[a], len = t.length;
      if (!len) continue;
      let i = len - 1;
      while (i > down[a] && follows(t[i], t[i - 1])) i--;
      const base = t[i];
      const onParent = i > down[a] && rankOf(t[i - 1]) === rankOf(base) + 1; // of another suit, or the run would be longer
      for (let b = 0; b < 10; b++) {
        if (b === a) continue;
        const tb = tab[b];
        if (!tb.length) {
          if (b === firstEmpty && i > 0) out.push({ a, i, b });
        } else if (rankOf(top(tb)) === rankOf(base) + 1 && (!onParent || suitOf(top(tb)) === suitOf(base))) {
          out.push({ a, i, b });
        }
      }
    }
    if (canDeal(s)) out.push({ deal: true });
    return out;
  },

  key(s) {
    // Columns in any order play the same; the stock only matters by how much is left.
    const cols = s.tab.map((t, a) => String.fromCharCode(s.down[a] + 33, ...t.map(c => (c % 52) + 40))).sort();
    return s.stock.length + '|' + cols.join('|');
  },

  // Lower is closer to won: runs cleared, cards still face down, places where a column changes suit or breaks order,
  // and rows left in the stock; empty columns help.
  score(s) {
    let downs = 0, breaks = 0, empty = 0;
    for (let a = 0; a < 10; a++) {
      const t = s.tab[a];
      if (!t.length) { empty++; continue; }
      downs += s.down[a];
      for (let i = s.down[a] + 1; i < t.length; i++) if (!follows(t[i], t[i - 1])) breaks++;
    }
    return -s.sets * 60 + downs * 5 + breaks * 3 - empty * 4 + s.stock.length * 0.6;
  },

  done(s) { return s.sets === 8; },
};

// The same, but trying every move the table allows: any part of the run at the top of a column, onto any card
// one higher or into an empty column. Far slower to win with, so it's only for making sure, before saying
// a position can't be won, that none of the moves left out above was the way through.
const everyMove = {
  ...rules,
  moves(s) {
    const out = [], { tab, down } = s;
    let firstEmpty = -1;
    for (let a = 0; a < 10; a++) if (!tab[a].length) { firstEmpty = a; break; }
    for (let a = 0; a < 10; a++) {
      const t = tab[a], len = t.length;
      if (!len) continue;
      let i = len - 1;
      while (i > down[a] && follows(t[i], t[i - 1])) i--;
      for (let j = i; j < len; j++) {
        for (let b = 0; b < 10; b++) {
          if (b === a) continue;
          const tb = tab[b];
          if (!tb.length) {
            if (b === firstEmpty && j > 0) out.push({ a, i: j, b }); // a whole column into an empty one changes nothing
          } else if (rankOf(top(tb)) === rankOf(t[j]) + 1) {
            out.push({ a, i: j, b });
          }
        }
      }
    }
    if (canDeal(s)) out.push({ deal: true });
    return out;
  },
};

// The quick moves, and while a row is waiting to be dealt with a column empty, the top card of a column into it too.
// The row can't come until every column has a card, and with few cards left on the table that can mean splitting a
// run, which the quick moves never do. Tried only once the quick moves have found no way through: offered all along,
// they change which way the search goes first, and some deals it wins quickly it no longer wins in time.
const spreading = {
  ...rules,
  moves(s) {
    const out = rules.moves(s), { tab, down } = s;
    if (!s.stock.length) return out;
    // Only once no column has a whole run with cards under it left to move into an empty one.
    let empty = -1, empties = 0, under = 0;
    for (let a = 0; a < 10; a++) {
      const t = tab[a];
      if (!t.length) { if (empty < 0) empty = a; empties++; continue; }
      let i = t.length - 1;
      while (i > down[a] && follows(t[i], t[i - 1])) i--;
      if (i > 0) under++;
    }
    if (!empties || under) return out;
    for (let a = 0; a < 10; a++) {
      const t = tab[a], len = t.length;
      if (len > 1 && follows(t[len - 1], t[len - 2]) && len - 2 >= down[a]) out.push({ a, i: len - 1, b: empty });
    }
    return out;
  },
};

// Whether anything can still help (see Progress in best-first.js): a row to deal, or any move, or string of moves,
// that turns a card over, clears a run or empties a column. Tries every move, splitting runs too.
// With a row still to deal it needn't look: the row can come once every column has a card, which ten cards on the table
// can always manage, spread one to a column, or with fewer than ten, once each has a column to itself.
export class SpiderStuck extends Progress {
  constructor(position) {
    const { state } = rules.start(position);
    const downs = s => s.down.reduce((a, b) => a + b, 0), empties = s => s.tab.filter(t => !t.length).length;
    const sets = state.sets, d0 = downs(state), e0 = empties(state);
    super(everyMove, position, { helps: (s, m) => !!m.deal || s.sets > sets || downs(s) < d0 || empties(s) > e0 });
    if (state.stock.length) this.result = 'live';
  }
}

// Take away a finished king-to-ace run of one suit from the top of column a.
function clear(s, a) {
  const t = s.tab[a], len = t.length;
  if (len - s.down[a] < 13) return;
  for (let i = len - 13; i < len; i++) if (i > len - 13 && !follows(t[i], t[i - 1])) return;
  if (rankOf(t[len - 13]) !== 13) return;
  s.tab[a] = t.slice(0, len - 13);
  s.sets++;
  if (s.down[a] && s.tab[a].length === s.down[a]) s.down[a]--;
}

// every: try every move (see everyMove), not just the ones that usually help. spread: see spreading.
export class SpiderSearch extends BestFirst {
  constructor(position, { every = false, spread = false } = {}) {
    super(every ? everyMove : spread ? spreading : rules, position, { weight: 0.2 });
  }
}

// For making sure, once the quick search has found no way through: first the quick moves with spreading, for up to
// `first` positions, which finds a way quickly when splitting a run to deal the last rows is what was missing; then
// every move (see everyMove), which can say for sure there's no way through. Runs a slice at a time like the others.
export class SpiderSure {
  constructor(position, { first = 20000 } = {}) {
    this.position = position;
    this.first = first;
    this.now = new SpiderSearch(position, { spread: true });
    this.every = false;
    this.done = 0; // positions the first search looked at, once it's over
    this.nodes = 0;
    this.result = null;
    this.path = null;
    this.adopt();
  }

  adopt() {
    this.nodes = this.done + this.now.nodes;
    if (this.now.result === 'won' || (this.every && this.now.result)) { this.result = this.now.result; this.path = this.now.path; }
  }

  step(budget) {
    if (this.result) return this.result;
    if (!this.every) {
      const r = this.now.step(Math.max(0, Math.min(budget, this.first - this.now.nodes)));
      if (r !== 'won' && (r === 'lost' || this.now.nodes >= this.first)) {
        this.done = this.now.nodes;
        this.now = new SpiderSearch(this.position, { every: true });
        this.every = true;
      }
    } else {
      this.now.step(budget);
    }
    this.adopt();
    return this.result;
  }

  run(max) {
    while (!this.result) {
      if (this.nodes >= max) return 'unknown';
      this.step(Math.min(5000, max - this.nodes));
    }
    return this.result;
  }

  firstMove() { return this.now.firstMove(); }
  firstMoves() { return this.now.firstMoves(); }
}

export { rules as spiderRules };
