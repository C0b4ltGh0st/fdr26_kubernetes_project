'use strict';
// The arena pod. It
//   1. serves the web UI and streams the game to the browser (SSE),
//   2. referees the game: snake pods long-poll the world and post their moves,
//   3. is the controller: Start creates real snake pods via the Kubernetes API,
//      Stop / Restart delete them again.
//
// The game does NOT start by itself. Until someone presses Start it is "stopped" and no snake pod exists.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const kube = require('./kube');
const { Game, COLS, ROWS } = require('./game');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const SELECTOR = 'app.kubernetes.io/name=snake,app.kubernetes.io/part-of=snake-pod-arena';
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

// ---------- state ----------
const game = new Game({ maxFood: cfg.MAX_FOOD, maxDeaths: cfg.MAX_DEATHS });
let phase = 'stopped';          // stopped | starting | running | stopping
let error = null;
let busy = false;               // a start/stop/restart is in flight
let startedAt = 0;
let self = null;                // info about this pod (uid, image), loaded lazily
let worldSeq = 0, worldJson = '{}';
const waiters = new Set();      // snake pods long-polling for the next world
const sseClients = new Set();   // browsers

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- pod naming ----------
const APPS = ['api-gateway', 'auth-service', 'payments', 'checkout', 'redis-cache', 'postgres', 'ingress-nginx', 'metrics-agent', 'worker-queue', 'frontend', 'search-indexer', 'notifier'];
const AL = 'bcdfghjklmnpqrstvwxz2456789';
const rnd = (n) => Array.from({ length: n }, () => AL[Math.floor(Math.random() * AL.length)]).join('');
const podName = () => `snake-${APPS[Math.floor(Math.random() * APPS.length)]}-${rnd(5)}`;

// ---------- Kubernetes ----------
async function loadSelf() {
  if (self) return self;
  const name = process.env.HOSTNAME;
  try {
    const p = await kube.getPod(name);
    const c = p.spec.containers[0];
    self = { name, uid: p.metadata.uid, image: c.image, pullPolicy: c.imagePullPolicy };
    return self;
  } catch (e) {
    log('could not read own pod, snake pods will not be owned by the arena pod:', e.message);
    return { name, uid: null, image: null, pullPolicy: null };
  }
}

function podSpec(name, me) {
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: {
      name,
      labels: { 'app.kubernetes.io/name': 'snake', 'app.kubernetes.io/part-of': 'snake-pod-arena' },
      // If the arena pod goes away (redeploy, .env change), Kubernetes garbage-collects the snakes with it.
      ...(me.uid ? { ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: me.name, uid: me.uid }] } : {}),
    },
    spec: {
      restartPolicy: 'Never',                 // a crashed snake stays "Error" instead of restarting
      terminationGracePeriodSeconds: 1,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{
        name: 'snake',
        image: cfg.SNAKE_IMAGE || me.image || 'afkproficoder/snake-pod-arena:latest',
        imagePullPolicy: me.pullPolicy || 'IfNotPresent',
        command: ['node', 'snake.js'],
        env: [{ name: 'POD_NAME', value: name }, { name: 'ARENA_URL', value: cfg.ARENA_URL }],
        resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '250m', memory: '96Mi' } },
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
      }],
    },
  };
}

// What `kubectl get pods` would show in the STATUS column.
function podStatus(p) {
  if (p.metadata.deletionTimestamp) return 'Terminating';
  const cs = p.status?.containerStatuses?.[0];
  const waiting = cs?.state?.waiting?.reason;
  if (waiting) return waiting;
  const t = cs?.state?.terminated;
  if (t) return t.reason || (t.exitCode ? 'Error' : 'Completed');
  switch (p.status?.phase) {
    case 'Running': return 'Running';
    case 'Succeeded': return 'Completed';
    case 'Failed': return p.status.reason || 'Error';
    default: return cs ? 'ContainerCreating' : 'Pending';
  }
}
const statusClass = (st) => (st === 'Running' || st === 'Completed') ? '' : ['Pending', 'ContainerCreating', 'PodInitializing', 'Terminating'].includes(st) ? 'wait' : 'bad';

