// The rules and the solver, checked in Node:  node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { card, safeUp, stacks, fits, suitOf } from '../js/cards.js';
import { deal, draw, move, canDrop, bestTarget, autoStep, won, finishable, finishStep, forSolver, fromSolver, easyHint, foundationFor, foundCounts, outOfMoves, deadEnd, TABLEAU, FOUNDATIONS } from '../js/games/klondike.js';
import { solve, Search } from '../js/solvers/klondike.js';
import { hintFor, Dealer } from '../js/deals.js';
import { READY_DEALS } from '../js/games/ready-deals.js';
import { VARIANTS } from '../js/games/index.js';

const S = 0, H = 1, C = 2, D = 3;
const top = a => a[a.length - 1];
const empty = (drawCount = 1) => ({ deal: 0, draw: drawCount, stock: [], waste: [], fan: 0, found: [[], [], [], []], tab: Array.from({ length: 7 }, () => ({ down: [], up: [] })), moves: 0 });

test('a deal has every card once, laid out one to seven', () => {
  const s = deal(42, 1);
  const all = [...s.stock, ...s.tab.flatMap(t => [...t.down, ...t.up])];
  assert.equal(new Set(all).size, 52);
  s.tab.forEach((t, i) => { assert.equal(t.down.length, i); assert.equal(t.up.length, 1); });
  assert.equal(s.stock.length, 24);
  assert.deepEqual(deal(42, 1), s, 'the same number deals the same cards');
  assert.notDeepEqual(deal(43, 1).stock, s.stock);
});

test('columns build down in alternating colours; only kings go in an empty column', () => {
  const s = empty();
  s.tab[0].up = [card(S, 8)];
  assert.ok(canDrop(s, [card(H, 7)], 't0'));
  assert.ok(!canDrop(s, [card(C, 7)], 't0'), 'same colour');
  assert.ok(!canDrop(s, [card(H, 6)], 't0'), 'skips a rank');
  assert.ok(canDrop(s, [card(D, 13)], 't1'));
  assert.ok(!canDrop(s, [card(D, 12)], 't1'));
  assert.ok(stacks(card(D, 4), card(C, 5)));
});

test('foundations start with an ace and follow suit', () => {
  const s = empty();
  assert.ok(canDrop(s, [card(H, 1)], 'f2'));
  assert.ok(!canDrop(s, [card(H, 2)], 'f2'));
  s.found[2] = [card(H, 1)];
  assert.ok(canDrop(s, [card(H, 2)], 'f2'));
  assert.ok(!canDrop(s, [card(D, 2)], 'f2'));
  assert.ok(!canDrop(s, [card(H, 2), card(S, 1)], 'f2'), 'one card at a time');
  assert.equal(move(s, 'f2', 1, 'f0'), null, 'an ace on a foundation stays there: a card comes back down only to a column');
});

test('moving a run turns over the card underneath', () => {
  const s = empty();
  s.tab[0] = { down: [card(C, 2)], up: [card(S, 9), card(H, 8)] };
  s.tab[1] = { down: [], up: [card(D, 10)] };
  const next = move(s, 't0', 2, 't1');
  assert.deepEqual(next.tab[1].up, [card(D, 10), card(S, 9), card(H, 8)]);
  assert.deepEqual(next.tab[0], { down: [], up: [card(C, 2)] });
  assert.equal(next.moves, 1);
  assert.equal(move(s, 't0', 1, 't1'), null, 'the 8 of hearts does not go on the 10');
  assert.deepEqual(s.tab[0].up, [card(S, 9), card(H, 8)], 'the old state is left alone');
});

