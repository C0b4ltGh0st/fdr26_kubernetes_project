'use strict';
// Entry point of a snake pod. One pod = one snake.
//
//   join the arena -> long-poll the world -> think -> post a move -> repeat
//
// Exit codes (they show up in `kubectl get pods`):
//   0  stopped / unknown to the arena  -> Completed
//   1  too many deaths, or the arena is unreachable for a minute -> Error

const { chooseMove } = require('./ai');

const NAME = process.env.POD_NAME;
const ARENA = (process.env.ARENA_URL || 'http://snake-arena').replace(/\/$/, '');
if (!NAME) { console.error('POD_NAME is required'); process.exit(2); }

// PID 1 ignores SIGTERM unless a handler exists; without this, deleting the pod would take 30 s.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

const log = (m) => console.log(`${new Date().toISOString()} [${NAME}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, path, body, timeoutMs) {
  return fetch(ARENA + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function join() {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await call('POST', '/api/snake/join', { name: NAME }, 5000);
      await r.text();
      if (r.status === 410) { log('the arena does not know this pod, exiting'); process.exit(0); }
      if (r.ok) return;
    } catch { /* arena not reachable yet */ }
    if (Date.now() - t0 > 60000) { log('arena unreachable, giving up'); process.exit(1); }
    await sleep(500);
  }
}

async function main() {
  await join();
  log(`joined the arena at ${ARENA}`);
  let after = -1, lastDeaths = 0, failingSince = 0;

  for (;;) {
    let world;
    try {
      const r = await call('GET', `/api/snake/world?name=${encodeURIComponent(NAME)}&after=${after}`, null, 20000);
      failingSince = 0;
      if (r.status === 410) { await r.text(); log('game stopped, exiting'); process.exit(0); }
      if (r.status === 204) { await r.text(); continue; }          // nothing new, poll again
      if (!r.ok) { await r.text(); throw new Error(`HTTP ${r.status}`); }
      world = await r.json();
    } catch (e) {
      failingSince ||= Date.now();
      if (Date.now() - failingSince > 60000) { log(`arena unreachable (${e.message}), giving up`); process.exit(1); }
      await sleep(500);
      continue;
    }
    after = world.seq;

    if (world.crashed.includes(NAME)) {
      log(`died ${world.maxDeaths} times, crashing on purpose`);
      process.exit(1);
    }
    const me = world.snakes.find((s) => s.name === NAME);
    if (!me) continue;                                              // not on the board right now
    if (me.deaths > lastDeaths) { lastDeaths = me.deaths; log(`died (${me.deaths}/${world.maxDeaths}), restarting at length 1`); }

    const dir = chooseMove(world, NAME);
    if (dir) call('POST', '/api/snake/move', { name: NAME, tick: world.tick, dir }, 5000).then((r) => r.text()).catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