let syncing = false;
async function syncPods() {
  if (syncing || phase === 'stopped' || phase === 'stopping') return;
  syncing = true;
  try {
    const items = (await kube.listPods(SELECTOR)).items || [];
    if (phase === 'stopped' || phase === 'stopping') return;
    const byName = new Map(items.map((p) => [p.metadata.name, p]));
    for (const s of game.snakes.values()) {
      const p = byName.get(s.name);
      if (!p) {
        if (Date.now() - s.createdAt > 5000) { s.status = 'Evicted'; if (!s.gone) game.remove(s); }
        continue;
      }
      s.status = podStatus(p);
      const ph = p.status?.phase;
      if (p.metadata.deletionTimestamp || ph === 'Failed' || ph === 'Succeeded') { if (!s.gone) game.remove(s); }
    }
    pushState();
  } catch (e) {
    log('pod sync failed:', e.message);
  } finally { syncing = false; }
}

// ---------- lifecycle: start / stop / restart ----------
async function run(fn) {
  if (busy) throw httpError(409, 'Another start/stop is still in progress');
  busy = true;
  try { await fn(); } finally { busy = false; pushState(); }
}

async function teardown() {
  phase = 'stopping'; pushState();
  try { await kube.deletePods(SELECTOR); }
  catch (e) { error = `Could not delete snake pods: ${e.message}`; log(error); }
  game.reset();
  phase = 'stopped';
  refreshWorld(); notifyWaiters(); pushState();
}

async function doStop() {
  if (phase === 'stopped') throw httpError(409, 'Game is already stopped');
  log('stopping');
  await teardown();
}

async function doStart() {
  if (phase !== 'stopped') throw httpError(409, `Game is already ${phase}`);
  error = null;
  game.reset();
  const me = await loadSelf();
  const names = new Set();
  while (names.size < cfg.SNAKE_COUNT) names.add(podName());
  let slot = 0;
  for (const n of names) game.addSnake(n, slot++);
  phase = 'starting'; startedAt = Date.now();
  log(`starting: creating ${names.size} snake pods`);
  refreshWorld(); pushState();

  const results = await Promise.allSettled([...names].map((n) => kube.createPod(podSpec(n, me))));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    error = `Could not create ${failed.length}/${names.size} pods: ${failed[0].reason.message}`;
    log(error);
    const msg = error;
    await teardown();
    error = msg;
    throw httpError(502, msg);
  }
}

const start = () => run(doStart);
const stop = () => run(doStop);
const restart = () => run(async () => { if (phase !== 'stopped') await doStop(); await doStart(); });

// ---------- world published to the snake pods ----------
function refreshWorld() {
  worldSeq++;
  const all = [...game.snakes.values()];
  worldJson = JSON.stringify({
    seq: worldSeq, tick: game.tick, cols: COLS, rows: ROWS, maxDeaths: game.maxDeaths,
    foods: game.foods.map((f) => ({ x: f.x, y: f.y, val: f.val })),
    snakes: all.filter((s) => s.alive).map((s) => ({ name: s.name, body: s.body, dir: s.dir, pending: s.pending, eaten: s.eaten, deaths: s.deaths })),
    crashed: all.filter((s) => s.crashed).map((s) => s.name),
  });
}

function tryAnswer(w) {
  const s = game.snakes.get(w.name);
  if (!s || s.gone) { w.res.writeHead(410, { 'Content-Type': 'application/json' }); w.res.end('{"exit":0}'); return true; }
  if (worldSeq > w.after) { w.res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); w.res.end(worldJson); return true; }
  return false;
}
function notifyWaiters() {
  for (const w of waiters) if (tryAnswer(w)) { clearTimeout(w.timer); waiters.delete(w); }
}

// ---------- state published to the browser ----------
function buildState() {
  const list = [...game.snakes.values()];
  const onBoard = list.filter((s) => s.alive);
  return JSON.stringify({
    phase, error,
    config: { snakeCount: cfg.SNAKE_COUNT, maxFood: cfg.MAX_FOOD, maxDeaths: cfg.MAX_DEATHS, tickMs: cfg.TICK_MS },
    cols: COLS, rows: ROWS, tick: game.tick,
    collisionEffects: game.collisionEffects,
    ready: list.filter((s) => s.joined && !s.gone).length, total: list.length,
    stats: { alive: onBoard.length, eaten: game.eaten, deaths: game.deaths, longest: Math.max(0, ...onBoard.map((s) => s.body.length)) },
    foods: game.foods.map((f) => ({ x: f.x, y: f.y, type: f.type })),
    snakes: list.map((s) => ({
      name: s.name, color: s.color, body: s.alive ? s.body : [], dir: s.dir,
      alive: s.alive, deaths: s.deaths, eaten: s.eaten, length: s.alive ? s.body.length : 0,
      status: s.status, statusClass: statusClass(s.status), respawning: s.alive && game.tick < s.restartUntil,
    })),
  });
}
function pushState() {
  if (!sseClients.size) return;
  const msg = `data: ${buildState()}\n\n`;
  for (const c of sseClients) c.write(msg);
}

