'use strict';
// Authoritative game rules. No I/O in here: the arena feeds it moves that
// the snake pods submitted and publishes the result.

const COLS = 25;
const ROWS = 15;
const COLORS = [
  '#53d769', '#55b9f3', '#ffcc4d', '#d58bff', '#ff806e', '#48d6c5', '#f28fce', '#b4d36b', '#a6a6ff', '#ffa64d',
  '#4878ef', '#ed525f', '#a666ed', '#e9caa3', '#8ee943', '#f0ebdd', '#ef762b', '#e968bb', '#1eaf92', '#8baebf',
];

const key = (p) => `${p.x},${p.y}`;
const same = (a, b) => a.x === b.x && a.y === b.y;
const inside = (p) => p.x >= 0 && p.x < COLS && p.y >= 0 && p.y < ROWS;

class Game {
  constructor({ maxFood, maxDeaths }) {
    this.maxFood = maxFood;
    this.maxDeaths = maxDeaths;
    this.reset();
  }

  reset() {
    this.tick = 0;
    this.snakes = new Map(); // pod name -> snake
    this.foods = [];
    this.eaten = 0;
    this.deaths = 0;
    this.collisionEffects = { impacts: [], defeated: [] };
  }

  // A pod was requested. The snake only appears on the board once the pod joins.
  addSnake(name, slot) {
    const s = {
      name, slot, color: COLORS[slot % COLORS.length],
      body: [], dir: { x: 1, y: 0 }, pending: 0,
      joined: false, alive: false, crashed: false, gone: false,
      deaths: 0, eaten: 0, restartUntil: 0, move: null,
      status: 'Pending', createdAt: Date.now(),
    };
    this.snakes.set(name, s);
    return s;
  }

  join(name) {
    const s = this.snakes.get(name);
    if (!s || s.crashed || s.gone) return false;
    if (!s.joined) {
      s.joined = true;
      s.status = 'Running';
      this.place(s, true);
      this.refillFood();
    }
    return true;
  }

  // The pod disappeared (deleted, evicted, terminated): take it off the board.
  remove(s) { s.alive = false; s.body = []; s.gone = true; s.move = null; }

  isUsed(p) {
    if (this.foods.some((f) => same(f, p))) return true;
    for (const s of this.snakes.values()) if (s.alive && s.body.some((b) => same(b, p))) return true;
    return false;
  }

  freeCell() {
    const free = [];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!this.isUsed({ x, y })) free.push({ x, y });
    return free.length ? free[Math.floor(Math.random() * free.length)] : null;
  }

  place(s, initial) {
    const slotsPerRow = 5;
    let p = initial ? {
      x: Math.floor(((s.slot % slotsPerRow) + 0.5) * COLS / slotsPerRow),
      y: 2 + Math.floor(s.slot / slotsPerRow) * 3,
    } : null;
    if (!p || this.isUsed(p)) p = this.freeCell();
    if (!p) { s.alive = false; s.body = []; return false; }
    s.body = [p]; s.alive = true; s.dir = { x: 1, y: 0 }; s.pending = 0; s.move = null;
    return true;
  }

  refillFood() {
    while (this.foods.length < this.maxFood) {
      const p = this.freeCell();
      if (!p) break;
      const tank = Math.random() < 0.3;
      this.foods.push({ x: p.x, y: p.y, type: tank ? 'tank' : 'soldier', val: tank ? 3 : 1 });
    }
  }

  respawn(s) {
    this.deaths++; s.deaths++; s.pending = 0; s.move = null;
    s.alive = false; s.body = [];
    if (s.deaths >= this.maxDeaths) { s.crashed = true; return; } // the pod will exit(1) -> status Error
    if (this.place(s, false)) s.restartUntil = this.tick + 10;
  }

  // The direction a snake will take this tick. Only a move computed from the
  // current world (same tick) counts; a pod that answers too late, or sends
  // garbage, just keeps going straight.
  pickNext(s) {
    const h = s.body[0], m = s.move;
    let d = m && m.tick === this.tick ? m.dir : null;
    if (d && !(Number.isInteger(d.x) && Number.isInteger(d.y) && Math.abs(d.x) + Math.abs(d.y) === 1)) d = null;
    if (d && s.body.length > 1 && h.x + d.x === s.body[1].x && h.y + d.y === s.body[1].y) d = null; // no U-turn
    d = d || s.dir;
    return { x: h.x + d.x, y: h.y + d.y };
  }

  // One simultaneous step for every snake on the board.
  step() {
    for (const s of this.snakes.values()) if (s.joined && !s.alive && !s.crashed && !s.gone) this.place(s, false);

    const movers = [...this.snakes.values()].filter((s) => s.alive);
    const occupied = new Map();            // cell -> snake, positions at the start of the tick
    for (const s of movers) for (const p of s.body) occupied.set(key(p), s);

    const next = new Map(), heads = new Map();
    for (const s of movers) {
      const c = this.pickNext(s);
      next.set(s, c);
      const k = key(c);
      if (!heads.has(k)) heads.set(k, []);
      heads.get(k).push(s);
    }

    const dead = new Set(), defeated = new Set(), impacts = new Map();
    const defeat = (s) => { dead.add(s); defeated.add(s); };
    const clash = (a, b, point) => {       // the shorter snake restarts, a tie restarts both
      impacts.set(key(point), point);
      const la = a.body.length, lb = b.body.length;
      if (la <= lb) defeat(a);
      if (lb <= la) defeat(b);
    };
    for (const s of movers) {
      const c = next.get(s), k = key(c);
      if (!inside(c)) { dead.add(s); continue; }
      const owner = occupied.get(k);
      if (owner === s) {                   // own body: only the tail cell is free, and only if we are not growing
        const tail = s.body[s.body.length - 1];
        if (!(s.pending === 0 && same(tail, c))) dead.add(s);
      } else if (owner) {
        const head = s.body[0];
        if (same(c, owner.body[0]) && same(next.get(owner), head)) {
          clash(s, owner, { x: (c.x + head.x) / 2, y: (c.y + head.y) / 2 });
        } else {
          impacts.set(k, c);
          defeat(owner);                   // a side hit kills the snake being hit
        }
      }
      for (const o of heads.get(k)) if (o !== s) clash(s, o, c); // heads entering the same cell
    }

    this.collisionEffects = {
      impacts: [...impacts.values()],
      defeated: [...defeated].map(({ body, color, dir }) => ({ body: body.slice(), color, dir })),
    };
    for (const s of movers) {
      if (dead.has(s)) continue;
      const c = next.get(s), h = s.body[0];
      s.dir = { x: c.x - h.x, y: c.y - h.y };
      s.body.unshift(c);
      const fi = this.foods.findIndex((f) => same(f, c));
      if (fi >= 0) { s.pending += this.foods[fi].val; this.foods.splice(fi, 1); this.eaten++; s.eaten++; }
      if (s.pending > 0) s.pending--; else s.body.pop();
    }
    for (const s of dead) this.respawn(s);
    this.refillFood();
    this.tick++;
  }
}

module.exports = { Game, COLS, ROWS };
