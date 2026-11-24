// Solves Pyramid deals and replays every win through the table's own rules, tapping the deck for each card it draws for.
//   node dev/pyramid-check.mjs [deals] [max positions] [first deal]
// The limit is the one the game checks a deal with before it reaches you, unless you give another.
import { pyramid } from '../js/games/pyramid.js';

const N = +(process.argv[2] || 100), MAX = +(process.argv[3] || pyramid.budget.deal), FIRST = +(process.argv[4] || 1);
const tally = { won: 0, lost: 0, unknown: 0 };
let total = 0, worst = 0, nodes = 0, lengths = 0;
for (let n = FIRST; n < FIRST + N; n++) {
  let s = pyramid.deal(n);
  const t0 = performance.now();
  const search = pyramid.search(s), r = search.run(MAX);
  const ms = performance.now() - t0;
  total += ms; worst = Math.max(worst, ms); nodes += search.nodes; tally[r]++;
  if (r !== 'won') continue;
  for (let i = 0, taps = 0; i < search.path.length;) {
    const m = pyramid.fromSolver(s, search.path[i]);
    s = m.stock ? pyramid.stock(s) : pyramid.move(s, m.from, m.n, m.to);
    if (!s) throw new Error(`deal ${n}: illegal ${JSON.stringify(search.path[i])}`);
    if (!m.stock) { i++; lengths++; taps = 0; } else if (++taps > 80) throw new Error(`deal ${n}: the deck never turned up the card wanted`);
  }
  if (!pyramid.won(s)) throw new Error(`deal ${n}: did not finish`);
}
console.log(`${N} deals from ${FIRST}, max ${MAX}:`, tally, `avg ${(total / N).toFixed(0)} ms, worst ${worst.toFixed(0)} ms, avg nodes ${(nodes / N) | 0}, avg pairs and kings ${(lengths / Math.max(1, tally.won)).toFixed(0)}`);