// ---------- main loop ----------
function loop() {
  if (phase === 'starting') {
    const ready = [...game.snakes.values()].filter((s) => s.joined && !s.gone).length;
    const total = game.snakes.size;
    const timedOut = Date.now() - startedAt > cfg.START_TIMEOUT_SECONDS * 1000;
    if (total > 0 && (ready >= total || (ready > 0 && timedOut))) {
      phase = 'running';
      log(`running with ${ready}/${total} snake pods`);
    }
  }
  if (phase === 'running') {
    game.step();
    refreshWorld(); notifyWaiters(); pushState();
  }
}

// ---------- HTTP ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 8192) { reject(httpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, 'invalid JSON')); } });
    req.on('error', reject);
  });
}
const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(INDEX_HTML);
  }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }

  // --- browser ---
  if (req.method === 'GET' && p === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(buildState()); }
  if (req.method === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 1000\n\ndata: ${buildState()}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.method === 'POST' && p.startsWith('/api/game/')) {
    // Requiring a JSON content type forces a CORS preflight, so other websites cannot trigger this from a visitor's browser.
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'Content-Type must be application/json');
    const fn = { start, stop, restart }[p.slice('/api/game/'.length)];
    if (!fn) throw httpError(404, 'unknown action');
    await fn();
    return send(res, 200, { ok: true, phase });
  }

  // --- snake pods ---
  // These endpoints are for pods inside the cluster only. Requests that came through an ingress/proxy carry
  // X-Forwarded-* headers; refuse them so nobody outside can steer a snake.
  if (p.startsWith('/api/snake/') && (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'])) throw httpError(403, 'cluster-internal endpoint');
  if (req.method === 'POST' && p === '/api/snake/join') {
    const { name } = await readJson(req);
    if (!game.join(String(name))) return send(res, 410, { exit: 0 });
    refreshWorld(); notifyWaiters(); pushState();
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/snake/world') {
    const w = { res, name: url.searchParams.get('name'), after: Number(url.searchParams.get('after')), timer: null };
    if (tryAnswer(w)) return;
    w.timer = setTimeout(() => { waiters.delete(w); res.writeHead(204); res.end(); }, 10000);
    waiters.add(w);
    req.on('close', () => { clearTimeout(w.timer); waiters.delete(w); });
    return;
  }
  if (req.method === 'POST' && p === '/api/snake/move') {
    const { name, tick, dir } = await readJson(req);
    const s = game.snakes.get(String(name));
    if (s && s.alive) s.move = { tick, dir };
    res.writeHead(204); return res.end();
  }

  throw httpError(404, 'not found');
}

const server = http.createServer(async (req, res) => {
  try { await route(req, res); }
  catch (e) {
    const status = e.status || 500;
    if (status === 500) log('error:', e.stack || e);
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// ---------- boot ----------
server.listen(cfg.PORT, () => {
  log(`arena listening on :${cfg.PORT} (namespace ${kube.namespace})`);
  log(`config: ${cfg.SNAKE_COUNT} snakes, max food ${cfg.MAX_FOOD}, crash after ${cfg.MAX_DEATHS} deaths, tick ${cfg.TICK_MS} ms`);
  log('game is stopped, waiting for Start');
});
kube.deletePods(SELECTOR).catch((e) => log('startup cleanup of old snake pods failed:', e.message)); // leftovers from a previous arena

setInterval(loop, cfg.TICK_MS);
setInterval(syncPods, 1000);
setInterval(() => { for (const c of sseClients) c.write(': ping\n\n'); }, 15000);

process.on('SIGTERM', async () => {
  log('SIGTERM: removing snake pods');
  await Promise.race([kube.deletePods(SELECTOR).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
});
process.on('SIGINT', () => process.exit(0));
