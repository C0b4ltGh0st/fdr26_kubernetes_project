'use strict';
// All game settings come from environment variables. In the cluster they are
// injected from the ConfigMap that kustomize generates out of the .env file.

const warn = (m) => console.warn(`[config] ${m}`);

function int(name, def, lo, hi) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v)) { warn(`${name}="${raw}" is not a number, using ${def}`); return def; }
  const c = Math.max(lo, Math.min(hi, v));
  if (c !== v) warn(`${name}=${v} is outside ${lo}–${hi}, using ${c}`);
  return c;
}

module.exports = Object.freeze({
  SNAKE_COUNT: int('SNAKE_COUNT', 8, 1, 20),
  MAX_FOOD: int('MAX_FOOD', 6, 1, 50),
  MAX_DEATHS: int('MAX_DEATHS', 5, 1, 20),
  TICK_MS: int('TICK_MS', 240, 50, 2000),
  START_TIMEOUT_SECONDS: int('START_TIMEOUT_SECONDS', 30, 1, 600),
  PORT: int('PORT', 8080, 1, 65535),
  // Where snake pods reach the arena (the Service name inside the namespace).
  ARENA_URL: process.env.ARENA_URL || 'http://snake-arena',
  // Optional. By default snake pods use the same image as the arena pod.
  SNAKE_IMAGE: process.env.SNAKE_IMAGE || '',
});
