// A Pyramid solver, for checking deals and for the Hint button. It looks for a way to clear the pyramid from a position,
// seeing every card in the deck, depth first, the most promising move first, and never looks at the same position twice.
//
// It takes the position from forSolver() in pyramid.js:
//   pyr      the 28 places of the pyramid, row by row from the top, each a card or -1 once it has gone
//   talon    the deck's cards as one line in the order they come off it: the waste from the bottom, the card turned up
//            (if there is one), then the deck from the top
//   next     how many of those have come off: talon[next] is the next card a tap on the deck turns up
//   drawn    whether talon[next - 1] is the card turned up, still there to pair; if not, it is the waste's top card
//   pass     which time through the deck this is, 1 to PASSES
//
// A whole position is five numbers, so the search keeps each one as it is instead of undoing moves: which of the
// pyramid's cards are left, which of the talon's, and next, drawn and pass.
//
// Like the Klondike solver, it never taps the deck as a move of its own: every card the deck can still turn up, this time
// through or the next, is offered directly, with the waste's top card it would turn up onto, so the search doesn't
// spend its positions turning cards over. Turning up a card further on is never worse than turning it up later, on this
// time through or the next, as the deck only goes forward, so nothing is missed.
//
// Moves are objects with k (the kind) and c, the card that goes, and d, the card it pairs with:
//   k 'king': king c goes by itself      k 'pair': c and d add up to 13 and go together
// When a card has to be turned up for the move, it's c, and the table taps the deck until it is (see fromSolver() in
// pyramid.js).

import { rankOf } from '../cards.js';

export const PASSES = 3;

// The places in the pyramid, row by row: row r has r + 1, and place i of row r is covered by places i and i + 1 of the
// row below. COVER[p] holds those two as bits.
// CONE[p] holds every place resting on p, directly or not: none of them can ever pair with it, as each has to go first,
// and nor can any place p rests on.
const ROW = [], COVER = [], CONE = [];
for (let r = 0, p = 0; r < 7; r++) for (let i = 0; i <= r; i++, p++) { ROW[p] = r; COVER[p] = r < 6 ? (1 << (p + r + 1)) | (1 << (p + r + 2)) : 0; }
for (let p = 27; p >= 0; p--) { const a = p + ROW[p] + 1; CONE[p] = COVER[p] ? COVER[p] | CONE[a] | CONE[a + 1] : 0; }
export const PLACES = 28;
export { ROW, COVER };

const bits = n => { let k = 0; for (; n; n &= n - 1) k++; return k; };

export class Search {
  // goal: what counts as done, given the position started from and the one reached. By default, the pyramid cleared;
  // the look for a move that helps (Progress) wants any card in it gone.
  constructor(p, { goal } = {}) {
    this.cards = p.pyr.slice();
    this.talon = p.talon.slice();
    let pyr = 0;
    p.pyr.forEach((c, i) => { if (c >= 0) pyr |= 1 << i; });
    const st = { pyr, rem: 0, next: p.next, drawn: p.drawn ? 1 : 0, pass: p.pass };
    this.root = st;
    this.goal = goal || (s => s.pyr === 0);
    // Aiming to clear the pyramid, a position with a card in it that has nothing left to pair with is no use: every card
    // of the rank it needs gone, or resting on it. For each place, the places and the talon cards that could pair with it.
    this.prune = !goal;
    this.mates = this.cards.map((c, p) => {
      if (c < 0 || rankOf(c) === 13) return null;
      let pyr = 0, talon = 0;
      this.cards.forEach((d, q) => { if (d >= 0 && q !== p && !(CONE[p] & (1 << q)) && !(CONE[q] & (1 << p)) && rankOf(c) + rankOf(d) === 13) pyr |= 1 << q; });
      this.talon.forEach((d, j) => { if (rankOf(c) + rankOf(d) === 13) talon |= 1 << j; });
      return { pyr, talon };
    });
    // And by rank: which places, and which cards in the talon, hold each rank, to count what's left of each pair of ranks.
    this.ranks = Array.from({ length: 14 }, (_, r) => ({
      pyr: this.cards.reduce((m, c, p) => (c >= 0 && rankOf(c) === r ? m | (1 << p) : m), 0),
      talon: this.talon.reduce((m, c, j) => (rankOf(c) === r ? m | (1 << j) : m), 0),
    }));
    this.seen = new Map(); // each position looked at, less which time through the deck it is -> the earliest time
    this.nodes = 0;
    this.result = null; // 'won', 'lost' (looked everywhere) or null while still looking
    this.path = null;   // the moves that win, when there are some
    this.rootMoves = this.moves(st);
    if (this.goal(st)) { this.result = 'won'; this.path = []; return; }
    this.seen.set(this.key(st), st.pass);
    this.stack = [{ st, moves: this.rootMoves, i: 0, via: null }];
  }

