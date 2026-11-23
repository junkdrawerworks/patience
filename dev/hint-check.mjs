// Plays deals the way someone who always does what Hint says would: press Hint, make that move, let cards go up by
// themselves (or not), and again, until the game is won. Counts the games won, and any that end with "no way to win",
// a move the table refuses, Hint leading back to a table it has already been at (round in circles for good), or the
// game saying no move can help at a table on the way to a win.
//   node dev/hint-check.mjs [k1|k3|fc|s1|s2|s4] [deals] [on|off] [first deal|list]
// Deals are the ones the game would hand out from the first deal number on: those its solver wins within its limit.
// With `list`, the deals checked in advance for that way instead (js/games/ready-deals.js), the first of them.
import { VARIANTS } from '../js/games/index.js';
import { READY_DEALS } from '../js/games/ready-deals.js';
import { hintFor } from '../js/deals.js';

const V = process.argv[2] || 'k1', AUTO = process.argv[4] !== 'off', LIST = process.argv[5] === 'list';
const N = Math.min(+(process.argv[3] || 30), LIST ? READY_DEALS[V].length : Infinity), FIRST = LIST ? 0 : +(process.argv[5] || 1);
const game = VARIANTS[V].game;
const where = s => JSON.stringify(s, (k, x) => (k === 'moves' || k === 'fan' ? undefined : x));
const settle = s => {
  for (let st; AUTO && !game.won(s) && !game.finishable(s) && (st = game.autoStep(s));) s = game.move(s, st.from, st.n, st.to);
  while (game.finishable(s)) { const st = game.finishStep(s); s = st.stock ? game.stock(s) : game.move(s, st.from, st.n, st.to); }
  return s;
};

const tally = { won: 0, lost: 0, refused: 0, circles: 0, unfinished: 0, 'said out of moves': 0 };
let presses = 0, slowest = 0, slowestOut = 0;
for (let k = FIRST, played = 0; played < N; k++) {
  const n = LIST ? READY_DEALS[V][k] : k;
  const check = game.search(game.deal(n, V));
  if (check.run(game.budget.deal) !== 'won') { if (LIST) { played++; tally.unchecked = (tally.unchecked ?? 0) + 1; console.log(`deal ${n}: not won by the solver`); } continue; }
  played++;
  let s = settle(game.deal(n, V)), end = 'unfinished';
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    if (game.won(s)) { end = 'won'; break; }
    if (seen.has(where(s))) { end = 'circles'; break; }
    seen.add(where(s));
    const t1 = performance.now();
    const out = game.outOfMoves(s, { auto: AUTO });
    slowestOut = Math.max(slowestOut, performance.now() - t1);
    if (out) { end = 'said out of moves'; break; }
    const t0 = performance.now();
    const h = await hintFor(s, { auto: AUTO });
    slowest = Math.max(slowest, performance.now() - t0);
    presses++;
    if (!h.move) { end = 'lost'; break; }
    const next = h.move.stock ? game.stock(s) : game.move(s, h.move.from, h.move.n, h.move.to);
    if (!next) { end = 'refused'; break; }
    s = settle(next);
  }
  tally[end]++;
  if (end !== 'won') console.log(`deal ${n}: ${end}`);
}
console.log(`${V}, cards going up by themselves ${AUTO ? 'on' : 'off'}, ${N} deals:`, tally, `${presses} presses of Hint, slowest ${slowest.toFixed(0)} ms; slowest look for a move that helps ${slowestOut.toFixed(0)} ms`);
