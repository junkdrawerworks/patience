// The table: where every card sits, how it moves there, and picking cards up by tap or drag.
// It draws whatever state it's given, for whichever game that is, and reports what the player tried to do;
// app.js decides what happens.

import { SUITS, SUIT_NAMES, RANK_LABELS, suitOf, rankOf, cardName } from './cards.js';
import { gameOf } from './games/index.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const RECYCLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4.5h-4.5"/></svg>';

export class Table {
  // handlers: stock(), tap(pile, n), move(pile, n, to) (a drop, or a tap on the card Hint lit up), touched(deck),
  // refused(why): a drag the rules turned down, { from, cards, to } for cards let go where they can't go, or
  // { from, index } for a card that couldn't be picked up, dragged anyway (a tap on it only shakes it), and
  // held(cards): cards picked up with the keyboard, or put back (none)
  constructor(el, handlers) {
    this.el = el;
    this.on = handlers;
    this.state = null;
    this.left = false;
    this.locked = false;
    this.spots = {};
    this.cards = new Map(); // card -> element
    this.at = new Map();    // card -> where it's drawn: { x, y, z, up, pile, index, deep }
    this.flights = new Map(); // card -> its landing, while it's on its way: { timer, z, deep } (see fly())
    this.drag = null;
    this.cursor = null; // the place the keyboard has chosen, and the cards it holds (see the keyboard, below)
    this.held = null;
    this.dealDuration = 0;
    // With reduced motion asked for, cards go straight to where they're going: no dealing out, no waiting their turn.
    this.calm = matchMedia('(prefers-reduced-motion: reduce)');

    el.addEventListener('pointerdown', e => this.down(e));
    el.addEventListener('pointermove', e => this.moveDrag(e));
    el.addEventListener('pointerup', e => this.up(e));
    el.addEventListener('pointercancel', e => this.up(e, true));
    el.addEventListener('contextmenu', e => e.preventDefault());
    new ResizeObserver(() => {
      if (!this.state) return;
      // A new size starts the card size afresh (see layout()).
      if (this.m && (this.m.W !== el.clientWidth || this.m.H !== el.clientHeight)) this.tall = null;
      this.layout();
      this.render(this.state, { still: true });
    }).observe(el);
  }

  get game() { return gameOf(this.state); }

  // New piles and a new deck when the game changes (two-deck Spider has different cards from one-deck games).
  setup(s) {
    const ids = gameOf(s).cardIds(s);
    const sig = s.v[0] + ':' + ids.join(',');
    if (sig !== this.sig) {
      for (const el of this.cards.values()) el.remove();
      for (const f of this.flights.values()) clearTimeout(f.timer);
      this.flights = new Map();
      this.cards = new Map();
      this.at = new Map();
      for (const c of ids) {
        const el = makeCard(c);
        this.cards.set(c, el);
        this.el.append(el);
      }
      this.sig = sig;
    }
    this.v = s.v;
    this.m = null;
  }

  // Card size and where each pile goes, from the size of the table.
  layout() {
    const s = this.state, L = gameOf(s).layout(s, this.left);
    const W = this.el.clientWidth, H = this.el.clientHeight, cols = L.cols, narrow = cols > 8;
    const pad = clamp(W * 0.02, narrow ? 4 : 6, 18);
    const gap = clamp(W * 0.012, narrow ? 3 : 4, 14);
    const rowGap = clamp(gap * 1.8, 8, 22);
    // On a phone's touch screen the outer columns keep clear of the screen's sides, where Android's back gesture
    // starts: --edge, from the stylesheet, is how far at least.
    const side = Math.max(pad, parseFloat(getComputedStyle(this.el).getPropertyValue('--edge')) || 0);
    // Wide enough for every column, and short enough that a long column still fits below the top row.
    // `rows` is how many card heights that takes: in Klondike, a few face-down cards and eleven face-up ones
    // still showing their corners; Spider's columns run longer.
    // A column longer than that, even with its cards stepped as close as they go (see place()), makes the cards smaller,
    // and smaller cards need a little more of each card showing to read its rank (see stepUp()). But not below 28 px
    // across (about a phone's Spider cards held upright), where they'd be harder to read than a closer column.
    // Once a column has made the cards smaller, they stay that size for the rest of the deal, even when it gets shorter
    // again (`need`, from this.tall: the most rows the deal has needed so far), rather than growing and shrinking back
    // and forth as a column is played down and built up. A new deal, or a new size of table, starts afresh.
    const fit = rows => Math.max(20, Math.floor(Math.min((W - 2 * side - (cols - 1) * gap) / cols, (H - 2 * pad - rowGap) / (1.4 * rows), 124)));
    const usual = fit(L.rows || 4.9), least = Math.min(usual, 28);
    const need = step => this.rowsNeeded(s, L, step);
    let step = stepUp(usual), cw = Math.max(least, fit(need(step)));
    for (let i = 0; i < 4 && stepUp(cw) > step; i++) { step = stepUp(cw); cw = Math.max(least, fit(need(step))); }
    this.tall = { of: dealOf(s), rows: need(step) };
    const ch = Math.round(cw * 1.4);
    const left = Math.round((W - (cols * cw + (cols - 1) * gap)) / 2);
    const x = Array.from({ length: cols }, (_, i) => left + i * (cw + gap));
    const m = { W, H, pad, gap, cw, ch, top: pad, tabY: pad + ch + rowGap, x, spot: {}, kind: {}, dir: {}, order: {}, step, layoutKey: this.layoutKey(s, step) };
    L.top.forEach((p, i) => { m.spot[p.id] = x[p.col]; m.kind[p.id] = p.kind; m.dir[p.id] = p.dir || 1; m.order[p.id] = i; });
    L.tableau.forEach((id, i) => { m.spot[id] = x[i]; m.kind[id] = 'column'; m.order[id] = 100 + i; });
    m.piles = [...L.top.map(p => p.id), ...L.tableau];
    m.dealFrom = L.dealFrom;
    this.m = m;

    // The empty places on the table, one per pile. Each is also the pile to a screen reader (see name()), so they come
    // before the cards, in the order they're laid out: the top row, then the columns from the left.
    for (const id of Object.keys(this.spots)) if (!(id in m.spot)) { this.spots[id].remove(); delete this.spots[id]; }
    for (const p of [...L.top, ...L.tableau.map(id => ({ id, kind: 'column', label: L.empty }))]) {
      let el = this.spots[p.id];
      if (!el) {
        el = document.createElement('div');
        el.className = 'spot';
        el.id = 'pile-' + p.id;
        el.dataset.pile = p.id;
        this.spots[p.id] = el;
      }
      el.dataset.kind = p.kind;
      if (p.kind === 'stock') el.innerHTML = RECYCLE; else el.innerHTML = p.label ? `<span aria-hidden="true">${p.label}</span>` : '';
      el.style.transform = `translate(${m.spot[p.id]}px, ${p.kind === 'column' ? m.tabY : m.top}px)`;
    }
    const spots = m.piles.map(id => this.spots[id]);
    if (spots.some((el, i) => this.el.children[i] !== el)) this.el.prepend(...spots);
    // A faint line in the gap before top-row column L.split, setting its piles apart from the ones before it.
    let split = this.el.querySelector(':scope > .split');
    if (L.split) {
      if (!split) {
        split = document.createElement('div');
        split.className = 'split';
        split.setAttribute('aria-hidden', 'true');
        this.el.append(split);
      }
      split.style.transform = `translate(${x[L.split] - gap / 2}px, ${m.top}px)`;
    } else split?.remove();

    const st = this.el.style;
    st.setProperty('--cw', cw + 'px');
    st.setProperty('--ch', ch + 'px');
    st.setProperty('--r', Math.max(3, Math.round(cw * 0.08)) + 'px');
  }