  // The same for positions that play the same, but for which time through the deck it is: a position seen already on
  // the same or an earlier time through has as many ways on as this one, or more.
  key(s) { return s.pyr * 2 ** 24 + s.rem + ':' + (s.next * 2 + s.drawn); }

  // A card in the pyramid with nothing left to pair with, or more cards of a rank in it than there are cards left to
  // pair them with: each of the rest of its ranks partners, in the talon, can take one, and each in the pyramid one at
  // most, and only if it isn't needed for a card of its own rank in the pyramid.
  stuck(s) {
    for (let r = 1; r <= 6; r++) {
      const a = this.ranks[r], b = this.ranks[13 - r];
      const ap = bits(s.pyr & a.pyr), bp = bits(s.pyr & b.pyr), at = bits(~s.rem & a.talon), bt = bits(~s.rem & b.talon);
      if (Math.max(ap - bt, bp - at, 0) > Math.min(ap, bp)) return true;
    }
    for (let p = 0; p < PLACES; p++) {
      const m = this.mates[p];
      if (m && s.pyr & (1 << p) && !(s.pyr & m.pyr) && !(~s.rem & m.talon)) return true;
    }
    return false;
  }

  // The talon's top cards with the deck at `next`: the one turned up (-1 for none) and the waste's top card (-1 for none),
  // as places in it.
  tops(s, next = s.next, drawn = s.drawn) {
    let j = next - 1;
    while (j >= 0 && s.rem & (1 << j)) j--;
    if (!drawn) return [-1, j];
    let w = j - 1;
    while (w >= 0 && s.rem & (1 << w)) w--;
    return [j, w];
  }

