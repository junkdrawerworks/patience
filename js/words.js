// What just happened, in a few plain words, for the line a screen reader reads out once a move has settled
// (say() in app.js): "7 of hearts onto the 8 of spades. Turned over the queen of clubs."

import { SUIT_NAMES, RANK_NAMES, rankOf, suitOf, shortName } from './cards.js';

const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
const rank = c => (rankOf(c) > 1 && rankOf(c) < 11 ? String(rankOf(c)) : RANK_NAMES[rankOf(c)]);
const list = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const COUNT = ['no', 'one', 'two', 'three'];

// The cards picked up: the one at the bottom, and how many came with it.
const what = cards => `${shortName(cards[0])}${cards.length > 1 ? ` and ${cards.length - 1} more` : ''}`;

// Where they went in table `s`, before they got there.
function where(g, s, to) {
  if (to[0] === 'f') return 'to its foundation';
  if (to[0] === 'c') return 'to a free cell';
  const top = g.pile(s, to).up.slice(-1)[0];
  return top !== undefined ? `onto the ${shortName(top)}` : 'to an empty column';
}

// A move `m` the player made from table a, making table b: { from, n, to }, or { stock: true } for the deck.
export function moveWords(g, a, b, m) {
  let first;
  if (g.pairs) first = pairWords(g, a, b, m);
  else if (!m.stock) first = cap(`${what(g.pile(a, m.from).up.slice(-m.n))} ${where(g, a, m.to)}.`);
  else if (!Array.isArray(a.waste)) first = 'Dealt a row.';
  else if (b.waste.length > a.waste.length) {
    const n = b.waste.length - a.waste.length, top = shortName(b.waste[b.waste.length - 1]);
    first = n === 1 ? `Drew the ${top}.` : `Drew ${COUNT[n] || n}, with the ${top} on top.`;
  } else first = 'Turned the pile back over.';
  return [first, ...aftermath(g, a, b)].join(' ');
}

// The same in Pyramid: "6 of hearts and 7 of clubs taken away." "Turned up the jack of spades." "Turned the pile back
// over, for the last time through."
const TIMES = ['', 'first', 'second', 'third'];
function pairWords(g, a, b, m) {
  if (m.stock) {
    if (b.drawn.length) return `Turned up the ${shortName(b.drawn[0])}.`;
    return `Turned the pile back over, for the ${g.passes(b) ? TIMES[b.pass] || b.pass : 'last'} time through.`;
  }
  const c = g.pile(a, m.from).up.slice(-1)[0], d = m.to === 'out' ? null : g.pile(a, m.to).up.slice(-1)[0];
  return cap(`${shortName(c)}${d === null ? '' : ` and ${shortName(d)}`} taken away.`);
}

// What else changed from table a to b, on top of the cards moved: runs cleared away (Spider), cards turned over.
export function aftermath(g, a, b) {
  const out = [];
  if (Array.isArray(b.sets)) {
    for (let i = a.sets.length; i < b.sets.length; i++) {
      const set = b.sets[i];
      out.push(`${cap(SUIT_NAMES[suitOf(set[set.length - 1])])} cleared, ${i + 1} of 8.`);
    }
  }
  const turned = [];
  for (const id of g.layout(b, false).tableau) {
    const was = g.pile(a, id).down;
    for (const c of g.pile(b, id).up) if (was.includes(c)) turned.push(c);
  }
  if (turned.length) out.push(`Turned over the ${list(turned.map(shortName))}.`);
  return out;
}

// Cards that went up by themselves, in the order they went: "Up by themselves: the ace and 2 of hearts."
export function upWords(cards) {
  const runs = [];
  for (const c of cards) {
    const last = runs[runs.length - 1];
    if (last && last.suit === suitOf(c)) last.ranks.push(rank(c));
    else runs.push({ suit: suitOf(c), ranks: [rank(c)] });
  }
  return `Up by themselves: ${list(runs.map(r => `the ${list(r.ranks)} of ${SUIT_NAMES[r.suit]}`))}.`;
}

// Cards picked up with the keyboard, or put back (none): "Holding the 7 of hearts and 2 more."
export const heldWords = cards => (cards.length ? `Holding the ${what(cards)}.` : 'Put back.');

// Hint's move `h` in table s: "Hint: the queen of hearts onto the king of clubs."
export function hintWords(g, s, h) {
  if (g.pairs) {
    if (h.stock) return s.stock.length ? 'Hint: turn up a card.' : 'Hint: turn the pile back over.';
    const c = g.pile(s, h.from).up.slice(-1)[0], d = h.to === 'out' ? null : g.pile(s, h.to).up.slice(-1)[0];
    return d === null ? `Hint: take away the ${shortName(c)}.` : `Hint: the ${shortName(c)} with the ${shortName(d)}.`;
  }
  if (h.stock) return !Array.isArray(s.waste) ? 'Hint: deal a row.' : s.stock.length ? 'Hint: draw a card.' : 'Hint: turn the pile back over.';
  return `Hint: the ${what(g.pile(s, h.from).up.slice(-h.n))} ${where(g, s, h.to)}.`;
}