  // How many card heights tall the table needs to be for this state (see rowsFor()), or for the longest column the deal
  // has had so far at this size of table, if that was longer.
  rowsNeeded(s, L, step) {
    const rows = rowsFor(s, L, step), of = dealOf(s);
    return of && this.tall?.of === of ? Math.max(rows, this.tall.rows) : rows;
  }

  // What the layout depends on, besides the size of the table: `step` is how far apart face-up cards can go at the size
  // the cards are now.
  layoutKey(s, step) { return `${s.v}:${this.left ? 'L' : 'R'}:${this.rowsNeeded(s, gameOf(s).layout(s, this.left), step)}`; }

  // Where every card goes for this state.
  place(s) {
    const m = this.m, game = gameOf(s), at = new Map();
    // Cards deep in a pile can't be seen, so they're hidden: drawn, their edges would add up to a dark outline.
    const deep = (i, n, showing) => i < n - showing;
    const room = m.H - m.pad - m.tabY - m.ch, spread = this.spreadFor(s, room);
    m.piles.forEach((id, pi) => {
      const kind = m.kind[id], { down, up } = game.pile(s, id), x0 = m.spot[id], dir = m.dir[id];
      const z0 = kind === 'column' ? 2000 + pi * 100 : 200 * (pi + 1);
      const put = (c, x, y, z, faceUp, index, isDeep) => at.set(c, { x, y, z, up: faceUp, pile: id, index, deep: isDeep });

      if (kind === 'stock') {
        // As thick as it is: a card's back for every eight cards, up to four, each a pixel or two below the one on top.
        const n = down.length, backs = Math.min(4, 1 + Math.floor(n / 8)), off = m.cw < 50 ? 1 : 2;
        down.forEach((c, i) => {
          const under = n - 1 - i;
          put(c, x0, m.top + Math.min(under, backs - 1) * off, z0 + i, false, i, under >= Math.max(2, backs));
        });
      } else if (kind === 'deals') {
        // A row to deal is ten cards; each row left shows as its own card, fanned out.
        const rows = Math.ceil(down.length / 10), step = Math.round(m.cw * 0.2);
        down.forEach((c, i) => {
          const r = (i / 10) | 0, topOfRow = i % 10 === 9 || i === down.length - 1;
          put(c, x0 + dir * (rows - 1 - r) * step, m.top, z0 + i, false, i, !(topOfRow || (r === rows - 1 && i >= down.length - 2)));
        });
      } else if (kind === 'waste') {
        const fanned = game.fan?.(s) || 0, step = Math.round(m.cw * 0.46); // wide enough to read a covered 10
        up.forEach((c, i) => {
          const k = i - (up.length - fanned);
          put(c, x0 + (k > 0 ? k * step : 0), m.top, z0 + i, true, i, deep(i, up.length, Math.max(1, fanned) + 1));
        });
      } else if (kind === 'stack') {
        up.forEach((c, i) => put(c, x0, m.top, z0 + i, true, i, !this.showAll && deep(i, up.length, 2)));
      } else if (kind === 'sets') {
        // Each cleared run is a pile of thirteen with its king on top, fanned out from the last.
        const step = Math.round(m.cw * 0.3);
        up.forEach((c, i) => put(c, x0 + dir * ((i / 13) | 0) * step, m.top, z0 + i, true, i, !this.showAll && i % 13 < 11));
      } else {
        // Columns fan downwards, and squeeze up when they would run off the bottom.
        const nd = down.length, nu = up.length;
        let dStep = m.ch * 0.13, uStep = m.ch * spread;
        const need = () => nd * dStep + Math.max(0, nu - 1) * uStep;
        // No closer than STEP_DOWN and m.step, which still shows a face-up card's rank in full; the cards are sized so
        // that the longest column fits that way (see rowsFor()).
        if (need() > room) dStep = Math.max(m.ch * STEP_DOWN, nd ? (room - Math.max(0, nu - 1) * uStep) / nd : 0);
        if (need() > room && nu > 1) uStep = Math.max(m.ch * m.step, (room - nd * dStep) / (nu - 1));
        // With the cards as small as they go and the column still too long, closer than that rather than off the bottom.
        if (need() > room && nu > 1) uStep = Math.max(m.ch * 0.2, (room - nd * dStep) / (nu - 1));
        let y = m.tabY;
        down.forEach((c, i) => { put(c, x0, y, z0 + i, false, -1, false); y += dStep; });
        up.forEach((c, i) => { put(c, x0, y, z0 + nd + i, true, i, false); if (i < nu - 1) at.get(c).covered = true; y += uStep; });
      }
    });
    return at;
  }

