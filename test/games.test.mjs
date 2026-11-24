// FreeCell and Spider rules and solvers, and Hint in every game, checked in Node:  node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { card, suitOf, rankOf } from '../js/cards.js';
import { freecell, room } from '../js/games/freecell.js';
import { spider } from '../js/games/spider.js';
import { pyramid, forSolver as pyramidPosition } from '../js/games/pyramid.js';
import { Search as PyramidSearch } from '../js/solvers/pyramid.js';
import { VARIANTS } from '../js/games/index.js';
import { READY_DEALS } from '../js/games/ready-deals.js';
import { hintFor, primeLine, Dealer, deadEnd, backTo } from '../js/deals.js';
import { SpiderSearch, SpiderSure, spiderRules } from '../js/solvers/spider.js';

const S = 0, H = 1, C = 2, D = 3;
const name = c => 'A23456789TJQK'[rankOf(c) - 1] + 'SHCD'[suitOf(c)];
const emptyFC = () => ({ v: 'fc', deal: 0, tab: Array.from({ length: 8 }, () => []), cells: [null, null, null, null], found: [[], [], [], []], moves: 0 });

// ---- FreeCell ----

test('FreeCell deals match the numbered deals from Windows', () => {
  // Row by row, as dealt across the eight columns. Games 1 and 617 are the examples in Rosetta Code's task "Deal cards
  // for FreeCell"; 24 and 11982 (the one that can't be won) come from the same Microsoft shuffle, worked out separately
  // from the steps that task gives. The shuffle must never change: old deal numbers and saved games would change with it.
  const rows = s => Array.from({ length: 7 }, (_, r) => s.tab.map(t => (t[r] === undefined ? '' : name(t[r]))).join(' ').trim());
  const layouts = {
    1: ['JD 2D 9H JC 5D 7H 7C 5H', 'KD KC 9S 5S AD QC KH 3H', '2S KS 9D QD JS AS AH 3C', '4C 5C TS QH 4H AC 4D 7S',
      '3S TD 4S TH 8H 2C JH 7D', '6D 8S 8D QS 6C 3D 8C TC', '6S 9C 2H 6H'],
    24: ['4C 5H QC 5D 2D 7H AH 7S', '2C QH 9S 2S KD JS 5S 6C', '9C 3C 6H JC TH KH 6S 7D', '8C AC 9H 5C TC TS AD 4D',
      'QS 3H 3S JH TD KC 8H 8S', '4S 4H KS 6D 8D 7C JD 9D', '2H QD 3D AS'],
    617: ['7D AD 5C 3S 5S 8C 2D AH', 'TD 7S QD AC 6D 8H AS KH', 'TH QC 3H 9D 6S 8D 3D TC', 'KD 5H 9S 3C 8S 7H 4D JS',
      '4C QS 9C 9H 7C 6H 2C 2S', '4S TS 2H 5D JC 6C JH QH', 'JD KS KC 4H'],
    11982: ['AH AS 4H AC 2D 6S TS JS', '3D 3H QS QC 8S 7H AD KS', 'KD 6H 5S 4D 9H JH 9S 3C', 'JC 5D 5C 8C 9D TD KH 7C',
      '6C 2C TH QH 6D TC 4S 7S', 'JD 7D 8H 9C 2H QD 4C 5H', 'KC 8D 2S 3S'],
  };
  for (const [n, layout] of Object.entries(layouts)) assert.deepEqual(rows(freecell.deal(+n)), layout, `game ${n}`);
  const s = freecell.deal(617);
  assert.deepEqual(s.tab.map(t => t.length), [7, 7, 7, 7, 6, 6, 6, 6]);
  assert.equal(new Set(s.tab.flat()).size, 52);
});

test('FreeCell says so when the only move left goes back and forth, and not while a card can still go up', () => {
  // Deal 3001, a long way in: the four free cells hold the 3 of clubs, king of diamonds, 8 of spades and 2 of clubs, and
  // the only move is the 10 of spades from the seventh column onto the jack of diamonds in the second, and back.
  const s = {
    v: 'fc', deal: 3001, moves: 1500, cells: [28, 51, 7, 27], found: [[39, 40, 41, 42, 43, 44, 45, 46], [], [], []],
    tab: [[15, 30, 16, 0, 5, 13, 38, 24, 10, 22, 34], [21, 1, 37, 49], [17, 47, 48, 8, 20, 32], [33, 19, 31], [50, 29, 6, 18, 4],
      [14, 26, 36], [3, 2, 35, 25, 11, 23, 9], [12]],
  };
  assert.deepEqual(s.cells.map(name), ['3C', 'KD', '8S', '2C']);
  const there = freecell.move(s, 't6', 1, 't1');
  assert.ok(there && freecell.move(there, 't1', 1, 't6'), 'the 10 can go there and back');
  assert.equal(freecell.outOfMoves(s), true);
  assert.equal(freecell.outOfMoves(there), true);
  assert.equal(freecell.deadEnd(s).none, false, 'a move is left, just none that helps');
  assert.equal(freecell.search(s).run(1000), 'lost', 'and the solver agrees it can’t be won');
  // With the ace of clubs up instead of under the jack, the 2 and 3 of clubs can follow it from the free cells.
  const t = { ...s, tab: s.tab.map((c, i) => (i === 5 ? [14, 36] : c)), found: [s.found[0], [26], [], []] };
  assert.equal(freecell.outOfMoves(t), false);
});

test('FreeCell runs move only as far as free cells and empty columns allow', () => {
  const s = emptyFC();
  s.tab[0] = [card(S, 9), card(H, 8), card(C, 7), card(D, 6), card(S, 5)];
  s.tab[1] = [card(D, 10)];
  s.tab[2] = [card(C, 13)]; s.tab[3] = [card(D, 13)]; s.tab[4] = [card(H, 13)]; s.tab[5] = [card(S, 13)]; s.tab[6] = [card(C, 12)]; s.tab[7] = [card(D, 12)];
  s.cells = [card(H, 2), card(H, 3), null, null];
  assert.equal(room(s, false), 3);
  assert.equal(freecell.move(s, 't0', 5, 't1'), null, 'five cards need more room than two free cells give');
  s.cells = [null, null, null, null];
  assert.equal(room(s, false), 5);
  const next = freecell.move(s, 't0', 5, 't1');
  assert.deepEqual(next.tab[1].map(name), ['TD', '9S', '8H', '7C', '6D', '5S']);
  assert.deepEqual(next.tab[0], []);
});

test('a FreeCell run going into an empty column has room for fewer cards, as the help says', async () => {
  // Two free cells and one column empty: six cards can go onto a card, but only three into the empty column,
  // since a column can't hold cards on the way while they're being moved into it.
  const s = emptyFC();
  s.tab[0] = [card(S, 9), card(H, 8), card(C, 7), card(D, 6), card(S, 5)];
  s.tab[1] = [card(D, 10)];
  s.tab[2] = [card(C, 13)]; s.tab[3] = [card(D, 13)]; s.tab[4] = [card(H, 13)]; s.tab[5] = [card(S, 13)]; s.tab[6] = [card(C, 12)];
  s.cells = [card(H, 2), card(H, 3), null, null];
  assert.deepEqual([room(s, false), room(s, true)], [6, 3]);
  assert.ok(freecell.move(s, 't0', 5, 't1'), 'five onto the 10 of diamonds');
  assert.equal(freecell.move(s, 't0', 4, 't7'), null, 'but not four into the empty column');
  assert.ok(freecell.move(s, 't0', 3, 't7'), 'three can go there');
  const help = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).match(/<li>A run moves together[^<]*<\/li>/)[0];
  assert.match(help, /doubled for each empty column it isn't going into/);
});

