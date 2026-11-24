// The games Patience plays, and the ways to play each one.
//
// Every game is an object with the same parts, so the table and the rest of the app don't need to know which it is.
// A few parts only some games have, and the rest of the app does without them where a game doesn't (marked below).
// States are plain objects that are never changed in place; each has `v` (the way of playing, a key below),
// `deal` (the deal number) and `moves`. A game of Today's deal has `daily` too (the day it was dealt for), which the app
// adds and every move carries along as it is, as it does anything else in a state it doesn't know.
//
//   deal(n, v)              a new game: deal number n of way v
//   layout(s, left)         where the piles go: { cols, rows?, split?, top: [{ id, col, kind, label?, dir? }], tableau: [ids],
//                           empty?, dealFrom } (rows: how many card heights a long column needs, for sizing the cards on a
//                           short screen; split: a top-row column with a faint line before it, setting its piles apart from
//                           the ones before it, as FreeCell's foundations from its free cells; label and empty: a faint
//                           letter in an empty place, a top-row one's or every column's, for the card that starts it)
//                           kinds: 'stock' and 'deals' (tap to draw or deal), 'waste', 'stack' (foundations, free cells),
//                           'sets' (Spider's cleared runs), and 'column' for the tableau
//   pile(s, id)             the cards in a pile: { down: [...], up: [...] }, bottom to top
//   fan(s)                  how many waste cards are spread out (drawing three); only Klondike has it
//   cardIds(s)              every card in this game
//   lift(s, id, index)      the cards that come up when picking up card `index` of a pile's face-up cards, or null
//   targets(s)              the piles cards can be dropped on
//   canDrop(s, cards, to)   whether they can go there
//   move(s, from, n, to)    the new state, or null if the rules say no
//   stock(s)                the new state after tapping the stock, or null; stockNote(s) says why not, if it matters:
//                           { text, piles }, piles being any to light up (the empty columns Spider wants filled)
//   dropNote(s, cards, to)  only Klondike and FreeCell: why cards let go on pile `to` can't go there, if it's a rule a
//                           newcomer mightn't know, or null (a king for an empty Klondike column; room for a FreeCell run)
//   liftNote(s, id, index)  only Spider: why the cards from face-up card `index` of a pile up can't be picked up, or null;
//                           said the first time in a deal that they're dragged anyway (a tap only shakes them)
//   tapTarget(s, from, n)   where a tap sends the top n cards of a pile, or null
//   autoStep(s)             a card that can go up by itself because nothing could need it, or null
//   won(s), finishable(s), finishStep(s)    finished; ready to finish by itself; the next card when it does, as a move,
//                           or { stock: true } to tap the stock (Klondike drawing one, when no card fits)
//   easyHint(s)             a hint for a position the solver calls as good as won (Klondike and FreeCell only)
//   position(s)             the table the way its solver sees it (FreeCell and Spider)
//   search(s, { auto })     a solver for this position (step(budget), result, path, firstMove()); auto says whether
//                           cards go up by themselves, which Klondike drawing three needs to know (on unless false)
//   searchAll(s, { auto })  only where search(s) leaves moves out (Klondike, Spider): a solver that tries every move, to
//                           make sure before Hint says there's no way to win (Spider's first tries the quick moves and a
//                           few more)
//   firstMoves() on either search: every first move, the most promising first, for when the best one leads back
//   lostStands              only Klondike: if searchAll runs out too, the first search's "no way to win" stands; without
//                           it, Hint suggests the move that looked best
//   fromSolver(s, m)        a solver move as a table move: { from, n, to }, or { stock: true } (Klondike adds c, the card
//                           it's drawing for; so does its easyHint)
//   upAlready(s, m)         whether a solver move sending a card up is done already, the card having gone up by itself
//                           (Klondike and FreeCell only, the games where cards go up by themselves)
//   deadEnd(s, { auto })    a look for anything that can still help, run a slice at a time like the searches
//                           (step(budget), nodes, run(max)): result 'dead' once it's sure nothing can (no line of moves
//                           puts a card up, turns one over, frees a cell, empties a column or deals a row), 'live' once
//                           something does; none says there's no move at all. At its limit it can't say, which isn't dead
//   outOfMoves(s, { auto }) deadEnd run to its limit at once: true only if it's sure nothing can help
//   bounceOrder(s)          the cards in the order they bounce off the table when it's won
//   dealOrder(s)            the cards in the order they're dealt, for the dealing animation
//   randomDeal()            a deal number, from 1 to lastDeal
//   lastDeal                the highest deal number, for a deal asked for by its number too: 32,000 for FreeCell and
//                           999,999 for the others
//   budget                  how many positions the solver may look at: { deal, hint }, { all } for searchAll, and
//                           { dead } for deadEnd; Spider adds { idle }, as far as a look that ran out at `dead` carries on
//                           while the table is left as it is

import { klondike } from './klondike.js';
import { freecell } from './freecell.js';
import { spider } from './spider.js';

export const VARIANTS = {
  k1: { game: klondike, name: 'Klondike', detail: 'draw one' },
  k3: { game: klondike, name: 'Klondike', detail: 'draw three' },
  fc: { game: freecell, name: 'FreeCell', detail: '' },
  s1: { game: spider, name: 'Spider', detail: 'one suit' },
  s2: { game: spider, name: 'Spider', detail: 'two suits' },
  s4: { game: spider, name: 'Spider', detail: 'four suits' },
};

export const gameOf = s => VARIANTS[s.v].game;
export const label = v => (VARIANTS[v].detail ? `${VARIANTS[v].name}, ${VARIANTS[v].detail}` : VARIANTS[v].name);
