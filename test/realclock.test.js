// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTPS server playing YunoHost (self-signed certificate, pinned at
// the first contact): the readings really start, at 0, the interval and twice
// the interval, with a bounded number of timers. The time is sped up 200
// times (the 5 min of the interval are 1.5 s) but it is the real clock: it
// moves between any two reads of it. The pace is measured where it is decided
// (a spy on YnhClient#read, the start of a reading), never on the connections
// the server sees. Everything is closed in t.after: a failure never leaves
// the process alive.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { YnhClient } from '../src/ynh/client.js';
import { YnhApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import * as F from './fixtures/ynh.js';
import { selfSigned } from './helpers/selfSigned.js';

const SPEED = 200;
const INTERVAL = 5 * 60_000;

test('real clock: readings at 0, the interval and twice the interval; timers bounded', async (t) => {
  const cert = selfSigned('yunohost');
  const reads = [];
  let answered = 0;
  const original = YnhClient.prototype.read;
  YnhClient.prototype.read = function spy(...args) {
    reads.push(performance.now() * SPEED);
    return original.apply(this, args);
  };
  t.after(() => {
    YnhClient.prototype.read = original;
  });
  const routes = {
    '/yunohost/api/versions': () => F.versions(),
    '/yunohost/api/update': () => F.updates(),
    '/yunohost/api/services': () => F.services(),
    '/yunohost/api/diagnosis': () => F.diagnosis(),
    '/yunohost/api/backups': () => F.backups(),
    '/yunohost/api/backups/20261108-020000': () => F.backupInfo(),
  };
  const server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/yunohost/api/login' && req.method === 'POST') {
        if (JSON.parse(body).credentials !== `${F.USERNAME}:${F.PASSWORD}`) {
          res.writeHead(401).end('Invalid');
          return;
        }
        res.writeHead(200, { 'set-cookie': `yunohost.admin=${F.TOKEN}; Path=/yunohost/api` });
        res.end('Logged in');
        return;
      }
      if (req.headers.cookie !== `yunohost.admin=${F.TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/yunohost/api/versions') answered += 1;
      const route = routes[req.url];
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(route()));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  const { port } = server.address();
  let timersSet = 0;
  const live = new Set();
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      const id = setTimeout(
        () => {
          live.delete(id);
          fn();
        },
        Math.max(0, ms) / SPEED,
      );
      live.add(id);
      return id;
    },
    clearTimeout: (id) => {
      live.delete(id);
      clearTimeout(id);
    },
  };
  const gladys = createFakeGladys({ selector: 'yunohost', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const store = memoryStore();
  const app = new YnhApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store,
  });
  t.after(async () => {
    await app.stop();
    for (const id of live) clearTimeout(id);
  });
  const started = performance.now() * SPEED;
  await app.start({
    host: `127.0.0.1:${port}`,
    username: F.USERNAME,
    password: F.PASSWORD,
    poll_interval: '5',
  });
  const deadline = started + INTERVAL;
  while (reads.length === 0 && performance.now() * SPEED < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const until = (reads[0] ?? started) + 2.5 * INTERVAL;
  while (performance.now() * SPEED < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await app.stop();
  const at = reads.map((r) => Math.round(r - started));
  assert.equal(reads.length, 3, `reads at ${at}`);
  assert.ok(reads[0] - started < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.98 * INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap <= 1.4 * INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 40, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(answered, 3);
  assert.equal(store.data.pins[`https://127.0.0.1:${port}`], cert.fingerprint256);
  assert.equal(live.size, 0, 'no timer left after stop');
});