test('drawing one or three, then turning the waste back over', () => {
  let s = deal(7, 3);
  const before = s.stock.slice();
  s = draw(s);
  assert.deepEqual(s.waste, before.slice(-3).reverse());
  assert.equal(s.fan, 3);
  s = move(s, 'waste', 1, 't0') || { ...s, waste: s.waste.slice(0, -1), fan: 2 };
  while (s.stock.length) s = draw(s);
  const waste = s.waste.slice();
  s = draw(s);
  assert.equal(s.waste.length, 0);
  assert.deepEqual(s.stock, waste.reverse(), 'same order as before');
  assert.equal(draw({ ...empty(), stock: [], waste: [] }), null);
});

test('a tap sends a card up first, then onto a column, never a lone king to another empty column', () => {
  const s = empty();
  s.tab[0].up = [card(S, 1)];
  assert.equal(bestTarget(s, 't0', 1), 'f0');
  s.tab[0].up = [card(S, 13)];
  assert.equal(bestTarget(s, 't0', 1), null);
  s.tab[0] = { down: [card(H, 3)], up: [card(S, 13)] };
  assert.equal(bestTarget(s, 't0', 1), 't1');
  s.tab[2].up = [card(D, 8)];
  s.waste = [card(C, 7)];
  assert.equal(bestTarget(s, 'waste', 1), 't2');
  s.found[0] = [card(H, 1)];
  s.tab[4].up = [card(S, 2)];
  assert.equal(bestTarget(s, 'f0', 1), null, 'a card already up stays up when tapped');
});

test('cards only go up by themselves once nothing could need them', () => {
  const counts = [2, 2, 0, 0];
  assert.ok(safeUp(card(S, 3), [2, 2, 2, 2]));
  assert.ok(!safeUp(card(S, 3), counts), 'a red 2 might still want to sit on it');
  assert.ok(safeUp(card(D, 1), counts));
  assert.ok(safeUp(card(D, 2), [0, 0, 0, 1]));
  const s = empty();
  s.tab[3].up = [card(C, 1)];
  assert.deepEqual(autoStep(s), { from: 't3', n: 1, to: 'f0' });
});

test('with every card face up, the rest plays itself', () => {
  const s = empty();
  for (let suit = 0; suit < 4; suit++) s.found[suit] = Array.from({ length: 11 }, (_, i) => card(suit, i + 1));
  s.tab[0].up = [card(S, 13), card(H, 12)];
  s.tab[1].up = [card(H, 13), card(S, 12)];
  s.tab[2].up = [card(C, 13), card(D, 12)];
  s.tab[3].up = [card(D, 13), card(C, 12)];
  assert.ok(finishable(s));
  let t = s;
  for (let i = 0; i < 8; i++) { const m = finishStep(t); t = move(t, m.from, m.n, m.to); }
  assert.ok(won(t));
});

test('drawing one, the rest plays itself once every card in the columns is face up, drawing from the deck as it goes', () => {
  const s = empty(1);
  for (let suit = 0; suit < 4; suit++) s.found[suit] = Array.from({ length: 6 }, (_, i) => card(suit, i + 1));
  s.tab[0].up = [card(S, 13), card(H, 12), card(S, 11)];
  s.tab[1].up = [card(H, 13), card(S, 12), card(H, 11)];
  const rest = [];
  for (let r = 7; r <= 13; r++) for (const suit of [S, H, C, D]) if (r < 11 || suit === C || suit === D) rest.push(card(suit, r));
  rest.sort((a, b) => ((a * 7919) % 53) - ((b * 7919) % 53)); // a muddle, the 7s nowhere near the top
  s.waste = rest.slice(0, 5);
  s.stock = rest.slice(5);
  assert.ok(finishable(s), 'with cards in the deck and the waste');
  assert.equal(finishable({ ...s, draw: 3 }), false, 'drawing three it waits for the deck to be used up');
  assert.equal(finishable({ ...s, tab: s.tab.map((t, i) => (i === 0 ? { down: [t.up[0]], up: t.up.slice(1) } : t)) }), false, 'not with a card face down');
  let t = s, draws = 0;
  for (let i = 0; i < 2000 && !won(t); i++) {
    const m = finishStep(t);
    if (m.stock) draws++;
    t = m.stock ? draw(t) : move(t, m.from, m.n, m.to);
    assert.ok(t, `step ${i + 1} was refused`);
  }
  assert.ok(won(t));
  assert.ok(draws > 0, 'drawing on the way');
});

