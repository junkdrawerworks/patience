// Finds the deals for Today's deal, one a day for each way of playing, for js/games/daily-deals.js:
//   node dev/daily-deals.mjs [k1|k3|fc|s1|s2|s4|py|all] [days]
// Each is one the solver wins in the limit the game checks its own deals with, so every phone gets one that can be
// won without solving anything itself. Lists only ever grow: the days already there keep their deals, and new ones go
// on the end (366 days unless you say how many). The dates come from DAILY_START, which stays as it is.
// node dev/daily-deals.mjs --check  checks every deal in every list instead (a few minutes; four-suit Spider is slow).
import { writeFile } from 'node:fs/promises';
import { VARIANTS } from '../js/games/index.js';
import { READY_DEALS } from '../js/games/ready-deals.js';
import { DAILY_START, DAILY_DEALS } from '../js/games/daily-deals.js';

const won = (v, n) => { const game = VARIANTS[v].game; return game.search(game.deal(n, v)).run(game.budget.deal) === 'won'; };

if (process.argv[2] === '--check') {
  let bad = 0;
  for (const [v, list] of Object.entries(DAILY_DEALS)) {
    const lost = list.filter(n => !won(v, n)), twice = list.length - new Set(list).size;
    console.log(`${v}: ${list.length - lost.length} of ${list.length} won`, lost.length ? `(not ${lost.join(', ')})` : '', twice ? `${twice} twice` : '');
    bad += lost.length + twice;
  }
  process.exit(bad ? 1 : 0);
}

const which = process.argv[2] || 'all', DAYS = +(process.argv[3] || 366);
const ways = which === 'all' ? Object.keys(VARIANTS) : [which];
if (!ways.every(v => VARIANTS[v]) || !(DAYS > 0)) { console.error('usage: node dev/daily-deals.mjs k1|k3|fc|s1|s2|s4|py|all [days]'); process.exit(1); }
const lists = Object.fromEntries(Object.keys(VARIANTS).map(v => [v, (DAILY_DEALS[v] ?? []).slice()]));
for (const v of ways) {
  const game = VARIANTS[v].game, list = lists[v], taken = new Set([...list, ...READY_DEALS[v]]);
  let tried = 0;
  while (list.length < DAYS) {
    const n = game.randomDeal();
    if (taken.has(n)) continue;
    taken.add(n);
    tried++;
    if (won(v, n)) { list.push(n); if (list.length % 50 === 0) process.stdout.write(`${v} ${list.length} `); }
  }
  console.log(`\n${v}: ${list.length} days${tried ? `, ${tried} tried` : ''}`);
  await save();
}

async function save() {
  const wrap = list => list.join(', ').replace(/(.{1,100})(, |$)/g, '    $1,\n');
  await writeFile(new URL('../js/games/daily-deals.js', import.meta.url),
    `// Today's deal: one deal a day for each way of playing, the same on every phone, found by dev/daily-deals.mjs. Every
// one has been won by the solver in the limit the game checks its own deals with. The first in each list is the deal for
// DAILY_START, the next for the day after, and so on; after the last day each list comes round again from the start.
// (FreeCell's are Windows numbers.)
export const DAILY_START = '${DAILY_START}';
export const DAILY_DEALS = {
${Object.keys(VARIANTS).map(v => `  ${v}: [\n${wrap(lists[v])}  ],\n`).join('')}};
`);
}
