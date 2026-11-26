'use strict';
// The bot brain that runs inside every snake pod.
// Same strategy as the original browser version: BFS to food, flood-fill
// space check (no self-trapping), tail-aware timing, avoids heads of longer
// snakes, avoids contested food, and hunts slightly smaller snakes.

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (p) => `${p.x},${p.y}`;
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** @returns {{x:number,y:number}|null} direction to move, or null if there is no option */
function chooseMove(world, name) {
  const COLS = world.cols, ROWS = world.rows, N = COLS * ROWS;
  const inside = (p) => p.x >= 0 && p.x < COLS && p.y >= 0 && p.y < ROWS;
  const idx = (p) => p.y * COLS + p.x;

  const me = world.snakes.find((s) => s.name === name);
  if (!me || !me.body.length) return null;
  const rivals = world.snakes.filter((o) => o !== me && o.body.length);
  const h = me.body[0], len = me.body.length, tail = me.body[len - 1];

  const freeAt = new Int16Array(N);
  for (const o of rivals) for (const p of o.body) freeAt[idx(p)] = 9999;
  me.body.forEach((p, i) => { freeAt[idx(p)] = len - i + me.pending; });

  const danger = new Set();
  for (const o of rivals) if (o.body.length >= len) {
    const oh = o.body[0];
    for (const [dx, dy] of DIRS) danger.add(key({ x: oh.x + dx, y: oh.y + dy }));
  }

  const info = world.foods.map((f) => ({ i: idx(f), val: f.val, contested: rivals.some((o) => dist(o.body[0], f) < dist(h, f)) }));

  // Hunting: a slightly smaller, still valuable snake in sight is prey (its body kills it when we hit it)
  const preyCells = new Map(), targets = [];
  for (const o of rivals) {
    const ol = o.body.length;
    if (ol >= 3 && ol < len && len - ol <= Math.max(3, len * 0.4) && dist(h, o.body[0]) <= 14) {
      for (const p of o.body) preyCells.set(idx(p), ol);
      const oh = o.body[0], nx = { x: oh.x + o.dir.x, y: oh.y + o.dir.y }; // predicted next head cell (intercept)
      if (inside(nx) && freeAt[idx(nx)] === 0) targets.push({ i: idx(nx), w: ol });
    }
  }

  let best = null, bestScore = -Infinity;
  for (const [dx, dy] of DIRS) {
    const c = { x: h.x + dx, y: h.y + dy };
    if (!inside(c)) continue;
    const ci = idx(c);
    if (preyCells.has(ci)) { const sc = 500 + preyCells.get(ci); if (sc > bestScore) { bestScore = sc; best = c; } continue; }
    if (freeAt[ci] > 1) continue;

    const t = new Int16Array(N); t[ci] = 1;
    const preyT = new Map();
    const q = [ci];
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi], x = i % COLS, y = (i / COLS) | 0, nt = t[i] + 1;
      for (const [ax, ay] of DIRS) {
        const nx = x + ax, ny = y + ay;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) continue;
        const ni = ny * COLS + nx;
        if (!t[ni] && freeAt[ni] <= nt) { t[ni] = nt; q.push(ni); }
        else if (preyCells.has(ni) && !preyT.has(ni)) preyT.set(ni, nt);
      }
    }

    const area = q.length;
    let score = Math.random() * 0.5;
    if (area < len) score -= 1000 - area;
    else if (area < len * 1.5) score -= (len * 1.5 - area) * 3;
    if (danger.has(key(c))) score -= 60;
    let cost = Infinity;
    for (const f of info) if (t[f.i]) cost = Math.min(cost, t[f.i] + (f.contested ? 8 : 0) - (f.val - 1) * 1.5);
    for (const [pi, pt] of preyT) cost = Math.min(cost, pt - preyCells.get(pi) * 0.6 - 4);
    for (const g of targets) if (t[g.i]) cost = Math.min(cost, t[g.i] + 1 - g.w * 0.6 - 4);
    if (cost < Infinity) score -= cost * 3; else score -= 40 + dist(c, tail) * 0.5;
    score += Math.min(area, 60) * 0.2;
    if (c.x === 0 || c.y === 0 || c.x === COLS - 1 || c.y === ROWS - 1) score -= 1;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best ? { x: best.x - h.x, y: best.y - h.y } : null;
}

module.exports = { chooseMove };