// Play a solver's winning line through the table's own rules.
function replay(s, path) {
  for (const m of path) {
    if (m.k === 2 || m.k === 3) {
      let guard = 0;
      while (top(s.waste) !== m.c) { s = draw(s); assert.ok(s && ++guard < 200, 'the card never came up'); }
      s = move(s, 'waste', 1, m.k === 2 ? foundationFor(s, m.c) : TABLEAU[m.b]);
    } else if (m.k === 0) s = move(s, TABLEAU[m.a], 1, foundationFor(s, top(s.tab[m.a].up)));
    else if (m.k === 1) s = move(s, TABLEAU[m.a], m.n, TABLEAU[m.b]);
    else { const i = s.found.findIndex(f => f.length && suitOf(f[0]) === m.s); s = move(s, FOUNDATIONS[i], 1, TABLEAU[m.b]); }
    assert.ok(s, 'illegal move ' + JSON.stringify(m));
  }
  for (let guard = 0; guard < 3000 && !won(s); guard++) {
    const counts = foundCounts(s);
    const i = s.tab.findIndex(t => t.up.length && fits(top(t.up), counts));
    if (i >= 0) s = move(s, TABLEAU[i], 1, foundationFor(s, top(s.tab[i].up)));
    else if (s.waste.length && fits(top(s.waste), counts)) s = move(s, 'waste', 1, foundationFor(s, top(s.waste)));
    else s = draw(s);
  }
  return won(s);
}

// The same with "Send cards up by themselves" on, the way the table plays it: after every move and every tap on the deck,
// any card that can go up by itself does. A card the line sends up later is skipped once it's up, and a card it wants
// from the deck is drawn for until it shows, however many cards went up on the way.
function replayAuto(s, path) {
  const settle = t => { for (let st = autoStep(t); st && !won(t); st = autoStep(t)) t = move(t, st.from, st.n, st.to); return t; };
  const isUp = c => s.found.some(f => f.includes(c));
  s = settle(s);
  for (const m of path) {
    if ((m.k === 0 || m.k === 2) && isUp(m.c)) continue;
    if (m.k === 2 || m.k === 3) {
      for (let guard = 0; top(s.waste) !== m.c && !isUp(m.c); guard++) {
        assert.ok(guard < 100, `the ${m.c} never came to the top of the waste`);
        s = settle(draw(s));
      }
      if (isUp(m.c)) { assert.equal(m.k, 2, `the ${m.c} went up by itself, but the line wanted it on a column`); continue; }
      s = move(s, 'waste', 1, m.k === 2 ? foundationFor(s, m.c) : TABLEAU[m.b]);
    } else if (m.k === 0) s = move(s, TABLEAU[m.a], 1, foundationFor(s, top(s.tab[m.a].up)));
    else if (m.k === 1) s = move(s, TABLEAU[m.a], m.n, TABLEAU[m.b]);
    else { const i = s.found.findIndex(f => f.length && suitOf(f[0]) === m.s); s = move(s, FOUNDATIONS[i], 1, TABLEAU[m.b]); }
    assert.ok(s, 'illegal move ' + JSON.stringify(m));
    s = settle(s);
  }
  for (let guard = 0; guard < 3000 && !won(s); guard++) {
    const counts = foundCounts(s);
    const i = s.tab.findIndex(t => t.up.length && fits(top(t.up), counts));
    if (i >= 0) s = move(s, TABLEAU[i], 1, foundationFor(s, top(s.tab[i].up)));
    else if (s.waste.length && fits(top(s.waste), counts)) s = move(s, 'waste', 1, foundationFor(s, top(s.waste)));
    else s = draw(s);
    s = settle(s);
  }
  return won(s);
}