test('a FreeCell run too long for the room says how many cards can move together, and only then', () => {
  const s = emptyFC();
  s.tab[0] = [card(S, 9), card(H, 8), card(C, 7), card(D, 6), card(S, 5)];
  s.tab[1] = [card(D, 10)];
  s.tab[2] = [card(C, 13)]; s.tab[3] = [card(D, 13)]; s.tab[4] = [card(H, 13)]; s.tab[5] = [card(S, 13)]; s.tab[6] = [card(C, 12)];
  s.cells = [card(H, 2), card(H, 3), card(C, 2), null];
  const run = n => s.tab[0].slice(-n);
  assert.equal(freecell.dropNote(s, run(5), 't1'), 'There’s room to move 4 cards together. Free a cell or a column to move 5.');
  assert.equal(freecell.dropNote(s, run(4), 't1'), null, 'four fit');
  assert.equal(freecell.dropNote(s, run(3), 't7'), 'There’s room to move 2 cards together. Free a cell or a column to move 3.', 'into the empty column');
  assert.equal(freecell.dropNote(s, run(4), 't2'), null, 'the wrong card to go on says nothing');
  assert.equal(freecell.dropNote(s, run(2), 'c3'), null, 'nor does a free cell');
  s.cells[3] = card(C, 3);
  s.tab[7] = [card(D, 12)];
  assert.equal(freecell.dropNote(s, run(2), 't1'), null, 'the 6 and 5 can’t go on the 10');
  assert.equal(freecell.dropNote(s, run(5), 't1'), 'There’s room to move 1 card at a time. Free a cell or a column to move 5.');
});

test('a Klondike card that isn’t a king, let go on an empty column, says only a king can go there', async () => {
  const { klondike } = await import('../js/games/klondike.js');
  const s = klondike.deal(1, 'k1');
  const t = { ...s, tab: s.tab.map((c, i) => (i === 0 ? { down: [], up: [] } : c)) };
  assert.equal(klondike.dropNote(t, [card(H, 6)], 't0'), 'Only a king can go in an empty column.');
  assert.equal(klondike.dropNote(t, [card(H, 13)], 't0'), null);
  assert.equal(klondike.dropNote(t, [card(H, 6)], 't1'), null, 'a column with cards in it');
  assert.equal(klondike.dropNote(t, [card(H, 6)], 'f0'), null, 'a foundation');
});

test('a Spider run of mixed suits says why it can’t be picked up', () => {
  const s = spiderEnd('s2', [2, 2], [
    [[], [sp(13), sp(12), ht(11), ht(10)]],
    [[], [ht(13), ht(12), ht(11), ht(10), ht(9), ht(8), ht(7), ht(6), ht(5), ht(4), ht(3), ht(2), ht(1)]],
    [[], [sp(13), sp(12), sp(11), sp(10), sp(9), sp(8), sp(7), sp(6), sp(5), sp(4), sp(3), sp(2), sp(1)]],
    [[], [sp(11), sp(10), sp(9), sp(8)]], [[], [sp(7), sp(6), sp(5), sp(4), sp(3), sp(2), sp(1)]], [[], [ht(13), ht(12)]],
    [[], [ht(9), ht(8), ht(7)]], [[], [ht(6), ht(5)]], [[], [ht(4), ht(3)]], [[], [ht(2), ht(1)]],
  ]);
  assert.equal(spider.lift(s, 't0', 1), null);
  assert.equal(spider.liftNote(s, 't0', 1), 'Only a run of one suit moves together.');
  assert.ok(spider.lift(s, 't0', 2), 'the jack and 10 of hearts come up');
});

test('a FreeCell tap sends a card up, then onto a column, then into a free cell', () => {
  const s = emptyFC();
  s.tab[0] = [card(D, 9), card(S, 1)];
  s.tab[1] = [card(C, 10)];
  s.tab[2] = [card(H, 4)];
  for (let i = 3; i < 8; i++) s.tab[i] = [card(i % 4, 13)];
  assert.equal(freecell.tapTarget(s, 't0', 1), 'f0');
  const up = freecell.move(s, 't0', 1, 'f0');
  assert.equal(freecell.tapTarget(up, 't0', 1), 't1', '9 of diamonds onto the 10 of clubs');
  assert.equal(freecell.tapTarget(up, 't2', 1), 'c0', 'nowhere else for the 4 of hearts');
  assert.equal(freecell.lift(up, 'f0', 0), null, 'cards on the foundations stay up');
});

test('a single FreeCell card tapped from a column tries a free cell before an empty column; runs and free-cell cards still take the column', () => {
  const s = emptyFC();
  s.tab[0] = [card(S, 13), card(H, 8), card(C, 7)];
  s.tab[1] = [card(S, 2), card(D, 4)];
  for (let i = 2; i < 7; i++) s.tab[i] = [card(i % 4, 12)];
  s.cells[0] = card(H, 3);
  assert.equal(freecell.tapTarget(s, 't1', 1), 'c1', 'the 4 of diamonds into a free cell, leaving the empty column');
  assert.equal(freecell.tapTarget(s, 't0', 2), 't7', 'the 8 and 7 together into the empty column');
  assert.equal(freecell.tapTarget(s, 'c0', 1), 't7', 'the 3 of hearts from its free cell into the empty column');
  const full = { ...s, cells: [card(H, 3), card(H, 6), card(H, 9), card(H, 11)] };
  assert.equal(freecell.tapTarget(full, 't1', 1), 't7', 'with every free cell full, the empty column');
  const onCard = { ...s, tab: s.tab.map((t, i) => (i === 2 ? [card(S, 5)] : t)) };
  assert.equal(freecell.tapTarget(onCard, 't1', 1), 't2', 'a card it fits still comes before a free cell');
});

test("FreeCell's solver wins are real wins, and deal 11982 can't be won", () => {
  let wins = 0;
  for (let n = 1; n <= 15; n++) {
    let s = freecell.deal(n);
    const search = freecell.search(s);
    if (search.run(100000) !== 'won') continue;
    wins++;
    for (const m of search.path) {
      const ui = freecell.fromSolver(s, m);
      s = freecell.move(s, ui.from, ui.n, ui.to);
      assert.ok(s, `deal ${n}: illegal ${JSON.stringify(m)}`);
    }
    for (let guard = 0; guard < 60 && !freecell.won(s); guard++) {
      const m = freecell.finishStep(s);
      assert.ok(m, `deal ${n}: stuck finishing`);
      s = freecell.move(s, m.from, m.n, m.to);
    }
    assert.ok(freecell.won(s), `deal ${n} did not finish`);
  }
  assert.ok(wins >= 14, `only ${wins} of 15 deals solved`);
  assert.equal(freecell.search(freecell.deal(11982)).run(300000), 'lost');
});

// ---- Spider ----

