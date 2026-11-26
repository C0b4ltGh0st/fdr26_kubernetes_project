'use strict';
// Tiny Kubernetes API client (pods only, zero dependencies).
// In a cluster it uses the pod's ServiceAccount token + CA.
// KUBE_API_URL / KUBE_NAMESPACE override this for local development (see dev/).

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const override = process.env.KUBE_API_URL;

const namespace = process.env.KUBE_NAMESPACE || (() => {
  try { return fs.readFileSync(`${SA}/namespace`, 'utf8').trim(); } catch { return 'default'; }
})();

function apiBase() {
  if (override) return new URL(override);
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT || '443';
  if (!host) throw new Error('not running inside a cluster (KUBERNETES_SERVICE_HOST is not set)');
  return new URL(`https://${host.includes(':') ? `[${host}]` : host}:${port}`);
}

function request(method, pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = apiBase(); } catch (e) { return reject(e); }
    const secure = base.protocol === 'https:';
    const headers = { Accept: 'application/json' };
    const opts = { method, headers, timeout: 10000 };
    if (!override) {
      headers.Authorization = `Bearer ${fs.readFileSync(`${SA}/token`, 'utf8').trim()}`; // token rotates, re-read
      if (secure) opts.ca = fs.readFileSync(`${SA}/ca.crt`);
    }
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = (secure ? https : http).request(new URL(pathAndQuery, base), opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const err = new Error(`${method} ${pathAndQuery.split('?')[0]} -> ${res.statusCode} ${json?.message || text.slice(0, 200)}`);
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Kubernetes API timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const PODS = `/api/v1/namespaces/${namespace}/pods`;
const sel = (s) => `labelSelector=${encodeURIComponent(s)}`;

module.exports = {
  namespace,
  getPod: (name) => request('GET', `${PODS}/${encodeURIComponent(name)}`),
  listPods: (selector) => request('GET', `${PODS}?${sel(selector)}`),
  createPod: (spec) => request('POST', PODS, spec),
  deletePods: (selector) => request('DELETE', `${PODS}?${sel(selector)}`),
};