for (const drawCount of [1, 3]) {
  test(`the solver's wins are real wins, with cards going up by themselves or not (draw ${drawCount})`, () => {
    let wins = 0;
    for (let n = 1; n <= 40; n++) {
      const s = deal(n, drawCount);
      const r = solve(forSolver(s), 100000);
      if (r.result !== 'won') continue;
      wins++;
      assert.ok(replay(s, r.path), `deal ${n} did not finish`);
      assert.ok(replayAuto(s, r.path), `deal ${n} did not finish with cards going up by themselves`);
    }
    assert.ok(wins >= 20, `only ${wins} of 40 deals solved`);
  });
}

test('drawing three, a deal that cards going up by themselves would make unwinnable is not dealt', () => {
  // Deal 20: aces and twos that turn up on the waste go up by themselves, which changes which cards later draws turn
  // over, and no way through is left: a search of every table the page can reach with the setting on finds none.
  // Left on the waste for a tap, they leave one.
  const s = deal(20, 3);
  assert.notEqual(solve(forSolver(s), 100000).result, 'won');
  assert.equal(solve(forSolver(s, false), 100000).result, 'won');
});

test('drawing three with cards going up by themselves off, Hint lets a card wait on the waste', async () => {
  // Deal 37024 after 33 hints with the setting off. The ace of spades on the waste would go up by itself with it on,
  // and Hint used to send it up as if it would, which leaves no way through. Drawing past it, for the 8 of hearts, wins.
  const s = {
    v: 'k3', deal: 37024, draw: 3, stock: [5, 47, 20, 11, 50], waste: [12, 44, 17, 46, 45, 28, 21, 16, 42, 27, 4, 33, 18, 0], fan: 3,
    found: [[39, 40], [26], [13, 14], []], moves: 33,
    tab: [[[], [7, 19, 31, 43, 3]], [[], [38]], [[], [51, 37, 23, 9]], [[49], [10, 22, 34]], [[29], [35]], [[24, 6, 41, 30, 32], [2]], [[8, 25, 1, 15], [36, 48]]]
      .map(([down, up]) => ({ down, up })),
  };
  assert.deepEqual(await hintFor(s, { auto: false }), { move: { stock: true, c: card(H, 8) } });
  const r = solve(forSolver(s, false), 300000);
  assert.equal(r.result, 'won');
  assert.ok(replay(s, r.path), 'and that way through really wins');
});

// Cards from names like 'TS' (ten of spades), bottom to top.
const cards = names => names.split(' ').filter(Boolean).map(x => card('SHCD'.indexOf(x.slice(-1)), 'A23456789TJQK'.indexOf(x.slice(0, -1)) + 1));
const upTo = (suit, n) => Array.from({ length: n }, (_, i) => card(suit, i + 1));
const column = (down, up) => ({ down: cards(down), up: cards(up) });