  // How far apart face-up cards in the columns go, in card heights: as far as half a card while there's room below, and
  // 0.36 once the longest column needs that (place() squeezes a column closer still if it must). One spacing for every
  // column, so they line up, set by the column that needs the most room. Like the card size (see layout()), it doesn't
  // spread out again as a column gets shorter, for the rest of the deal at this size of table, so the cards don't shift
  // back and forth as one column is played down and built up.
  spreadFor(s, room) {
    const m = this.m, g = gameOf(s), of = dealOf(s);
    let u = 0.5;
    for (const id of m.piles) {
      if (m.kind[id] !== 'column') continue;
      const { down, up } = g.pile(s, id);
      if (up.length > 1) u = Math.min(u, (room - down.length * m.ch * 0.13) / ((up.length - 1) * m.ch));
    }
    u = Math.max(0.36, u);
    const size = `${m.W}x${m.H}:${m.ch}`;
    if (of && this.spread?.of === of && this.spread.size === size) u = Math.min(u, this.spread.u);
    this.spread = { of, size, u };
    return u;
  }

  // Draw the state. still: jump there with no movement. deal: deal the columns out one by one.
  render(s, opts = {}) {
    const calm = this.calm.matches;
    if (opts.deal && calm) { opts = { still: true }; this.dealDuration = 0; }
    const first = !this.state || this.v !== s.v;
    // A hint stays lit until the cards move: drawing the same table again (a new size, the deck moved) keeps it.
    if (s !== this.state) { this.clearHint(); this.unflag(); this.showAll = false; }
    this.state = s;
    if (first) this.setup(s);
    if (!this.m || this.m.layoutKey !== this.layoutKey(s, this.m.step)) this.layout();
    const at = this.place(s), m = this.m;
    if (opts.still || (first && !opts.deal)) this.el.classList.add('still');

    // Every card's delay is cleared afterwards, not just the ones just set: a deal cut short by another
    // would otherwise leave some cards slow to move for the rest of the game.
    const undelay = () => this.cards.forEach(el => { el.style.transitionDelay = ''; el.firstChild.style.transitionDelay = ''; });
    const waits = new Map(); // card -> how long it waits before moving
    const delay = (list, step, lead = 0) => {
      clearTimeout(this.delayTimer);
      undelay();
      list.forEach((c, k) => {
        const el = this.cards.get(c);
        waits.set(c, lead + k * step);
        el.style.transitionDelay = `${lead + k * step}ms`;
        el.firstChild.style.transitionDelay = `${lead + k * step + 120}ms`;
      });
      this.delayTimer = setTimeout(undelay, lead + list.length * step + 500);
      return list.length * step + 450;
    };

    if (opts.deal) {
      // Start every card on the pile it's dealt from, face down, then send each one out in dealing order.
      const from = m.spot[m.dealFrom];
      this.cards.forEach(el => {
        el.classList.add('down');
        el.classList.remove('deep');
        el.style.transform = `translate(${from}px, ${m.top}px)`;
        el.style.zIndex = 1;
      });
      this.el.classList.add('still');
      void this.el.offsetWidth;
      this.el.classList.remove('still');
      const order = this.game.dealOrder(s);
      this.dealDuration = delay(order, order.length > 30 ? 18 : 26);
    }

    // Which cards are moving, and from where.
    const flyers = this.flyNext || new Set();
    this.flyNext = null;
    // Cards held up by a finger stay under it while the rest of the table changes, so long as they're still the cards
    // on top of the pile they came from. If they aren't (Undo took them back, say), they're let go, back to the table.
    const d = this.drag, holding = d && this.holds(d, s) ? new Set(d.moved ? d.cards : []) : null;
    if (d && !holding) {
      this.endDrag();
      if (d.moved) d.cards.forEach(c => flyers.add(c));
    }
    // While cards are held off a column, the card they were on isn't covered.
    const bare = holding?.size ? this.beneathHeld(d, s) : undefined;
    const moved = [];
    for (const [c, p] of at) {
      const old = this.at.get(c);
      if (opts.deal || flyers.has(c) || (old && (old.pile !== p.pile || Math.abs(old.x - p.x) > 1 || Math.abs(old.y - p.y) > 1))) moved.push([c, p, old]);
    }
    // A row dealt in Spider, or a run cleared away, goes one card at a time.
    if (!opts.deal && !opts.still && !first && !calm) {
      const row = moved.filter(([, p, old]) => old && m.kind[old.pile] === 'deals' && p.pile !== old.pile);
      const cleared = moved.filter(([, p, old]) => old && m.kind[p.pile] === 'sets' && old.pile !== p.pile);
      if (row.length > 1) delay(row.sort((a, b) => m.order[a[1].pile] - m.order[b[1].pile]).map(([c]) => c), 45);
      else if (cleared.length > 1) delay(cleared.sort((a, b) => a[1].index - b[1].index).map(([c]) => c), 32, 150); // the ace first
    }

    const movedSet = new Set(moved.map(([c]) => c));
    const animate = !opts.still && (!first || opts.deal);
    for (const [c, p] of at) {
      const el = this.cards.get(c);
      const was = el.style.transform.match(/-?[\d.]+/g) || [p.x, p.y];
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      el.classList.toggle('down', !p.up);
      el.classList.toggle('covered', !!p.covered && c !== bare);
      el.setAttribute('aria-label', p.up ? cardName(c) : 'face down');
      const flight = this.flights.get(c);
      if (holding?.has(c)) {
        el.style.transform = `translate(${Math.round(p.x + d.dx)}px, ${Math.round(p.y + d.dy)}px)`;
      } else if (movedSet.has(c) && animate) {
        // The further it goes, the longer it takes, so a long trip doesn't look like a jump.
        const ms = calm ? 10 : Math.round(Math.min(320, 170 + 0.12 * Math.hypot(p.x - was[0], p.y - was[1])));
        el.style.setProperty('--travel', `${ms}ms`);
        this.fly(c, p, ms + 40 + (waits.get(c) || 0));
      } else if (flight && animate) {
        // Still on its way from an earlier move, to the same place: it lands when it gets there, as it would have,
        // and not under the cards it's passing. Only its place in the pile may have changed.
        flight.z = p.z;
        flight.deep = p.deep;
      } else {
        this.land(c);
        el.style.zIndex = p.z;
        el.classList.toggle('deep', !!p.deep);
      }
    }
    this.at = at;
    this.name(s);
    // Cards held with the keyboard are put back if they aren't on top of their pile any more (Undo took them back).
    if (this.held && !this.holds(this.held, s)) this.putBack();
    this.showCursor();
    if (holding || this.held) this.aim();
    for (const id of m.piles) {
      if (m.kind[id] !== 'stock') continue;
      const pile = this.game.pile(s, id), waste = this.game.pile(s, 'waste');
      this.spots[id].classList.toggle('gone', !pile.down.length && !waste.up.length);
    }
    if (opts.still || (first && !opts.deal)) { void this.el.offsetWidth; this.el.classList.remove('still'); }
  }