test('Spider deals 104 cards: 54 on the table, 50 to come, in the suits asked for', () => {
  for (const [v, suits] of [['s1', 1], ['s2', 2], ['s4', 4]]) {
    const s = spider.deal(7, v);
    const all = [...s.stock, ...s.tab.flatMap(t => [...t.down, ...t.up])];
    assert.equal(new Set(all).size, 104, v);
    assert.equal(new Set(all.map(suitOf)).size, suits, v);
    assert.deepEqual(s.tab.map(t => t.down.length + t.up.length), [6, 6, 6, 6, 5, 5, 5, 5, 5, 5]);
    assert.ok(s.tab.every(t => t.up.length === 1));
    assert.equal(s.stock.length, 50);
  }
});

const emptySp = () => ({ v: 's2', deal: 0, tab: Array.from({ length: 10 }, () => ({ down: [], up: [] })), stock: [], sets: [], moves: 0 });

test('in Spider only a run of one suit moves together, onto any card one higher', () => {
  const s = emptySp();
  s.tab[0].up = [card(S, 9), card(S, 8), card(H, 7)];
  s.tab[1].up = [card(H, 9)];
  s.tab[2].up = [card(S, 8)];
  assert.equal(spider.lift(s, 't0', 0), null, 'a mixed run stays put');
  assert.deepEqual(spider.lift(s, 't0', 2), [card(H, 7)]);
  assert.ok(spider.canDrop(s, [card(H, 7)], 't2'), 'any suit one higher');
  assert.equal(spider.tapTarget(s, 't0', 1), 't2');
  s.tab[3].up = [card(H, 8)];
  assert.equal(spider.tapTarget(s, 't0', 1), 't3', 'its own suit first');
});

test('a Spider tap keeps a run of one suit together rather than move its top card onto another suit', () => {
  // The 5 of spades on the 6 of spades, and a 6 of hearts elsewhere: a tap would split the spade run to put the 5 on
  // a heart, so the cards shake instead. With another 6 of spades elsewhere, it goes there. Dragging still allows any.
  const s = emptySp();
  s.tab[0].up = [card(S, 8), card(S, 7), card(S, 6), card(S, 5)];
  s.tab[1].up = [card(H, 6)];
  s.tab[2].up = [card(H, 13)];
  assert.equal(spider.tapTarget(s, 't0', 1), null, 'the 5 stays on its 6 of spades');
  assert.equal(spider.tapTarget(s, 't0', 2), null, 'and the 6 and 5 on their 7');
  assert.ok(spider.move(s, 't0', 1, 't1'), 'a drag can still put it on the 6 of hearts');
  s.tab[3].up = [52 + card(S, 6)];
  assert.equal(spider.tapTarget(s, 't0', 1), 't3', 'onto the other 6 of spades');
  s.tab[0].up = [card(S, 8), card(S, 7), 52 + card(H, 6), card(S, 5)];
  s.tab[3].up = [];
  assert.equal(spider.tapTarget(s, 't0', 1), 't1', 'a 5 of spades on a 6 of hearts still moves to the other 6 of hearts');
});

test('a Spider tap sends a card where it makes the longest run of its suit, finishing king to ace first', () => {
  // King down to 2 of spades in the first column, and lone 2s of spades nearer the ace: the ace goes on the king's run.
  const s = emptySp();
  s.tab[0].up = Array.from({ length: 12 }, (_, i) => card(S, 13 - i));
  s.tab[1].up = [card(H, 9), card(S, 1)];
  s.tab[3].up = [52 + card(S, 2)];
  s.tab[5].up = [104 + card(S, 2)];
  assert.equal(spider.tapTarget(s, 't1', 1), 't0', 'the ace finishes the run');
  // Without the king's run: the 2 of spades on a 3 and a 4 of spades makes the longer run.
  s.tab[0].up = [card(H, 8)];
  s.tab[3].up = [52 + card(S, 3)];
  s.tab[5].up = [104 + card(S, 4), 104 + card(S, 3)];
  s.tab[1].up = [card(H, 9), card(S, 2)];
  assert.equal(spider.tapTarget(s, 't1', 1), 't5', 'onto the longer run');
  s.tab[5].up = [104 + card(S, 3)];
  assert.equal(spider.tapTarget(s, 't1', 1), 't3', 'the same length: the nearest to the right');
});

test('a finished run of one suit clears away and turns over the card under it', () => {
  const s = emptySp();
  s.tab[0] = { down: [card(H, 5)], up: Array.from({ length: 12 }, (_, i) => card(S, 13 - i)) }; // king to 2
  s.tab[1].up = [card(S, 1)];
  const next = spider.move(s, 't1', 1, 't0');
  assert.equal(next.sets.length, 1);
  assert.equal(rankOf(next.sets[0][12]), 13, 'the king on top of the cleared pile');
  assert.deepEqual(next.tab[0], { down: [], up: [card(H, 5)] });
});

test("Spider won't deal a row while a column is empty", () => {
  const s = spider.deal(3, 's1');
  const blocked = { ...s, tab: s.tab.map((t, i) => (i === 4 ? { down: [], up: [] } : t)) };
  assert.equal(spider.stock(blocked), null);
  assert.match(spider.stockNote(blocked).text, /empty column/);
  assert.deepEqual(spider.stockNote(blocked).piles, ['t4'], 'and lights up the empty column');
  const next = spider.stock(s);
  assert.equal(next.stock.length, 40);
  assert.ok(next.tab.every((t, i) => t.up.length === s.tab[i].up.length + 1));
});

