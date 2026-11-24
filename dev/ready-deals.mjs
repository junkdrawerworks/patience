// Finds deals the solver can win for one way of playing, for js/games/ready-deals.js:  node dev/ready-deals.mjs k3 [how many]
// node dev/ready-deals.mjs --check  checks every deal in every list instead (about a minute and a half).
// The game finds its own as you play; these are so the first game of each way doesn't have to wait. Rewrites that way's
// list (k1, k3, fc, s1, s2, s4 or py) and leaves the others as they are. The numbers are picked at random from the same
// range the game picks from (randomDeal), so a list isn't just the first few deals.
import { writeFile } from 'node:fs/promises';
import { VARIANTS } from '../js/games/index.js';
import { READY_DEALS } from '../js/games/ready-deals.js';

if (process.argv[2] === '--check') {
  let bad = 0;
  for (const [v, list] of Object.entries(READY_DEALS)) {
    const game = VARIANTS[v].game, lost = list.filter(n => game.search(game.deal(n, v)).run(game.budget.deal) !== 'won');
    console.log(`${v}: ${list.length - lost.length} of ${list.length} won`, lost.length ? `(not ${lost.join(', ')})` : '');
    bad += lost.length;
  }
  process.exit(bad ? 1 : 0);
}

const v = process.argv[2], WANT = +(process.argv[3] || 50);
if (!VARIANTS[v]) { console.error('usage: node dev/ready-deals.mjs k1|k3|fc|s1|s2|s4|py [how many]'); process.exit(1); }
// Checked with the same limit as the deals the game finds itself, which Hint gets too, so its first press knows the way.
const game = VARIANTS[v].game, MAX = game.budget.deal, found = new Set(), tried = new Set();
while (found.size < WANT) {
  const n = game.randomDeal();
  if (tried.has(n)) continue;
  tried.add(n);
  if (game.search(game.deal(n, v)).run(MAX) === 'won') { found.add(n); process.stdout.write(`${found.size}:${n} `); }
}
const lists = { ...READY_DEALS, [v]: [...found].sort((a, b) => a - b) };
const wrap = list => list.join(', ').replace(/(.{1,100})(, |$)/g, '    $1,\n');
await writeFile(new URL('../js/games/ready-deals.js', import.meta.url),
  `// Deals the solver has won, for each way of playing, found by dev/ready-deals.mjs (FreeCell's are Windows numbers).
// A new game takes one of these when no freshly checked deal is ready yet: the first game of each way, and the first
// time it's opened.
export const READY_DEALS = {
${Object.keys(VARIANTS).map(w => `  ${w}: [\n${wrap(lists[w] ?? [])}  ],\n`).join('')}};
`);
console.log(`\n${v}: ${found.size} won of ${tried.size} tried`);