  // What a screen reader finds on the table: each pile, in the order they're laid out, named for what it is and what's
  // in it, holding the cards that can be seen and played (aria-owns puts them in it, in order, without moving them).
  // The rest are left out: face-down cards (the pile says how many), the deck's, cards under the top card of a pile.
  name(s) {
    const m = this.m, g = this.game, said = new Set();
    m.piles.forEach(id => {
      const kind = m.kind[id], { down, up } = g.pile(s, id);
      let label, cards = [];
      if (kind === 'column') {
        cards = up;
        const n = m.order[id] - 99;
        label = !down.length && !up.length ? `Empty column ${n}` : `Column ${n}${down.length ? `, ${down.length} face down` : ''}`;
      } else if (kind === 'stock') {
        const waste = g.pile(s, 'waste').up.length;
        label = down.length ? `Deck, ${down.length} card${down.length === 1 ? '' : 's'}` : waste ? 'Deck empty, tap to turn the pile over' : 'Deck empty';
      } else if (kind === 'deals') {
        const rows = Math.ceil(down.length / 10);
        label = rows ? `Deck, ${rows} row${rows === 1 ? '' : 's'} to deal` : 'Deck empty';
      } else if (kind === 'sets') {
        label = `Cleared runs, ${up.length / 13} of 8`;
      } else if (kind === 'waste') {
        cards = up.slice(-Math.max(1, g.fan?.(s) || 0));
        label = up.length ? 'Waste' : 'Waste, empty';
      } else if (id[0] === 'c') {
        cards = up.slice(-1);
        label = up.length ? 'Free cell' : 'Free cell, empty';
      } else {
        cards = up.slice(-1);
        label = up.length ? `${SUIT_NAMES[suitOf(up[0])].replace(/^./, x => x.toUpperCase())} foundation` : 'Foundation, empty';
      }
      cards.forEach(c => said.add(c));
      const el = this.spots[id];
      attr(el, 'role', cards.length ? 'group' : 'img');
      attr(el, 'aria-label', label);
      attr(el, 'aria-owns', cards.length ? cards.map(c => 'card-' + c).join(' ') : null);
    });
    for (const [c, el] of this.cards) attr(el, 'aria-hidden', said.has(c) ? null : 'true');
  }

  // A card on its way somewhere flies over everything else, lifted off the table, and takes no taps, so a tap goes to
  // whatever is under it: a quick second tap on the Spider deck while the last row is still leaving it deals another
  // row. Once it's there it settles into its pile, and hides again if it's buried there.
  fly(c, p, ms) {
    const el = this.cards.get(c);
    this.land(c, true);
    el.style.zIndex = 5000 + p.z;
    el.classList.remove('deep');
    el.classList.add('flying');
    const f = { z: p.z, deep: p.deep };
    // It lands the moment it gets there. In case it never moves (it had no distance to go) after `ms` it lands anyway,
    // once it has stopped moving: on a busy phone a move can start a few frames late.
    f.end = e => { if (e.target === el && e.propertyName === 'transform') this.land(c); };
    el.addEventListener('transitionend', f.end);
    const late = () => {
      if (el.getAnimations?.().some(a => a.transitionProperty === 'transform' && a.playState === 'running')) f.timer = setTimeout(late, 30);
      else this.land(c);
    };
    f.timer = setTimeout(late, ms);
    this.flights.set(c, f);
  }

  // `again`: it's about to fly off somewhere else, so it needn't settle first.
  land(c, again) {
    const f = this.flights.get(c);
    if (!f) return;
    clearTimeout(f.timer);
    this.flights.delete(c);
    const el = this.cards.get(c);
    el.removeEventListener('transitionend', f.end);
    if (again) return;
    el.style.zIndex = f.z;
    el.classList.toggle('deep', !!f.deep);
    el.classList.remove('flying');
    el.style.removeProperty('--travel');
  }

  get moving() { return this.flights.size > 0; }

  // ---- picking cards up ----