test('a game whose way through needs part of a run moved or a card taken back down is neither lost nor out of moves', async () => {
  // Deal 378865 after 71 moves: nothing is left in the stock, and none of the moves the solver tries first helps, but
  // moving part of a run does. It used to say there were no moves left, and Hint that there was no way to win.
  const s = {
    v: 'k1', deal: 378865, draw: 1, stock: [], waste: cards('JC QC'), fan: 1, moves: 71,
    found: [upTo(C, 7), upTo(D, 2), upTo(H, 2), []],
    tab: [column('', 'QD JS TH 9S 8H 7S 6D 5S 4H 3S'), column('', 'KD QS JD TC 9D 8C 7D 6S 5H'), column('', 'KS'), column('', 'KC'),
      column('3D 6H AS', '5D 4S 3H 2S'), column('4D QH', 'JH TS 9H 8S 7H'), column('KH', 'TD 9C 8D')],
  };
  assert.equal(outOfMoves(s), false);
  const h = await hintFor(s);
  assert.ok(h.move && !h.move.stock, `Hint said ${JSON.stringify(h)}`);
  assert.ok(move(s, h.move.from, h.move.n, h.move.to), 'and the move is one the table allows');
  const all = new Search(forSolver(s), { every: true });
  assert.equal(all.run(5000), 'won');
  assert.ok(replay(s, all.path), 'and that way through really wins');

  // Deal 546070 drawing three, all face up with four empty columns: the way through takes the 10 of spades and the
  // 9 of hearts back down from the foundations.
  const t = {
    v: 'k3', deal: 546070, draw: 3, stock: cards('5C TD KC QH 7C JS'), waste: [], fan: 0, moves: 600,
    found: [upTo(H, 9), upTo(S, 10), upTo(D, 6), upTo(C, 4)],
    tab: [column('', 'KS QD JC TH 9C 8D'), column('', ''), column('', ''), column('', 'KH QC JD'), column('', ''), column('', ''), column('', 'KD QS JH TC 9D 8C 7D 6C')],
  };
  const g = await hintFor(t);
  assert.ok(g.move, `Hint said ${JSON.stringify(g)}`);
});

test('a hint for a card deeper in the stock says to draw, and for which card', () => {
  const s = draw(deal(3, 1));
  const p = forSolver(s);
  assert.deepEqual(fromSolver(s, { k: 3, j: p.pos, b: 0 }), { stock: true, c: p.talon[p.pos] });
  assert.equal(fromSolver(s, { k: 2, j: p.pos - 1 }).from, 'waste');
});

test('with every card face up, Hint draws for the first card that will fit when it turns up', () => {
  // Clubs are up to the 5 and diamonds to the 9. The 6 of clubs is on top of the stock, the 10 of diamonds at the bottom.
  const s = empty(1);
  s.found = [upTo(S, 13), upTo(H, 13), upTo(C, 5), upTo(D, 9)];
  s.stock = cards('TD 9C 8C JD 6C');
  s.tab = ['KC', 'QC', 'JC', 'TC', '7C', 'QD', 'KD'].map(c => column('', c));
  assert.deepEqual(easyHint(s), { stock: true, c: card(C, 6) });
  // Drawing three, the 6 of clubs turns over under the jack of diamonds and the 8 of clubs, and the 10 of diamonds
  // is the first that shows.
  assert.deepEqual(easyHint({ ...s, draw: 3 }), { stock: true, c: card(D, 10) });
});

test('a deal with no moves from the start is out of moves, and the solver calls it lost', () => {
  const s = deal(905, 3); // turning three at a time, nothing in the stock or on the table can move
  assert.equal(outOfMoves(s), true);
  assert.equal(solve(forSolver(s)).result, 'lost');
  assert.equal(outOfMoves(deal(905, 1)), false, 'one at a time, the same cards have moves');
});

test('a dead end is out of moves even with a card that can still go onto a column', () => {
  // Deal 22,124 drawing one, 55 moves in: the 2 of spades is under three face-down cards and the 10 of hearts, and
  // nothing can ever turn them over. The 4 of clubs from the deck can go onto the 5 of hearts, which helps nothing.
  const s = {
    v: 'k1', deal: 22124, draw: 1, fan: 1, moves: 55, stock: [20, 46, 34, 2, 10, 16], waste: [43, 29, 3, 50, 12, 24, 38, 8, 45],
    found: [[13, 14], [26, 27], [0], [39, 40]],
    tab: [[[], [49, 35, 47]], [[11], [6, 44]], [[41], [51]], [[], [32]], [[15, 33, 28], [36]], [[1, 22, 48, 18], [25, 37, 23, 9, 21]], [[42, 30, 5, 4, 7], [19, 31, 17]]]
      .map(([down, up]) => ({ down, up })),
  };
  assert.equal(outOfMoves(s), true);
  assert.equal(solve(forSolver(s)).result, 'lost');
  assert.equal(deadEnd(s).none, false, 'there are moves, just none that helps');
  // With the 2 of spades on the waste and the 7 of diamonds face down in its place, it can go up.
  const t = { ...s, waste: [...s.waste.slice(0, -1), card(S, 2)], tab: s.tab.map((c, i) => (i === 5 ? { down: [card(D, 7), 22, 48, 18], up: c.up } : c)) };
  assert.equal(s.waste.at(-1), card(D, 7));
  assert.equal(outOfMoves(t), false);
});

