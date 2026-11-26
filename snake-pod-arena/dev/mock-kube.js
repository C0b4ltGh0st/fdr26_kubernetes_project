'use strict';
// Run the whole project WITHOUT Kubernetes:  make dev   ->  http://localhost:8080
//
// Starts a tiny fake of the Kubernetes pod API and the real arena (src/arena.js),
// pointed at that fake. Every "pod" the arena creates becomes a real `node src/snake.js`
// child process, with a pod lifecycle (ContainerCreating -> Running -> Completed / Error).
// Settings are read from ../.env, just like the ConfigMap would provide them.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const API_PORT = Number(process.env.MOCK_API_PORT || 18080);
const ARENA_PORT = Number(process.env.PORT || 8080);
const NS = 'snake-arena';
const SELF = 'snake-arena-dev';

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2];
  }
  return env;
}

const pods = new Map(); // name -> { obj, proc }
const matches = (obj, selector) => !selector || selector.split(',').every((kv) => {
  const [k, v] = kv.split('=');
  return obj.metadata.labels?.[k] === v;
});

function launch(spec) {
  const name = spec.metadata.name;
  const obj = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, namespace: NS, uid: `uid-${name}`, labels: spec.metadata.labels, creationTimestamp: new Date().toISOString() },
    spec: spec.spec,
    status: { phase: 'Pending', containerStatuses: [{ name: 'snake', state: { waiting: { reason: 'ContainerCreating' } } }] },
  };
  const entry = { obj, proc: null };
  pods.set(name, entry);

  setTimeout(() => {
    if (!pods.has(name)) return;
    const env = { ...process.env };
    for (const e of spec.spec.containers[0].env || []) env[e.name] = e.value;
    env.ARENA_URL = `http://127.0.0.1:${ARENA_PORT}`;
    const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'snake.js')], { env, stdio: ['ignore', 'inherit', 'inherit'] });
    entry.proc = proc;
    obj.status = { phase: 'Running', containerStatuses: [{ name: 'snake', state: { running: {} } }] };
    proc.on('exit', (code) => {
      if (!pods.has(name) || obj.metadata.deletionTimestamp) return;
      obj.status = code === 0
        ? { phase: 'Succeeded', containerStatuses: [{ name: 'snake', state: { terminated: { exitCode: 0, reason: 'Completed' } } }] }
        : { phase: 'Failed', containerStatuses: [{ name: 'snake', state: { terminated: { exitCode: code, reason: 'Error' } } }] };
    });
  }, 700);
}

function remove(name) {
  const e = pods.get(name);
  if (!e) return false;
  pods.delete(name);
  e.proc?.kill('SIGTERM');
  return true;
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const base = `/api/v1/namespaces/${NS}/pods`;
  const sel = url.searchParams.get('labelSelector') || '';
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (url.pathname === `${base}/${SELF}` && req.method === 'GET') {
      return json(res, 200, { metadata: { name: SELF, uid: 'uid-arena-dev' }, spec: { containers: [{ image: 'afkproficoder/snake-pod-arena:latest', imagePullPolicy: 'IfNotPresent' }] } });
    }
    if (url.pathname === base && req.method === 'GET') {
      return json(res, 200, { items: [...pods.values()].map((p) => p.obj).filter((o) => matches(o, sel)) });
    }
    if (url.pathname === base && req.method === 'POST') {
      const spec = JSON.parse(body);
      if (pods.has(spec.metadata.name)) return json(res, 409, { message: 'already exists' });
      launch(spec);
      return json(res, 201, spec);
    }
    if (url.pathname === base && req.method === 'DELETE') {
      for (const [n, p] of [...pods]) if (matches(p.obj, sel)) remove(n);
      return json(res, 200, { kind: 'PodList', items: [] });
    }
    if (url.pathname.startsWith(`${base}/`) && req.method === 'DELETE') {
      return remove(decodeURIComponent(url.pathname.slice(base.length + 1))) ? json(res, 200, {}) : json(res, 404, { message: 'not found' });
    }
    json(res, 404, { message: `mock: ${req.method} ${url.pathname}` });
  });
});

api.listen(API_PORT, '127.0.0.1', () => {
  console.log(`[dev] fake Kubernetes API on :${API_PORT}`);
  const arena = spawn(process.execPath, [path.join(ROOT, 'src', 'arena.js')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...loadEnv(path.join(ROOT, '.env')),
      KUBE_API_URL: `http://127.0.0.1:${API_PORT}`, KUBE_NAMESPACE: NS, HOSTNAME: SELF,
      PORT: String(ARENA_PORT), ARENA_URL: `http://127.0.0.1:${ARENA_PORT}`,
    },
  });
  console.log(`[dev] open http://localhost:${ARENA_PORT}  (press Start)`);
  const bye = () => { for (const n of [...pods.keys()]) remove(n); arena.kill('SIGTERM'); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  arena.on('exit', () => bye());
});