test('Spider with fewer cards on the table than columns deals its row once each card has a column of its own', () => {
  // Seven runs cleared, the king, queen and jack of the last one on the table, and the rest of it still to be dealt.
  const run = copy => Array.from({ length: 13 }, (_, r) => copy * 52 + r);
  const tab = Array.from({ length: 10 }, () => ({ down: [], up: [] }));
  tab[0].up = [7 * 52 + 12]; tab[1].up = [7 * 52 + 11]; tab[2].up = [7 * 52 + 10];
  const s = { v: 's1', deal: 1, moves: 300, tab, stock: Array.from({ length: 10 }, (_, r) => 7 * 52 + r), sets: [0, 1, 2, 3, 4, 5, 6].map(run) };
  assert.equal(spider.stockNote(s), null, 'nothing to say');
  const next = spider.stock(s);
  assert.ok(next, 'the row is dealt');
  assert.equal(next.stock.length, 0);
  assert.deepEqual(next.tab.map(t => t.up.length), [2, 2, 2, 1, 1, 1, 1, 1, 1, 1], 'a card on every column');
  assert.equal(spider.outOfMoves(s), false, 'and the deck still helps');
  // The same three cards in one column: they have to be spread out first, and the deck says so.
  const piled = { ...s, tab: s.tab.map((t, i) => ({ down: [], up: i === 0 ? [7 * 52 + 12, 7 * 52 + 11, 7 * 52 + 10] : [] })) };
  assert.equal(spider.stock(piled), null, 'not while two cards share a column');
  assert.deepEqual(spider.stockNote(piled), { text: 'With fewer than ten cards left, give each one a column of its own before dealing a new row.', piles: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'] });
  assert.equal(spider.outOfMoves(piled), false, 'spreading them out still helps');
  // Ten cards or more, and every column still needs a card first.
  const ten = { ...s, tab: s.tab.map((t, i) => ({ down: [], up: i === 9 ? [] : i === 0 ? [7 * 52 + 12, 6 * 52 + 1] : [i < 3 ? t.up[0] : 6 * 52 + i] })), sets: s.sets.slice(0, 6) };
  assert.equal(spider.stock(ten), null);
  assert.match(spider.stockNote(ten).text, /^Put a card in every empty column/);
});

test('the Spider solvers deal the last row once each card left has a column of its own, and win from there', () => {
  const p = { tab: [[7 * 52 + 12], [7 * 52 + 11], [7 * 52 + 10], [], [], [], [], [], [], []], down: Array(10).fill(0),
    stock: Array.from({ length: 10 }, (_, r) => 7 * 52 + r), sets: 7 };
  const search = new SpiderSearch(p);
  while (!search.result) search.step(5000);
  assert.equal(search.result, 'won');
  assert.deepEqual(search.path[0], { deal: true }, 'dealing the row first');
  const piled = { ...p, tab: [[7 * 52 + 12, 7 * 52 + 11, 7 * 52 + 10], [], [], [], [], [], [], [], [], []] };
  const sure = new SpiderSure(piled);
  assert.equal(sure.run(200000), 'won', 'spreading the three out first');
});

for (const [v, n, count] of [['s1', 8, 7], ['s2', 4, 3]]) {
  test(`Spider's solver wins are real wins (${VARIANTS[v].detail})`, () => {
    let wins = 0;
    for (let d = 1; d <= n; d++) {
      let s = spider.deal(d, v);
      const search = spider.search(s);
      if (search.run(120000) !== 'won') continue;
      wins++;
      for (const m of search.path) {
        const ui = spider.fromSolver(s, m);
        s = ui.stock ? spider.stock(s) : spider.move(s, ui.from, ui.n, ui.to);
        assert.ok(s, `deal ${d}: illegal ${JSON.stringify(m)}`);
      }
      assert.ok(spider.won(s), `deal ${d} did not finish`);
    }
    assert.ok(wins >= count, `only ${wins} of ${n} deals solved`);
  });
}

test('a Spider search keeps each table it has still to look at as a few characters, and finds what it always found', () => {
  // A whole table for each of the tens of thousands it keeps took a four-suit search to hundreds of megabytes. Now it
  // keeps the key it already had for the table, which holds every column, and which column each one is on.
  const search = spider.search(spider.deal(1, 's4'));
  assert.equal(search.run(20000), 'unknown');
  const kept = search.heap.items;
  assert.ok(kept.length > 5000, `${kept.length} tables still to look at`);
  assert.ok(kept.every(n => typeof n.state === 'string' && n.state.length === 10 && search.seen.has(n.key)), 'each kept small');

  // A table rebuilt from what's kept plays just as the table did: the same key, moves, score and tables after each move.
  const R = spiderRules, pos = spider.position(spider.deal(3, 's4'));
  let s = R.start(pos).state, i = 0;
  for (; i < 60; i++) {
    const key = R.key(s), back = R.unpack(R.pack(s, key), key, R.start(pos).state);
    assert.deepEqual(back.tab.map(t => t.map(c => c % 52)), s.tab.map(t => t.map(c => c % 52)));
    assert.deepEqual([back.down, back.stock, back.sets, R.score(back)], [s.down, s.stock, s.sets, R.score(s)]);
    const moves = R.moves(s);
    assert.deepEqual(R.moves(back), moves);
    for (const m of moves) assert.equal(R.key(R.apply(back, m).state), R.key(R.apply(s, m).state));
    if (!moves.length) break;
    s = R.apply(s, moves[(i * 7) % moves.length]).state;
  }
  assert.ok(i >= 20 && s.stock.length < 50, `${i} moves, a row dealt among them`);

  // And the same way through as before: four suits, deal 7, in 4,619 tables and 175 moves.
  const won = spider.search(spider.deal(7, 's4'));
  assert.equal(won.run(120000), 'won');
  assert.deepEqual([won.nodes, won.path.length, won.path[0]], [4619, 175, { a: 9, i: 4, b: 4 }]);
  // Rebuilt at every table on that way, every row dealt and run cleared counts the same.
  const start = R.start(spider.position(spider.deal(7, 's4'))).state;
  let t = start;
  for (const m of won.path) {
    t = R.apply(t, m).state;
    const key = R.key(t), back = R.unpack(R.pack(t, key), key, start);
    assert.deepEqual([R.key(back), back.down, back.stock.length, back.sets], [key, t.down, t.stock.length, t.sets]);
  }
  assert.equal(t.sets, 8);
});

// A Spider position with nothing left to deal, built from ranks. One suit plays spades, two suits spades and hearts;
// each card is the next copy of it not used yet (see cards.js). `cleared` is how many runs of each suit are gone.
function spiderEnd(v, cleared, cols) {
  const used = {};
  const next = (suit, rank) => { const k = suit * 13 + rank - 1; used[k] = (used[k] || 0) + 1; return (used[k] - 1) * 52 + k; };
  const sets = cleared.flatMap((n, suit) => Array.from({ length: n }, () => Array.from({ length: 13 }, (_, r) => next(suit, r + 1))));
  const tab = cols.map(([down, up]) => ({ down: down.map(([s, r]) => next(s, r)), up: up.map(([s, r]) => next(s, r)) }));
  const all = [...sets.flat(), ...tab.flatMap(t => [...t.down, ...t.up])];
  assert.equal(new Set(all).size, 104, 'every card once');
  assert.ok(all.every(c => spider.cardIds({ v }).includes(c)), 'only cards from this deck');
  return { v, deal: 0, tab, stock: [], sets, moves: 100 };
}
const sp = r => [S, r], ht = r => [H, r];

test('a Spider game that needs part of a run moved is neither lost nor out of moves', async () => {
  // K to 9 in the first column, 10 to A in the second: moving 8 to A onto the 9 clears a run, and the rest can be won.
  const tops = [13, 13, 10, 6, 6, 4, 4, 2], downs = [12, 12, 11, 11, 9, 8, 8, 7, 7, 5, 5, 3, 3, 2, 1, 1];
  const s = spiderEnd('s1', [5], [
    [[], [13, 12, 11, 10, 9].map(sp)],
    [[], [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map(sp)],
    ...tops.map((r, i) => [[sp(downs[2 * i]), sp(downs[2 * i + 1])], [sp(r)]]),
  ]);
  assert.equal(spider.outOfMoves(s), false);
  const h = await hintFor(s);
  assert.ok(h.move && !h.move.stock, `hint said ${JSON.stringify(h)}`);
  let t = spider.move(s, h.move.from, h.move.n, h.move.to);
  assert.ok(t, 'the hint is a move the table allows');
  const search = spider.searchAll(t);
  assert.equal(search.run(100000), 'won', 'and it still leads to a win');
  for (const m of search.path) {
    const ui = spider.fromSolver(t, m);
    t = ui.stock ? spider.stock(t) : spider.move(t, ui.from, ui.n, ui.to);
    assert.ok(t, `illegal ${JSON.stringify(m)}`);
  }
  assert.ok(spider.won(t));
});

test('Spider is out of moves when cards can only go back and forth, and Hint says it can’t be won', async () => {
  // The 7 can go from one 8 to the other and back, and nothing else can move.
  const s = spiderEnd('s1', [5], [
    [[sp(2), sp(2)], [sp(8), sp(7)]],
    [[sp(2), sp(4)], [sp(8)]],
    [[sp(4), sp(4), sp(6)], [sp(13)]],
    [[sp(6), sp(6), sp(9)], [sp(13)]],
    [[sp(9), sp(9), sp(10)], [sp(13)]],
    [[sp(10), sp(10), sp(12)], [sp(11)]],
    [[sp(12), sp(12), sp(1)], [sp(11)]],
    [[sp(1), sp(3), sp(3)], [sp(5)]],
    [[sp(5), sp(7), sp(11)], [sp(3)]],
    [[sp(7), sp(8), sp(5)], [sp(1)]],
  ]);
  assert.ok(spider.move(s, 't0', 1, 't1'), 'the 7 can move');
  assert.equal(spider.outOfMoves(s), true);
  assert.deepEqual(await hintFor(s), { lost: true });
});

// The Spider table above, where the 7 can only go back and forth: no way to win from it.
const stuck = () => spiderEnd('s1', [5], [
  [[sp(2), sp(2)], [sp(8), sp(7)]], [[sp(2), sp(4)], [sp(8)]], [[sp(4), sp(4), sp(6)], [sp(13)]], [[sp(6), sp(6), sp(9)], [sp(13)]],
  [[sp(9), sp(9), sp(10)], [sp(13)]], [[sp(10), sp(10), sp(12)], [sp(11)]], [[sp(12), sp(12), sp(1)], [sp(11)]],
  [[sp(1), sp(3), sp(3)], [sp(5)]], [[sp(5), sp(7), sp(11)], [sp(3)]], [[sp(7), sp(8), sp(5)], [sp(1)]],
]);
// One move from won: the 7 to the ace onto the 8.
const nearly = () => spiderEnd('s1', [7], [
  [[], [13, 12, 11, 10, 9, 8].map(sp)], [[], [7, 6, 5, 4, 3, 2, 1].map(sp)], ...Array.from({ length: 8 }, () => [[], []]),
]);

test('Take me back finds the last table it can still be won from in a few looks, and Hint carries on from there', async () => {
  for (const [won, lost] of [[3, 3], [60, 1], [0, 9], [1, 63]]) {
    const tables = [...Array.from({ length: won }, nearly), ...Array.from({ length: lost }, stuck)];
    let looks = 0;
    const search = spider.search;
    spider.search = (...a) => { looks++; return search(...a); };
    let r;
    try { r = await backTo(tables); } finally { spider.search = search; }
    assert.deepEqual(r, won ? { at: won - 1 } : { none: true }, `${won} tables it can be won from, then ${lost} it can't`);
    assert.ok(looks <= Math.ceil(Math.log2(tables.length)), `${looks} looks for ${tables.length} tables`);
    if (won) {
      const h = await hintFor(tables[won - 1]);
      assert.deepEqual(h, { move: { from: 't1', n: 7, to: 't0' } }, 'Hint shows the way on from there');
    }
  }
  const asked = { n: 0 };
  assert.deepEqual(await backTo([nearly(), stuck(), stuck()], {}, { stale: () => ++asked.n > 0 }), { stale: true });
});

test('Spider is out of moves when it takes a long look to be sure nothing helps', () => {
  // One suit, deal 68,977 played at random until nothing is left to deal: about a thousand tables can be reached by
  // moving cards about, and none of them turns a card over, clears a run or empties a column.
  const s = {"v":"s1","deal":68977,"tab":[{"down":[369,371,114,322,372],"up":[113,315,8,111,318]},{"down":[63,211,264,376],"up":[212,12,108,3,54,105]},{"down":[161,367,156,316,216],"up":[56,165,319,263,210]},{"down":[374,10,219,266],"up":[6,373,366,157,62,268,215,214,109,160,107,106,209,52]},{"down":[321,53,1,116],"up":[272]},{"down":[2,9,0,5],"up":[115,60,370]},{"down":[168,317,269],"up":[164]},{"down":[163,4,166,167],"up":[7,265,112,57,208,262,365]},{"down":[220,375,159,61],"up":[58,312,64,323,270]},{"down":[11,267,110],"up":[260,158,261,104]}],"stock":[],"sets":[[364,313,314,55,368,213,162,59,320,217,218,271,324]],"moves":106};
  assert.equal(new Set([...s.tab.flatMap(t => [...t.down, ...t.up]), ...s.sets.flat()]).size, 104, 'every card once');
  const look = spider.deadEnd(s);
  assert.equal(look.run(400), 'unknown', 'a short look can’t tell');
  assert.ok(look.todo.length > 1 && look.todo.every(t => typeof t === 'string'), 'the tables it has still to look from are kept small');
  assert.equal(spider.outOfMoves(s), true);
  assert.equal(spider.deadEnd(s).none, false);
});

test('a Spider look that runs out straight after a move carries on further while the table is left, and can then be sure', async () => {
  // Two suits, deal 737,673 played greedily for 10 moves: nothing can ever help, but it takes 88,675 tables to be sure,
  // more than the look straight after a move gets. Carried on to the longer limit, the same look finds out.
  const s = {"v":"s2","deal":737673,"tab":[{"down":[172,70,110,20,125],"up":[128,68,123,121,112,166]},{"down":[161,111,6,2,126],"up":[5,115,65,113,116,180]},{"down":[75,159,60,171,74],"up":[25,24,63,158,10,163,176]},{"down":[179,7,170,64,4],"up":[107,54,117,8,178,73]},{"down":[162,56,23],"up":[15,53,59,109,160,57,108]},{"down":[61,66,18,181],"up":[174,119,118,13,17,62,127,58]},{"down":[169],"up":[122,175,77,165,167]},{"down":[71,164,173,52],"up":[1,0,120,19,14,156,104]},{"down":[177,21,11,129],"up":[124,3,67,22,12,157,168]},{"down":[55,105,16],"up":[72,9,69,114,76,106]}],"stock":[],"sets":[],"moves":10};
  assert.equal(new Set([...s.tab.flatMap(t => [...t.down, ...t.up])]).size, 104, 'every card once');
  const first = await deadEnd(s);
  assert.equal(first.result, null, 'the look straight after a move can’t tell');
  assert.ok(first.nodes >= spider.budget.dead && first.nodes < spider.budget.dead + 100);
  const more = await deadEnd(s, {}, { max: spider.budget.idle, look: first });
  assert.equal(more, first, 'the same look, carried on');
  assert.equal(more.result, 'dead');
  assert.equal(more.none, false, 'the cards can still move about');
  // And it stops as soon as the table changes.
  let asked = 0;
  const gone = await deadEnd(s, {}, { max: spider.budget.idle, stale: () => ++asked > 2 });
  assert.equal(gone.result, null);
  assert.ok(gone.nodes < spider.budget.dead, `looked at ${gone.nodes} tables after it was no longer wanted`);
});

test('a Spider run moved onto a card of the other suit counts when it uncovers cards that can go somewhere', () => {
  // The spade 7 can only go onto the other heart 8; then hearts 10 to 8 go onto the jack and turn a card over.
  const s = spiderEnd('s2', [3, 2], [
    [[sp(2)], [ht(10), ht(9), ht(8), sp(7)]],
    [[sp(4), sp(5), sp(6)], [ht(8)]],
    [[sp(8), sp(9), sp(10)], [sp(11)]],
    [[sp(12), ht(1), ht(2)], [sp(13)]],
    [[ht(2), ht(3), ht(3)], [ht(13)]],
    [[ht(4), ht(4), ht(5)], [ht(13)]],
    [[ht(6), ht(6), ht(7)], [ht(1)]],
    [[ht(7), ht(9), ht(10)], [sp(1)]],
    [[ht(11), ht(11)], [ht(5)]],
    [[ht(12), ht(12)], [sp(3)]],
  ]);
  assert.equal(spider.outOfMoves(s), false);
  const t = spider.move(spider.move(s, 't0', 1, 't1'), 't0', 3, 't2');
  assert.deepEqual([t.tab[0].down.length, t.tab[0].up.map(name)], [0, ['2S']], 'the card underneath turned over');
});

test('Hint on a won Spider table has nothing to suggest, rather than failing', async () => {
  // The page never asks there, but the solver calls it won with no moves to make, and Spider has no easy hints.
  const s = { v: 's1', deal: 1, moves: 300, tab: Array.from({ length: 10 }, () => ({ down: [], up: [] })), stock: [],
    sets: Array.from({ length: 8 }, (_, k) => Array.from({ length: 13 }, (_, r) => k * 52 + r)) };
  assert.ok(spider.won(s));
  assert.deepEqual(await hintFor(s), { none: true });
});

test('the deals checked in advance really are won by the solver', () => {
  // Every Klondike and FreeCell deal listed, and a spread of the Spider ones, which take longer to check (all 60 or so
  // seconds of them: node dev/ready-deals.mjs --check).
  const every = { k1: 1, k3: 1, fc: 1, s1: 5, s2: 5, s4: 36 };
  for (const [v, list] of Object.entries(READY_DEALS)) {
    const game = VARIANTS[v].game;
    for (const n of list.filter((_, i) => i % every[v] === 0)) assert.equal(game.search(game.deal(n, v)).run(game.budget.deal), 'won', `${v} deal ${n}`);
  }
});

test('Hint gets at least as long as a deal was checked for, so its first press on a new deal knows the way', () => {
  for (const [v, { game }] of Object.entries(VARIANTS)) assert.ok(game.budget.hint >= game.budget.deal, v);
});

// ---- Hint ----

// Press Hint and do what it says, with the page's own after-move steps in between (cards going up by themselves if
// `auto`, and finishing by itself), until the game is won. Hint must never lead back to a table it has been at, and in
// Klondike, every time it says to draw, it names the card it's drawing for, and that's the card that turns up.
// `switchOnAt`: switch cards going up by themselves on before that press, as the page does (what can go up, goes).
// Returns how many times Hint searched.
async function followHint(v, n, { auto = true, cap = 600, switchOnAt = -1 } = {}) {
  const game = VARIANTS[v].game, search = game.search;
  let searches = 0;
  game.search = (...args) => { searches++; return search(...args); };
  try {
    const settle = s => { for (let st; auto && !game.won(s) && !game.finishable(s) && (st = game.autoStep(s));) s = game.move(s, st.from, st.n, st.to); return s; };
    const where = s => JSON.stringify(s, (k, x) => (k === 'moves' || k === 'fan' ? undefined : x));
    const seen = new Set();
    let s = settle(game.deal(n, v)), drawingFor = null;
    for (let i = 0; i < cap && !game.won(s); i++) {
      if (i === switchOnAt) { auto = true; s = settle(s); drawingFor = null; }
      while (game.finishable(s)) { const st = game.finishStep(s); s = st.stock ? game.stock(s) : game.move(s, st.from, st.n, st.to); }
      if (game.won(s)) break;
      assert.ok(!seen.has(where(s)), `${v} deal ${n}: after ${i} hints, Hint led back to a table it had been at`);
      seen.add(where(s));
      const h = await hintFor(s, { auto });
      assert.ok(h.move, `${v} deal ${n}: after ${i} hints, Hint said ${JSON.stringify(h)}`);
      if (v[0] === 'k' && h.move.stock) {
        assert.ok(h.move.c !== undefined, `${v} deal ${n}: after ${i} hints, Hint drew without saying for which card`);
        assert.equal(h.move.c, drawingFor ?? h.move.c, `${v} deal ${n}: after ${i} hints, Hint drew for another card before the ${name(drawingFor)} turned up`);
        drawingFor = h.move.c;
      } else if (drawingFor !== null) {
        assert.equal(s.waste.at(-1), drawingFor, `${v} deal ${n}: after ${i} hints, Hint drew for ${name(drawingFor)} but another card turned up`);
        drawingFor = null;
      }
      const next = h.move.stock ? game.stock(s) : game.move(s, h.move.from, h.move.n, h.move.to);
      assert.ok(next, `${v} deal ${n}: Hint's move ${JSON.stringify(h.move)} isn't allowed`);
      s = settle(next);
      if (drawingFor !== null && s.found.some(f => f.includes(drawingFor))) drawingFor = null; // it went up by itself
    }
    assert.ok(game.won(s), `${v} deal ${n} not won after ${cap} hints`);
  } finally {
    game.search = search;
  }
  return searches;
}

test('following Hint from a dealt deal wins, and Hint never goes round in circles', async () => {
  // Each of these Klondike deals once had Hint taking a card up to its foundation and straight back down, or moving
  // a card from one column to another and back, or saying there was no way to win.
  await followHint('k1', 338766);
  await followHint('k1', 438268);
  await followHint('k1', 2051);
  await followHint('k3', 2003);
  await followHint('k3', 2018);
  await followHint('k3', 2003, { auto: false });
  // Drawing three with cards going up by themselves off, Hint's search on this deal ran out of time on every press and
  // guessed, and its eighth guess made the game unwinnable.
  await followHint('k3', 70001, { auto: false });
  await followHint('fc', 617);
  await followHint('s1', 3);
});

test('while you do what Hint says, it keeps to the way it found instead of searching again', async () => {
  // Four-suit deal 35, from the list checked in advance, takes the solver about 100,000 positions.
  for (const [v, n, auto] of [['k1', 2011, true], ['k3', 2096, true], ['k3', 2018, false], ['fc', 1003, false], ['s2', 1001, true], ['s4', 35, true]]) {
    assert.equal(await followHint(v, n, { auto }), 1, `${v} deal ${n}`);
  }
});

test('asking Hint off the way and coming back by Undo, Hint gives the same move without searching again', async () => {
  // Follow Hint a few moves, make another move instead, ask Hint there (a new search), undo, and ask again.
  for (const [v, n] of [['k1', 2011], ['k3', 2096], ['s2', 1001]]) {
    const game = VARIANTS[v].game, search = game.search;
    let searches = 0;
    game.search = (...args) => { searches++; return search(...args); };
    try {
      const settle = s => { for (let st; !game.won(s) && !game.finishable(s) && (st = game.autoStep(s));) s = game.move(s, st.from, st.n, st.to); return s; };
      const play = (s, m) => settle(m.stock ? game.stock(s) : game.move(s, m.from, m.n, m.to));
      let s = settle(game.deal(n, v));
      for (let i = 0; i < 4; i++) s = play(s, (await hintFor(s)).move);
      let came = 0;
      for (let press = 0; press < 60 && came < 3 && !game.won(s); press++) {
        const h = await hintFor(s), before = searches;
        // Another move: a tap on the deck or a card, the first that takes Hint off its way (there may be none here).
        const { top, tableau } = game.layout(s);
        const piles = [...top.filter(p => p.kind === 'waste').map(p => p.id), ...tableau];
        const others = [{ stock: true }, ...piles.map(id => (game.pile(s, id).up.length ? { from: id, n: 1, to: game.tapTarget(s, id, 1) } : null))]
          .filter(m => m && (m.stock || m.to) && !(m.stock && h.move.stock) && JSON.stringify(m) !== JSON.stringify(h.move));
        for (const m of others) {
          const t = m.stock ? game.stock(s) : game.move(s, m.from, m.n, m.to);
          if (!t) continue;
          await hintFor(settle(t));
          if (searches === before) continue; // that table was on the way too
          const again = await hintFor(s); // back by Undo
          assert.deepEqual(again, h, `${v} deal ${n}: a different hint after coming back`);
          assert.equal(searches, before + 1, `${v} deal ${n}: Hint searched again after coming back`);
          came++;
          break;
        }
        s = play(s, h.move);
      }
      assert.equal(came, 3, `${v} deal ${n}: Hint wasn't taken off its way three times`);
    } finally {
      game.search = search;
    }
  }
});

// Deal 13,105 of two-suit Spider, 142 moves in, reached by a player who strayed from Hint and came back. Six runs
// cleared, one row left to deal and five columns empty: the row can only be dealt once the sixteen cards left are
// spread over all ten columns, which means splitting a run. Hint once lit the 8 of spades onto the 9 of hearts, then
// back onto the 9 of spades, for ever.
// 9S | - | 5S 4S 3S | - | KS QS JS | - | 4H 3H 2H | - | - | KH QH JH TH 9H 8S; stock 7S AS 2S AH 6S TS 7H 8H 6H 5H
const lastRow = () => ({"v":"s2","deal":13105,"tab":[{"down":[],"up":[8]},{"down":[],"up":[]},{"down":[],"up":[56,3,2]},{"down":[],"up":[]},{"down":[],"up":[64,167,114]},{"down":[],"up":[]},{"down":[],"up":[16,171,118]},{"down":[],"up":[]},{"down":[],"up":[]},{"down":[],"up":[25,180,179,126,73,163]}],"stock":[6,156,1,65,161,165,175,72,122,17],"sets":[[169,14,119,68,121,70,19,176,125,22,75,128,129],[0,105,158,55,4,5,58,59,60,113,62,115,168],[13,66,15,120,69,174,123,20,21,178,23,76,77],[117,170,67,172,173,18,71,124,177,74,127,24,181],[52,53,106,107,108,109,162,7,112,9,10,63,12],[104,157,54,159,160,57,110,111,164,61,166,11,116]],"moves":142});
const table = t => JSON.stringify(t, (k, x) => (k === 'moves' ? undefined : x));

test('Spider: Hint finds the way when the last row waits for every column to have a card', async () => {
  let s = lastRow();
  assert.equal(new Set([...s.tab.flatMap(t => t.up), ...s.stock, ...s.sets.flat()]).size, 104, 'every card once');
  const seen = new Set();
  for (let k = 0; k < 300 && !spider.won(s); k++) {
    assert.ok(!seen.has(table(s)), `Hint led back to a table it had shown, press ${k + 1}`);
    seen.add(table(s));
    const h = await hintFor(s);
    assert.ok(h.move, `Hint said ${JSON.stringify(h)} at press ${k + 1}`);
    s = h.move.stock ? spider.stock(s) : spider.move(s, h.move.from, h.move.n, h.move.to);
    assert.ok(s, 'the table took the move');
  }
  assert.ok(spider.won(s));
});

test('with no time to find a way through, Hint suggests the move that looked best, but never one leading back', async () => {
  // Searching only 50 positions, every press ends in the move that looked best. A new search from each table can find
  // a different move looking best, and from this table two of them once took a card back and forth. (Asked with the
  // setting for cards going up by themselves off, which Spider doesn't use, so the way the test above found isn't kept to.)
  const { hint, all } = spider.budget;
  Object.assign(spider.budget, { hint: 50, all: 50 });
  try {
    let s = lastRow();
    const seen = new Set();
    for (let k = 0; k < 60 && !spider.won(s); k++) {
      assert.ok(!seen.has(table(s)), `Hint led back to a table it had shown, press ${k + 1}`);
      seen.add(table(s));
      const h = await hintFor(s, { auto: false });
      if (h.lost) break; // every move led back
      assert.ok(h.move, `Hint said ${JSON.stringify(h)} at press ${k + 1}`);
      s = h.move.stock ? spider.stock(s) : spider.move(s, h.move.from, h.move.n, h.move.to);
    }
  } finally {
    Object.assign(spider.budget, { hint, all });
  }
});

test('a Hint search that is no longer wanted stops straight away', async () => {
  // Four-suit deal 9: the search runs to its limit here without finding a way, which takes seconds. The player moves on
  // after it has looked three times, and the next press (on another table) shouldn't wait behind it.
  const s = spider.deal(9, 's4');
  let asked = 0;
  const t0 = performance.now();
  const h = await hintFor(s, { auto: true }, { stale: () => ++asked > 3 });
  assert.ok(performance.now() - t0 < 200, `took ${Math.round(performance.now() - t0)} ms`);
  assert.equal(h.move, undefined, 'no move for a table that has gone');
  assert.ok(h.stale);
});

test('on a deal just checked, Hint starts from the way through found then, without searching again', async () => {
  // Deals the test above follows with one search, so they're known to be won by the first search's way. The deal is
  // kept ready in the save, with its way, and the page closed and opened again before it's dealt. With cards going up
  // by themselves off, the way (found with them on) is followed with those cards sent up by hand.
  for (const [v, deal, auto] of [['k3', 2096, true], ['k3', 2096, false], ['fc', 1003, true], ['fc', 1003, false], ['s2', 1001, true]]) {
    const game = VARIANTS[v].game, search = game.search, randomDeal = game.randomDeal;
    const dealer = new Dealer({});
    game.randomDeal = () => deal;
    const n = await dealer.find(v);
    game.randomDeal = randomDeal;
    dealer.ready[v] = n;
    const opened = new Dealer(JSON.parse(JSON.stringify(dealer.kept())));
    assert.deepEqual(opened.ready, { [v]: n }, 'the deal kept ready');
    let searches = 0;
    game.search = (...args) => { searches++; return search(...args); };
    try {
      primeLine(game.deal(n, v), opened.pathFor(v, n), auto);
      assert.equal(opened.pathFor(v, n), undefined, 'the way is handed over once');
      const settle = s => { for (let st; auto && !game.won(s) && !game.finishable(s) && (st = game.autoStep(s));) s = game.move(s, st.from, st.n, st.to); return s; };
      let s = settle(game.deal(n, v));
      for (let i = 0; i < 1000 && !game.won(s) && !game.finishable(s); i++) {
        const h = await hintFor(s, { auto });
        assert.ok(h.move, `${v} deal ${n}: Hint said ${JSON.stringify(h)}`);
        s = settle(h.move.stock ? game.stock(s) : game.move(s, h.move.from, h.move.n, h.move.to));
      }
      assert.ok(game.won(s) || game.finishable(s), `${v} deal ${n} not won`);
      assert.equal(searches, 0, `${v} deal ${n}, cards going up by themselves ${auto ? 'on' : 'off'}: Hint searched`);
    } finally {
      game.search = search;
    }
  }
});

test('Hint keeps to the way it found only with the setting it found it with', async () => {
  // Drawing three, deal 7016, following Hint with cards going up by themselves off and switching them on after 22
  // presses. Kept to after that, the way found with the setting off ended in "no way to win" 27 presses later.
  // Hint looks again instead, and that way wins.
  assert.equal(await followHint('k3', 7016, { auto: false, switchOnAt: 22 }), 2);
});


// ---- Pyramid ----

// A Pyramid table: the pyramid's places row by row (null for gone), the deck from its top card, and the rest.
const pyr = (places, { deck = [], drawn = [], waste = [], pass = 1 } = {}) => ({
  v: 'py', deal: 0, pyr: places, stock: deck.slice().reverse(), drawn, waste, out: [], pass, moves: 0,
});
// The pyramid with only its bottom row's last two places and the one above them left (place 20 rests on 26 and 27).
const lastThree = (a, b, c) => pyr(Array.from({ length: 28 }, (_, p) => (p === 20 ? a : p === 26 ? b : p === 27 ? c : null)));

test('Pyramid deals 28 cards in seven rows and leaves 24 in the deck, the same for the same number', () => {
  const s = pyramid.deal(42);
  assert.equal(s.pyr.length, 28);
  assert.equal(s.stock.length, 24);
  assert.equal(new Set([...s.pyr, ...s.stock]).size, 52);
  assert.deepEqual(pyramid.deal(42), s);
  assert.notDeepEqual(pyramid.deal(43).pyr, s.pyr);
  assert.deepEqual(pyramid.layout(s, false).places.slice(0, 3).map(p => [p.col, p.row]), [[3, 0], [2.5, 1], [3.5, 1]], 'each row half a card further out');
  assert.deepEqual(pyramid.layout(s, false).places[0].under, ['p1', 'p2']);
});

test('Pyramid takes away pairs adding up to 13 and kings on their own, and only cards with nothing on them', () => {
  const s = lastThree(card(H, 12), card(S, 1), card(C, 13)); // queen of hearts resting on the ace of spades and king of clubs
  assert.equal(pyramid.lift(s, 'p20', 0), null, 'the queen is covered');
  assert.equal(pyramid.move(s, 'p26', 1, 'p20'), null, 'so the ace can’t pair with it');
  assert.equal(pyramid.tapTarget(s, 'p27', 1), 'out', 'a tap takes a king away');
  assert.equal(pyramid.tapTarget(s, 'p26', 1), null, 'an ace waits for its pair');
  assert.equal(pyramid.move(s, 'p26', 1, 'out'), null, 'only a king goes on its own');
  const t = pyramid.move(s, 'p27', 1, 'out');
  assert.deepEqual([t.pyr[27], t.out], [null, [card(C, 13)]]);
  assert.equal(pyramid.lift(t, 'p20', 0), null);
  const u = { ...t, pyr: t.pyr.map((c, p) => (p === 26 ? card(D, 2) : c)) };
  assert.equal(pyramid.canDrop(u, [card(D, 2)], 'p20'), false, 'a queen and a 2 make 14');
  assert.match(pyramid.dropNote(u, [card(D, 2)], 'p20'), /add up to 13/);
  const w = pyramid.move(t, 'p26', 1, 'p20');
  assert.equal(w, null, 'the queen is still under the ace');
  // The ace from the waste onto the queen, with nothing on her any more.
  const v = { ...t, pyr: t.pyr.map((c, p) => (p === 26 ? null : c)), waste: [card(S, 1)] };
  const x = pyramid.move(v, 'waste', 1, 'p20');
  assert.ok(pyramid.won(x), 'the pyramid is clear');
  assert.deepEqual(x.waste, []);
  assert.deepEqual(new Set(x.out), new Set([card(C, 13), card(H, 12), card(S, 1)]));
});

test('Pyramid turns up a card at a tap, the last one going to the waste, and goes through the deck three times', () => {
  const s = lastThree(card(H, 5), card(S, 9), card(C, 9));
  s.stock = [card(D, 8), card(D, 4)]; // the 4 of diamonds on top
  const a = pyramid.stock(s);
  assert.deepEqual([a.drawn, a.waste, pyramid.turned(a)], [[card(D, 4)], [], card(D, 4)]);
  const b = pyramid.stock(a);
  assert.deepEqual([b.drawn, b.waste], [[card(D, 8)], [card(D, 4)]], 'the 4 goes to the waste, where it can still pair');
  assert.equal(pyramid.canDrop(b, [card(D, 8)], 'waste'), false, '8 and 4 make 12');
  assert.ok(pyramid.canDrop(b, [card(S, 9)], 'waste'), 'a 9 from the pyramid pairs with the 4 on the waste');
  let t = b;
  for (const pass of [2, 3]) {
    t = pyramid.stock(t);
    assert.deepEqual([t.pass, t.stock, t.drawn, t.waste, pyramid.passes(t)], [pass, [card(D, 8), card(D, 4)], [], [], 3 - pass], `turned over for time ${pass}`);
    t = pyramid.stock(pyramid.stock(t));
  }
  assert.equal(pyramid.stock(t), null, 'not a fourth time');
  assert.match(pyramid.stockNote(t).text, /third time through the deck, the last/);
  assert.equal(pyramid.stockNote(b), null);
});

test('the Pyramid solver’s wins are real wins on the table, and it knows a deal whose 10 has every 3 resting on it can’t be won', () => {
  for (const n of [1, 5, 6, 12, 27, 35]) {
    let s = pyramid.deal(n);
    const search = pyramid.search(s);
    assert.equal(search.run(pyramid.budget.deal), 'won', `deal ${n}`);
    for (let i = 0, guard = 0; i < search.path.length; guard++) {
      assert.ok(guard < 500, `deal ${n}: the deck never turned up the card the line wanted`);
      const m = pyramid.fromSolver(s, search.path[i]);
      s = m.stock ? pyramid.stock(s) : pyramid.move(s, m.from, m.n, m.to);
      assert.ok(s, `deal ${n}: move ${i} isn't allowed`);
      if (!m.stock) i++;
    }
    assert.ok(pyramid.won(s), `deal ${n} not won`);
  }
  // Deal 19: the 10 of clubs at the top, and every 3 below it in the pyramid, so none can ever pair with it.
  const s = pyramid.deal(19);
  assert.equal(rankOf(s.pyr[0]), 10);
  assert.deepEqual(s.pyr.filter(c => rankOf(c) === 3).length, 4);
  assert.equal(pyramid.search(s).run(1000), 'lost');
  // Without that shortcut, the search agrees, looking everywhere, on a deal small enough to look everywhere.
  const full = new PyramidSearch(pyramidPosition(pyramid.deal(58)));
  full.prune = false;
  assert.equal(full.run(400000), 'lost');
  assert.equal(pyramid.search(pyramid.deal(58)).run(400000), 'lost');
});

test('Pyramid is out of moves once no line of moves takes a card from the pyramid', () => {
  // A queen covered by two 5s, and the deck's last card a 7 on its last time through: the 7 can't pair with a 5.
  const s = lastThree(card(H, 12), card(S, 5), card(C, 5));
  s.drawn = [card(D, 7)];
  s.pass = 3;
  assert.equal(pyramid.outOfMoves(s), true);
  assert.equal(pyramid.deadEnd(s).none, true, 'there’s no move at all');
  assert.equal(pyramid.search(s).run(1000), 'lost');
  // With an 8 to come in the deck, it can pair with a 5.
  const t = { ...s, stock: [card(D, 8)] };
  assert.equal(pyramid.outOfMoves(t), false);
  // With the deck to turn over again, the 7 comes round, but still pairs with nothing that helps.
  const u = { ...s, pass: 2 };
  assert.equal(pyramid.outOfMoves(u), true);
  assert.equal(pyramid.deadEnd(u).none, false, 'the deck can still be turned over, just to no end');
});