test('a dead end is out of moves even when a card can come down off a foundation and go straight back up', () => {
  // Deal 663,674 drawing one, 236 moves in. The 2 of diamonds can come down onto the 3 of clubs, but nothing can go on
  // it and it goes straight back up; nothing else can ever turn a card over or put one up.
  const s = {
    v: 'k1', deal: 663674, draw: 1, fan: 0, moves: 236, stock: [45, 31, 21, 51, 22, 9, 48], waste: [],
    found: [[0, 1, 2, 3], [13, 14, 15, 16], [39, 40], []],
    tab: [[[], [38, 50]], [[], [11]], [[7, 12], [34, 20]], [[24, 4], [41, 27]], [[30, 43], [37, 23, 35, 47, 33, 19, 5]], [[6, 29, 25, 36], [8, 46, 32, 18]], [[10, 42, 44, 49, 17, 26], [28]]]
      .map(([down, up]) => ({ down, up })),
  };
  assert.equal(solve(forSolver(s), 1e6).result, 'lost');
  assert.equal(outOfMoves(s), true);
  assert.equal(deadEnd(s).none, false, 'there are moves, just none that helps');
});

test('a king with cards under it can still move to an empty column', () => {
  const s = empty();
  s.found = [11, 11, 11, 11].map((n, suit) => Array.from({ length: n }, (_, i) => card(suit, i + 1)));
  s.tab[0] = { down: [card(S, 12)], up: [card(H, 13)] };
  s.tab[1] = { down: [card(H, 12)], up: [card(S, 13)] };
  s.tab[2] = { down: [card(C, 12)], up: [card(D, 13)] };
  s.tab[3] = { down: [card(D, 12)], up: [card(C, 13)] };
  assert.equal(outOfMoves(s), false);
  assert.equal(solve(forSolver(s)).result, 'won');
});

test('deals from the lists checked in advance come round once each, for every way of playing, kept in the save', async () => {
  // With no checked deal ready, every New game takes one from its way's list. The page closes and opens part way through.
  for (const v of Object.keys(VARIANTS)) {
    const list = READY_DEALS[v];
    assert.ok(list.length >= 40, `${v}: ${list.length} deals listed`);
    assert.equal(new Set(list).size, list.length, `${v}: none listed twice`);
    let dealer = new Dealer({});
    dealer.prepare = () => {}; // no deal found in the background
    const dealt = [];
    for (let i = 0; i < list.length; i++) {
      if (i === 20) { dealer = new Dealer(JSON.parse(JSON.stringify(dealer.kept()))); dealer.prepare = () => {}; }
      dealt.push(await dealer.take(v));
    }
    assert.equal(new Set(dealt).size, list.length, `${v}: none twice`);
    assert.ok(dealt.every(n => list.includes(n)), v);
    const next = await dealer.take(v);
    assert.ok(list.includes(next) && next !== dealt.at(-1), `${v}: then round again, not starting with the last one`);
  }
});

test('a deal from the list comes at once while one is still being found, and the one found is kept for next time', async () => {
  const dealer = new Dealer({});
  let found;
  dealer.find = () => new Promise(resolve => { found = resolve; });
  const first = await dealer.take('k3');
  assert.ok(READY_DEALS.k3.includes(first), 'from the list, without waiting');
  const second = await dealer.take('k3');
  assert.ok(READY_DEALS.k3.includes(second) && second !== first, 'still from the list while the search goes on');
  found(4242);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(await dealer.take('k3'), 4242, 'then the one found');
});