  // Every move from here, the most promising first. A king that's free goes at once, as it can only help. Then the pairs
  // of cards free now, and then of each card the deck can turn up with a card free then, the nearest first; of each,
  // pairs that take two cards from the pyramid, then one, then none, and the ones lower down first.
  moves(s) {
    const out = [], free = [];
    for (let p = PLACES - 1; p >= 0; p--) if (s.pyr & (1 << p) && !(s.pyr & COVER[p])) free.push({ p, c: this.cards[p] });
    const [d, w] = this.tops(s);
    if (d >= 0) free.push({ t: d, c: this.talon[d] });
    if (w >= 0) free.push({ t: w, c: this.talon[w] });
    const king = free.find(f => rankOf(f.c) === 13);
    if (king) return [{ k: 'king', x: king, c: king.c }];
    const add = (x, y, jump, far) => {
      const score = ((x.p !== undefined) + (y.p !== undefined)) * 100 + (x.p ?? -1) + (y.p ?? -1) - far;
      out.push({ k: 'pair', x, y, jump, c: x.c, d: y.c, score });
    };
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) if (rankOf(free[i].c) + rankOf(free[j].c) === 13) add(free[i], free[j], null, 0);
    }
    // The cards still to come this time through, then the ones before them, the next time through.
    const pyr = free.filter(f => f.p !== undefined), n = this.talon.length;
    const later = [];
    for (let j = s.next; j < n; j++) if (!(s.rem & (1 << j))) later.push([j, s.pass]);
    if (s.pass < PASSES) for (let j = 0; j < s.next; j++) if (!(s.rem & (1 << j)) && !(s.drawn && j === d)) later.push([j, s.pass + 1]);
    later.forEach(([j, pass], far) => {
      const x = { t: j, c: this.talon[j] }, jump = { next: j + 1, pass };
      if (rankOf(x.c) === 13) { out.push({ k: 'king', x, jump, c: x.c, score: 50 - far }); return; }
      for (const y of pyr) if (rankOf(x.c) + rankOf(y.c) === 13) add(x, y, jump, far + 1);
      const [, under] = this.tops(s, j + 1, 1);
      if (under >= 0 && rankOf(x.c) + rankOf(this.talon[under]) === 13) add(x, { t: under, c: this.talon[under] }, jump, far + 1);
    });
    out.sort((m, k) => k.score - m.score);
    return out;
  }

  // Whether a tap on the deck does anything: a card to turn up, or the waste to turn back over.
  canTurn(s) {
    const n = this.talon.length;
    for (let j = s.next; j < n; j++) if (!(s.rem & (1 << j))) return true;
    return s.pass < PASSES && s.rem !== (1 << n) - 1;
  }

  apply(s, m) {
    const n = { ...s };
    if (m.jump) { n.next = m.jump.next; n.pass = m.jump.pass; n.drawn = 1; }
    const [d] = this.tops(n);
    for (const f of m.k === 'king' ? [m.x] : [m.x, m.y]) {
      if (f.p !== undefined) n.pyr &= ~(1 << f.p);
      else { n.rem |= 1 << f.t; if (f.t === d) n.drawn = 0; }
    }
    return n;
  }

  // Look at up to `budget` more positions. Returns the result, or null if there's more to look at.
  step(budget) {
    if (this.result) return this.result;
    const stop = this.nodes + budget, stack = this.stack;
    while (stack.length) {
      if (this.nodes >= stop) return null;
      const f = stack[stack.length - 1];
      if (f.i >= f.moves.length) { stack.pop(); continue; }
      const m = f.moves[f.i++], st = this.apply(f.st, m), k = this.key(st);
      if (this.seen.get(k) <= st.pass) continue;
      this.seen.set(k, st.pass);
      this.nodes++;
      if (this.prune && this.stuck(st)) continue;
      if (this.goal(st, this.root)) {
        stack.push({ st, moves: [], i: 0, via: m });
        this.result = 'won';
        this.path = stack.slice(1).map(x => plain(x.via));
        this.stack = [];
        return this.result;
      }
      stack.push({ st, moves: this.moves(st), i: 0, via: m });
    }
    this.result = 'lost';
    return this.result;
  }

  // Look until it knows, or until `max` positions have been seen ('unknown').
  run(max) {
    while (!this.result) {
      if (this.nodes >= max) return 'unknown';
      this.step(Math.min(5000, max - this.nodes));
    }
    return this.result;
  }

  // The move to suggest: the first of the winning line, or, if there wasn't time to find one, the move that looked best
  // to begin with.
  firstMove() {
    if (this.path) return this.path[0] ?? null;
    return this.rootMoves[0] ? plain(this.rootMoves[0]) : null;
  }

  firstMoves() {
    if (this.path) return [this.firstMove()].filter(Boolean);
    return this.rootMoves.map(plain);
  }
}

// Whether anything can still help: a line of moves, taps on the deck among them, that takes a card from the pyramid.
// The search with that as its goal: result 'dead' once it has looked everywhere and none does, 'live' once one does;
// none says there's no move at all.
export class Progress {
  constructor(p) {
    this.search = new Search(p, { goal: (s, root) => !!root && bits(s.pyr) < bits(root.pyr) });
    this.none = !this.search.rootMoves.length && !this.search.canTurn(this.search.root);
    this.result = this.search.result === 'won' ? 'live' : null;
  }
  get nodes() { return this.search.nodes; }
  step(budget) {
    if (this.result) return this.result;
    const r = this.search.step(budget);
    if (r) this.result = r === 'won' ? 'live' : 'dead';
    return this.result;
  }
  run(max) {
    while (!this.result) {
      if (this.nodes >= max) return 'unknown';
      this.step(Math.min(5000, max - this.nodes));
    }
    return this.result;
  }
}

// A move without the search's working parts, to keep in a path.
const plain = m => (m.k === 'king' ? { k: 'king', c: m.c } : { k: 'pair', c: m.c, d: m.d });