  down(e) {
    this.hideCursor(); // a finger or the mouse takes over from the keyboard
    if (this.locked || this.drag || !this.state || (e.pointerType === 'mouse' && e.button !== 0)) return;
    this.balked = null;
    const s = this.state, m = this.m;
    const cardEl = e.target.closest('.card'), spot = e.target.closest('.spot');
    let pile, index;
    if (cardEl) ({ pile, index } = this.at.get(+cardEl.dataset.c));
    else if (spot) { pile = spot.dataset.pile; index = -1; }
    const kind = pile && m.kind[pile];
    this.on.touched(kind === 'stock' || kind === 'deals');
    if (!pile) return;

    if (kind === 'stock' || kind === 'deals') { this.on.stock(); return; }
    if (kind === 'sets') return;
    // Where Hint says a card goes is lit up as well as the card, and a tap on either plays the move: here, on an empty
    // column, free cell or foundation, where there's nothing to pick up (a lit card is in up(), below).
    const h = this.shown, hinted = h && !h.stock && pile === h.to;
    if (hinted && !this.game.pile(s, pile).up.length) { this.on.move(h.from, h.n, h.to); return; }
    if (kind === 'column') {
      // A card still arriving on this column takes no press itself (see fly()), but a press where it's landing is for it.
      const up = this.game.pile(s, pile).up, r = this.el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      for (let i = up.length - 1; i > index; i--) {
        const p = this.at.get(up[i]);
        if (this.flights.has(up[i]) && x >= p.x && x < p.x + m.cw && y >= p.y && y < p.y + m.ch) { index = i; break; }
      }
    }
    if (kind !== 'column') index = this.game.pile(s, pile).up.length - 1;
    if (index < 0) return;
    const cards = this.game.lift(s, pile, index);
    if (!cards) {
      // The lit card on a FreeCell foundation, which stays there.
      if (hinted && index === this.game.pile(s, pile).up.length - 1) { this.on.move(h.from, h.n, h.to); return; }
      // A face-up card that can't come up with the cards on top of it. If it's dragged anyway, the game may say why.
      if (cardEl) {
        this.shakeCards([+cardEl.dataset.c]);
        this.balked = { pile, index, x0: e.clientX, y0: e.clientY, id: e.pointerId, mouse: e.pointerType === 'mouse' };
      }
      return;
    }
    this.drag = { pile, n: cards.length, cards, x0: e.clientX, y0: e.clientY, moved: false, id: e.pointerId, mouse: e.pointerType === 'mouse' };
    try { this.el.setPointerCapture(e.pointerId); } catch { /* the pointer may already be gone */ }
  }