test('a save from before every way had a list still keeps the four-suit order, and anything of the wrong shape is left out', () => {
  const order = READY_DEALS.s4.slice(5, 9);
  assert.deepEqual(new Dealer({ s4list: order }).kept().lists.s4, order);
  const lists = new Dealer({ lists: { k1: [READY_DEALS.k1[0], 7, READY_DEALS.k1[0], 'x'], fc: 'no', s2: null } }).kept().lists;
  assert.deepEqual(lists.k1, [READY_DEALS.k1[0]], 'only listed deals, once each');
  assert.deepEqual(lists.fc, []);
  assert.deepEqual(lists.s2, []);
  for (const bad of [null, 5, 'x', [], { lists: 3 }, { lists: [1, 2] }, { s4list: { a: 1 } }]) assert.doesNotThrow(() => new Dealer(bad).kept(), JSON.stringify(bad));
});

test('the line a screen reader reads after a move says what moved, what turned over and what cleared away', async () => {
  const { moveWords, upWords, hintWords } = await import('../js/words.js');
  const { spider } = await import('../js/games/spider.js');
  const { freecell } = await import('../js/games/freecell.js');
  const { klondike } = await import('../js/games/klondike.js');
  // Spider: the ace of spades onto a run from king to 2 clears it away, and turns over the card under the king.
  const s = spider.deal(1, 's1');
  s.tab[0] = { down: [card(H, 5)], up: Array.from({ length: 12 }, (_, i) => card(S, 13 - i)) };
  s.tab[1] = { down: [], up: [52 + card(S, 1)] };
  const b = spider.move(s, 't1', 1, 't0');
  assert.equal(moveWords(spider, s, b, { from: 't1', n: 1, to: 't0' }), 'Ace of spades onto the 2 of spades. Spades cleared, 1 of 8. Turned over the 5 of hearts.');
  assert.equal(moveWords(spider, s, spider.stock({ ...s, tab: s.tab.map(t => ({ ...t, up: t.up.length ? t.up : [card(S, 9)] })) }), { stock: true }), 'Dealt a row.');
  assert.equal(hintWords(spider, s, { from: 't0', n: 3, to: 't1' }), 'Hint: the 4 of spades and 2 more onto the ace of spades.');
  // FreeCell: a free cell, a foundation, an empty column.
  const f = freecell.deal(617);
  assert.equal(moveWords(freecell, f, freecell.move(f, 't3', 1, 'c0'), { from: 't3', n: 1, to: 'c0' }), '4 of hearts to a free cell.');
  assert.equal(hintWords(freecell, f, { from: 't7', n: 1, to: 't2' }), 'Hint: the queen of hearts onto the king of clubs.');
  // Klondike: drawing one and three, turning the pile back over, a hint to draw.
  const k = klondike.deal(11705, 'k3');
  assert.equal(moveWords(klondike, k, klondike.stock(k), { stock: true }), 'Drew three, with the 5 of clubs on top.');
  const k1 = klondike.deal(11705, 'k1');
  assert.equal(moveWords(klondike, k1, klondike.stock(k1), { stock: true }), 'Drew the ace of hearts.');
  const out = { ...k1, stock: [], waste: k1.stock.slice().reverse() };
  assert.equal(moveWords(klondike, out, klondike.stock(out), { stock: true }), 'Turned the pile back over.');
  assert.equal(hintWords(klondike, k1, { stock: true }), 'Hint: draw a card.');
  assert.equal(upWords([card(H, 1), card(H, 2), card(S, 1)]), 'Up by themselves: the ace and 2 of hearts and the ace of spades.');
});