  moveDrag(e) {
    const b = this.balked;
    if (b && e.pointerId === b.id && Math.hypot(e.clientX - b.x0, e.clientY - b.y0) >= (b.mouse ? 4 : 8)) {
      this.balked = null;
      this.on.refused?.({ from: b.pile, index: b.index });
    }
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < (d.mouse ? 4 : 8)) return;
      d.moved = true;
      this.clearHint();
      d.cards.forEach((c, i) => { this.land(c); const el = this.cards.get(c); el.classList.add('drag'); el.style.zIndex = 9000 + i; });
      // The card they were on shows its middle while they're held off it (see render()).
      this.cards.get(this.beneathHeld(d, this.state))?.classList.remove('covered');
    }
    d.dx = dx; d.dy = dy;
    for (const c of d.cards) {
      const p = this.at.get(c);
      this.cards.get(c).style.transform = `translate(${Math.round(p.x + dx)}px, ${Math.round(p.y + dy)}px)`;
    }
    this.aiming ||= requestAnimationFrame(() => { this.aiming = 0; this.aim(); });
  }

  // Outline where the cards held would go if let go now: the top card of that pile, or its empty place. Held with the
  // keyboard, that's the place it has chosen, if they can go there.
  aim() {
    const d = this.drag, k = this.held, at = this.cursor?.pile;
    const to = d?.moved ? this.dropTarget(d) : k && at !== k.pile && this.fits(k.cards, at) ? at : null;
    let el = null;
    if (to) {
      const { down, up } = this.game.pile(this.state, to), top = up.length ? up[up.length - 1] : down[down.length - 1];
      el = top === undefined ? this.spots[to] : this.cards.get(top);
    }
    if (el === this.aimed) return;
    this.aimed?.classList.remove('target');
    el?.classList.add('target');
    this.aimed = el;
  }

  // The card under the cards picked up, in table `s`, if there is one face up.
  beneathHeld(d, s) {
    const up = gameOf(s).pile(s, d.pile).up;
    return up[up.length - d.n - 1];
  }

  // Whether the cards picked up are still the cards on top of the pile they came from, in table `s`.
  holds(d, s) {
    const g = gameOf(s), up = d.pile in this.m.kind && g.pile(s, d.pile).up;
    return !!up && up.length >= d.n && d.cards.every((c, i) => up[up.length - d.n + i] === c);
  }

  // Let go of the cards picked up, without playing them.
  endDrag() {
    const d = this.drag;
    this.drag = null;
    this.aim();
    if (d) for (const c of d.cards) this.cards.get(c)?.classList.remove('drag');
  }

  // Let go of the cards held, back where they came from (Escape).
  letGo() {
    const d = this.drag;
    if (!d) return;
    this.endDrag();
    if (!d.moved) return;
    this.flyNext = new Set(d.cards);
    this.render(this.state);
  }

  up(e, cancelled) {
    if (this.balked?.id === e.pointerId) this.balked = null;
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.endDrag();
    // (They always are, as render() lets them go when they aren't, but a move made with other cards would be wrong.)
    const still = this.holds(d, this.state);
    if (!d.moved) {
      if (cancelled || !still) return;
      // A tap on either card Hint lit up, the one to move or the top card where it goes, plays Hint's move, wherever a
      // tap would otherwise send it.
      const h = this.shown;
      if (h && !h.stock && d.pile === h.from && d.n === h.n) this.on.move(d.pile, d.n, h.to);
      else if (h && !h.stock && d.pile === h.to && d.n === 1) this.on.move(h.from, h.n, h.to);
      else this.on.tap(d.pile, d.n);
      return;
    }
    this.flyNext = new Set(d.cards);
    const over = cancelled || !still ? null : this.overPile(d);
    if (over && this.game.canDrop(this.state, d.cards, over)) { this.on.move(d.pile, d.n, over); return; }
    this.render(this.state);
    if (over) this.on.refused?.({ from: d.pile, cards: d.cards, to: over });
  }

  // Where the dragged cards go when let go: the pile they're most over, if they may go there (see overPile).
  dropTarget(d) {
    const to = this.overPile(d);
    return to && this.game.canDrop(this.state, d.cards, to) ? to : null;
  }

  // The pile the dragged cards are most over, if they aren't already in it, and only if they're well over it, a third
  // of a card or the card's middle in the pile's area; whether they may go there or not. Otherwise they go back, so a
  // card nudged a little stays in its own column, and one let go mostly over a column it can't go on doesn't go to the
  // next one along instead.
  overPile(d) {
    const m = this.m, p = this.at.get(d.cards[0]), g = m.gap / 2;
    const r = { x: p.x + d.dx, y: p.y + d.dy, w: m.cw, h: m.ch };
    const over = z => Math.max(0, Math.min(r.x + r.w, z.x + z.w) - Math.max(r.x, z.x)) * Math.max(0, Math.min(r.y + r.h, z.y + z.h) - Math.max(r.y, z.y));
    // Its own pile counts as where it came from, and the whole column if it came from one.
    let best = d.pile, most = Math.max(over({ x: p.x - g, y: p.y - g, w: m.cw + 2 * g, h: m.ch + 2 * g }), m.kind[d.pile] === 'column' ? over(this.zone(d.pile)) : 0);
    for (const id of this.game.targets(this.state)) {
      const a = id === d.pile ? 0 : over(this.zone(id));
      if (a > most) { most = a; best = id; }
    }
    if (best === d.pile) return null;
    const z = this.zone(best), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return most >= (r.w * r.h) / 3 || (cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h) ? best : null;
  }

  // The area that counts as dropping onto a pile: a column's whole length, or the pile's spot.
  zone(id) {
    const m = this.m, g = m.gap / 2;
    if (m.kind[id] !== 'column') return { x: m.spot[id] - g, y: m.top - g, w: m.cw + 2 * g, h: m.ch + 2 * g };
    const { down, up } = this.game.pile(this.state, id);
    const last = up.length ? up[up.length - 1] : down[down.length - 1];
    const bottom = (last !== undefined ? this.at.get(last).y : m.tabY) + m.ch;
    return { x: m.spot[id] - g, y: m.tabY - g, w: m.cw + 2 * g, h: bottom - m.tabY + m.ch * 0.4 + g };
  }

  // ---- the keyboard ----

  // The arrow keys choose a place on the table, shown with a ring: `cursor` is { pile, index }, index being which of the
  // pile's face-up cards (in a column, any of them; elsewhere, the top one), or -1 for none. Enter does what a tap there
  // would; Space picks the cards up from there (`held`, like a drag: { pile, n, cards }), and again puts them down where
  // the arrows have taken them, outlined while they can go there.

  // The top row as the arrow keys go along it, from the left: Spider's cleared runs are left out, being for looking at.
  get topRow() {
    const m = this.m;
    return m.piles.filter(id => m.kind[id] !== 'column' && m.kind[id] !== 'sets').sort((a, b) => this.xOf(a) - this.xOf(b));
  }
  get columns() { return this.m.piles.filter(id => this.m.kind[id] === 'column'); }

  // Where a pile is across the table: its top card, which in a fanned waste is further right than the pile's place.
  xOf(id) {
    const up = this.game.pile(this.state, id).up, top = up[up.length - 1];
    return top !== undefined && this.at.get(top) ? this.at.get(top).x : this.m.spot[id];
  }

  // The pile's top card's index, or -1.
  topOf(id) { return this.game.pile(this.state, id).up.length - 1; }

  // Choose a place, and show it.
  point(pile, index = this.topOf(pile)) {
    this.cursor = { pile, index };
    this.showCursor();
    this.aim();
  }

  // An arrow key: along the row, or up and down a column's face-up cards and between the columns and the top row. The
  // first press shows where it is (Hint's card, if one is lit, or else the first column).
  steer(dir) {
    if (!this.state || !this.m) return;
    const c = this.cursor;
    if (!c) {
      const h = this.shown;
      if (h) this.pointAtHint(h); else this.point(this.columns[0]);
      return;
    }
    const isCol = this.m.kind[c.pile] === 'column', row = isCol ? this.columns : this.topRow;
    const nearest = ids => ids.reduce((a, b) => (Math.abs(this.xOf(b) - this.xOf(c.pile)) < Math.abs(this.xOf(a) - this.xOf(c.pile)) ? b : a));
    if (dir === 'left' || dir === 'right') {
      const next = row[row.indexOf(c.pile) + (dir === 'left' ? -1 : 1)];
      if (next) this.point(next);
    } else if (dir === 'up') {
      // Holding cards, it's only where they go that matters, so it goes straight between the rows.
      if (isCol && !this.held && c.index > 0) this.point(c.pile, c.index - 1);
      else if (isCol && this.topRow.length) this.point(nearest(this.topRow));
    } else if (!isCol) this.point(nearest(this.columns));
    else if (!this.held && c.index < this.topOf(c.pile)) this.point(c.pile, c.index + 1);
  }

  // 1 to 9, and 0 for the tenth: that column's top card.
  toColumn(n) {
    const id = this.state && this.m && this.columns[n - 1];
    if (id) this.point(id);
  }

  // Hint's card (or the deck), when the cursor is showing, so Enter plays its move as a tap on that card would.
  pointAtHint(h) {
    if (h.stock) this.point(this.m.piles.find(p => this.m.kind[p] === 'stock' || this.m.kind[p] === 'deals'));
    else this.point(h.from, this.topOf(h.from) + 1 - h.n);
  }

  // Enter: what a tap on the chosen card would do (a tap on either card Hint lit up plays its move), or, holding cards,
  // put them down.
  press() {
    const c = this.cursor;
    if (!c || this.locked) return;
    if (this.held) { this.putDown(); return; }
    const kind = this.m.kind[c.pile], s = this.state, h = this.shown && !this.shown.stock ? this.shown : null;
    if (kind === 'stock' || kind === 'deals') { this.on.stock(); return; }
    if (kind === 'sets') return;
    const top = this.topOf(c.pile), hintedTo = h && c.pile === h.to && c.index === top;
    if (c.index < 0) { if (hintedTo) this.on.move(h.from, h.n, h.to); return; }
    const cards = this.game.lift(s, c.pile, c.index);
    if (!cards) {
      if (hintedTo) this.on.move(h.from, h.n, h.to);
      else this.shakeCards([this.game.pile(s, c.pile).up[c.index]]);
      return;
    }
    if (h && c.pile === h.from && cards.length === h.n) this.on.move(c.pile, cards.length, h.to);
    else if (hintedTo && cards.length === 1) this.on.move(h.from, h.n, h.to);
    else this.on.tap(c.pile, cards.length);
  }

  // Space: pick up the cards from the chosen card (the deck: draw, or deal a row), or put down the cards held.
  pickUp() {
    const c = this.cursor;
    if (!c || this.locked) return;
    if (this.held) { this.putDown(); return; }
    const kind = this.m.kind[c.pile], s = this.state;
    if (kind === 'stock' || kind === 'deals') { this.on.stock(); return; }
    if (kind === 'sets' || c.index < 0) return;
    const cards = this.game.lift(s, c.pile, c.index);
    if (!cards) {
      this.shakeCards([this.game.pile(s, c.pile).up[c.index]]);
      this.on.refused?.({ from: c.pile, index: c.index });
      return;
    }
    this.held = { pile: c.pile, n: cards.length, cards };
    cards.forEach(x => this.cards.get(x).classList.add('held'));
    this.on.held?.(cards);
    this.aim();
  }

  // Put the cards held down where the cursor is: back where they came from, or where they can go. Where they can't, they
  // shake and stay held, and the game may say why.
  putDown() {
    const k = this.held, to = this.cursor.pile;
    if (to === k.pile) { this.putBack(true); return; }
    if (!this.fits(k.cards, to)) {
      this.shakeCards(k.cards);
      this.on.refused?.({ from: k.pile, cards: k.cards, to });
      return;
    }
    this.putBack();
    this.on.move(k.pile, k.n, to);
  }

  // Let go of the cards held with the keyboard, leaving them where they are. (`said`: say so.)
  putBack(said) {
    const k = this.held;
    if (!k) return;
    this.held = null;
    k.cards.forEach(x => this.cards.get(x)?.classList.remove('held'));
    this.aim();
    if (said) this.on.held?.([]);
  }

  fits(cards, to) { return !!to && this.game.targets(this.state).includes(to) && this.game.canDrop(this.state, cards, to); }

  // Take the ring away (a tap or a click, Escape, or a new game), putting back anything held.
  hideCursor() {
    if (!this.cursor && !this.held) return;
    this.putBack();
    this.cursor = null;
    this.showCursor();
  }

  // Draw the ring where the cursor is, keeping it on the pile when the cards change: on the same card if it's still
  // there, otherwise the top one. It's a frame of its own over the cards, round as much of the card as shows (a card
  // under others in a column, its strip), so nothing covers it. To a screen reader, it's the card or the pile it's on
  // (aria-activedescendant).
  showCursor() {
    const c = this.cursor, m = this.m;
    let box = null, named = null;
    if (c && !(m && c.pile in m.kind)) this.cursor = null;
    else if (c) {
      const { down, up } = this.game.pile(this.state, c.pile), col = m.kind[c.pile] === 'column';
      c.index = col ? clamp(c.index, up.length ? 0 : -1, up.length - 1) : up.length - 1;
      const card = c.index >= 0 ? up[c.index] : down[down.length - 1];
      const p = card !== undefined && this.at.get(card);
      if (p) {
        const next = col && c.index >= 0 && this.at.get(up[c.index + 1]);
        // (A covered card's ring stops where the next card starts, clear of that card's rank.)
        box = { x: p.x, y: p.y, h: next ? next.y - p.y - 4 : m.ch };
      } else box = { x: m.spot[c.pile], y: col ? m.tabY : m.top, h: m.ch };
      if (c.index >= 0) named = this.cards.get(up[c.index]);
      if (!named || named.getAttribute('aria-hidden')) named = this.spots[c.pile];
    }
    if (box && !this.ring) {
      this.ring = document.createElement('div');
      this.ring.className = 'ring';
      this.ring.setAttribute('aria-hidden', 'true');
    }
    if (box) {
      if (this.ring.parentNode !== this.el) this.el.append(this.ring);
      this.ring.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
      this.ring.style.height = `${Math.round(box.h) + 8}px`; // 4 px outside it, above and below
    } else this.ring?.remove();
    attr(this.el, 'aria-activedescendant', named ? named.id : null);
  }

  // ---- showing things ----

  shake(pile, n) { this.shakeCards(this.game.pile(this.state, pile).up.slice(-n)); }

  shakeCards(cards) {
    for (const c of cards) {
      const el = this.cards.get(c);
      el.classList.remove('shake');
      void el.offsetWidth;
      el.classList.add('shake');
      setTimeout(() => el.classList.remove('shake'), 400);
    }
  }

  // Light up a suggested move: the card to pick up (or the stock), and where it goes. It pulses three times, then
  // glows steadily until the next move, Undo, New or a drag. `shown` keeps the move while it's lit up, so Enter, or
  // a tap on the lit card, plays it.
  showHint(h) {
    this.clearHint();
    this.shown = h;
    const s = this.state, marks = [];
    if (h.stock) {
      const id = this.m.piles.find(p => this.m.kind[p] === 'stock' || this.m.kind[p] === 'deals');
      const down = this.game.pile(s, id).down;
      marks.push(down.length ? this.cards.get(down[down.length - 1]) : this.spots[id]);
    } else {
      const from = this.game.pile(s, h.from).up;
      marks.push(this.cards.get(from[from.length - h.n]));
      const to = this.game.pile(s, h.to).up;
      marks.push(to.length ? this.cards.get(to[to.length - 1]) : this.spots[h.to]);
    }
    marks.forEach(el => el.classList.add('hint'));
    this.hinted = marks;
    if (this.cursor && !this.held) this.pointAtHint(h);
  }

  // Light up these piles' empty places for a couple of seconds, beside a message about them.
  flagSpots(ids) {
    this.unflag();
    this.flagged = ids.map(id => this.spots[id]).filter(Boolean);
    this.flagged.forEach(el => { el.classList.remove('hint'); void el.offsetWidth; el.classList.add('hint'); });
    this.flagTimer = setTimeout(() => this.unflag(), 2000);
  }

  unflag() {
    clearTimeout(this.flagTimer);
    this.flagged?.forEach(el => { if (!this.hinted?.includes(el)) el.classList.remove('hint'); });
    this.flagged = null;
  }

  clearHint() {
    if (this.hinted) this.hinted.forEach(el => el.classList.remove('hint'));
    this.hinted = null;
    this.shown = null;
  }

  // How many face-up cards a box on the screen (a message, say) covers, at the places they're going to if they're on
  // their way, and whether it covers the deck.
  under(box) {
    const r = this.el.getBoundingClientRect(), m = this.m;
    const hit = (x, y) => r.left + x < box.right && r.left + x + m.cw > box.left && r.top + y < box.bottom && r.top + y + m.ch > box.top;
    const deck = id => m.kind[id] === 'stock' || m.kind[id] === 'deals';
    let cards = 0, onDeck = m.piles.some(id => deck(id) && hit(m.spot[id], m.top));
    for (const p of this.at.values()) {
      if (p.up && !p.deep && hit(p.x, p.y)) cards++;
      if (deck(p.pile) && !p.deep && hit(p.x, p.y)) onDeck = true;
    }
    return { cards, deck: onDeck };
  }

  // Where a card is on screen, for the winning animation.
  rectOf(c) {
    const r = this.el.getBoundingClientRect(), p = this.at.get(c);
    return { x: r.left + p.x, y: r.top + p.y, w: this.m.cw, h: this.m.ch };
  }

  hide(c, hidden) { const el = this.cards.get(c); if (el) el.style.visibility = hidden ? 'hidden' : ''; }
  showAllCards() { this.showAll = false; this.cards.forEach(el => { el.style.visibility = ''; }); }

  // Show every card on the foundations, for the winning animation to lift them off one by one. They stay showing while
  // that table is up, even if it's drawn again at a new size (a phone turned while the cards bounce).
  unbury() {
    this.showAll = true;
    this.render(this.state, { still: true });
  }
}

// The least of itself, in card heights, a card in a column shows under the next one. Face down, an edge. Face up, the
// whole of its rank, a Q's tail and all, so it doesn't read O: the rank is max(12px, 0.36 of the card's width) tall and
// starts 2.5% of the way down (.ix in the stylesheet), so on small cards it's a larger part of the card.
const STEP_DOWN = 0.05;
const stepUp = cw => Math.max(12, 0.36 * cw) / (1.4 * cw) + 0.025;

// How many card heights tall the table needs to be: the game's own allowance (L.rows, 4.9 if it gives none), or more if
// a column is longer than that even with its face-up cards `up` apart, plus the row at the top. In half cards, so the
// cards change size only now and then as a column grows or shrinks.
function rowsFor(s, L, up) {
  const g = gameOf(s);
  let col = 0;
  for (const id of L.tableau) {
    const p = g.pile(s, id);
    col = Math.max(col, 1 + Math.max(0, p.up.length - 1) * up + p.down.length * STEP_DOWN);
  }
  return Math.max(L.rows || 4.9, Math.ceil((1 + col) * 2) / 2);
}

// Which deal a state is, for keeping the cards one size through it: the way of playing and the deal number. Back at the
// deal as dealt (a fresh one, the same one started again, or Undo all the way back) starts afresh too.
const dealOf = s => (s.moves ? `${s.v}:${s.deal}` : null);

// Set an attribute only when it changes (null: take it away), so a screen reader hears nothing new for a table that isn't.
function attr(el, name, value) {
  if (el.getAttribute(name) === value) return;
  if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
}

// A card is a picture to a screen reader, named in render(): its corner and middle aren't read out as well.
function makeCard(c) {
  const el = document.createElement('div');
  const s = SUITS[suitOf(c)], r = rankOf(c), label = RANK_LABELS[r];
  el.className = `card ${s} down`;
  el.id = 'card-' + c;
  el.setAttribute('role', 'img');
  el.dataset.c = c;
  el.dataset.r = r;
  const sym = cls => `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true"><use href="#suit-${s}"/></svg>`;
  const middle = r > 10 ? `<span class="court">${label}${sym('cc')}</span>` : sym('pip');
  el.innerHTML = `<div class="flip" aria-hidden="true"><div class="face"><span class="ix">${label}</span>${sym('cs')}${middle}</div><div class="back"></div></div>`;
  return el;
}
