// -----------------------------------------------------------------------------
// Node's real verdict on certificates, on loopback: a test "public" authority
// added to Node's default trust store (tls.setDefaultCACertificates, put back
// in t.after), its leaves for `localhost` and 127.0.0.1, one for another
// name, one expired, and a self-signed one (test/fixtures/certs, test keys
// only). Then the app on that real transport: a public certificate accepted
// unpinned and renewed; one that stops verifying stops everything, nothing
// sent nor learned.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import tls from 'node:tls';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { YnhApp, unverifiedOf } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { ynhRequest } from '../src/ynh/http.js';
import * as F from './fixtures/ynh.js';

const pem = (name) => readFileSync(new URL(`./fixtures/certs/${name}`, import.meta.url), 'utf8');
const pair = (name) => ({ key: pem(`${name}.key`), cert: pem(`${name}.crt`) });
const supported = typeof tls.setDefaultCACertificates === 'function';

function trustTestAuthority(t) {
  const before = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...before, pem('ca.crt')]);
  t.after(() => tls.setDefaultCACertificates(before));
}

/** A YunoHost on loopback with the certificate `name`; `requests` counts what it received. */
async function server(t, name) {
  const requests = [];
  const srv = createServer(pair(name), (req, res) => {
    requests.push(req.url);
    if (req.url === '/yunohost/api/login') {
      res.writeHead(200, { 'set-cookie': `yunohost.admin=${F.TOKEN}; Path=/yunohost/api` });
      res.end('Logged in');
      return;
    }
    const routes = {
      '/yunohost/api/versions': F.versions(),
      '/yunohost/api/update': F.updates(),
      '/yunohost/api/services': F.services(),
      '/yunohost/api/diagnosis': F.diagnosis(),
      '/yunohost/api/backups': F.backups(),
      '/yunohost/api/backups/20261108-020000': F.backupInfo(),
    };
    res.writeHead(routes[req.url] ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(routes[req.url] ?? {}));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        srv.closeAllConnections?.();
        srv.close(resolve);
      }),
  );
  return { srv, port: srv.address().port, requests, use: (n) => srv.setSecureContext(pair(n)) };
}

async function verdict(host, port) {
  let seen;
  await ynhRequest(
    { host, port, method: 'GET', path: '/yunohost/api/versions' },
    {
      timeout: 5000,
      maxBytes: 100_000,
      checkPeer: (fingerprint, authorized, why) => {
        seen = { authorized, why: unverifiedOf(why) };
        throw Object.assign(new Error('stop here'), { code: 'test' });
      },
    },
  ).catch((err) => {
    if (err.code !== 'test') throw err;
  });
  return seen;
}

test(
  'Node verifies: the name typed (DNS or IP) passes; another name, expired, self-signed do not',
  { skip: !supported },
  async (t) => {
    trustTestAuthority(t);
    const s = await server(t, 'leaf1');
    assert.deepEqual(await verdict('localhost', s.port), { authorized: true, why: 'authority' });
    assert.equal((await verdict('127.0.0.1', s.port)).authorized, true, 'an IP in the SAN');
    s.use('wrong');
    assert.deepEqual(await verdict('localhost', s.port), { authorized: false, why: 'name' });
    s.use('expired');
    assert.deepEqual(await verdict('localhost', s.port), { authorized: false, why: 'expired' });
    s.use('self');
    assert.deepEqual(await verdict('localhost', s.port), { authorized: false, why: 'authority' });
    assert.deepEqual(s.requests, [], 'not a byte of a request');
  },
);

test(
  'the app on real TLS: public accepted unpinned and renewed; another name stops everything, nothing learned',
  { skip: !supported },
  async (t) => {
    trustTestAuthority(t);
    const s = await server(t, 'leaf1');
    const gladys = createFakeGladys({ selector: 'yunohost', config: {} });
    await gladys.connect();
    const quiet = () => {};
    const store = memoryStore();
    const app = new YnhApp({
      gladys,
      logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
      store,
    });
    t.after(() => app.stop());
    const readNow = async () => {
      await app.idle();
      app.followUpDue = app.monotonic();
      await app.tick();
    };
    await app.start({
      host: `localhost:${s.port}`,
      username: F.USERNAME,
      password: F.PASSWORD,
      poll_interval: '60',
    });
    await readNow();
    const key = `https://localhost:${s.port}`;
    assert.equal(
      gladys.fake.connectionStatus.connected,
      true,
      JSON.stringify(gladys.fake.connectionStatus),
    );
    assert.equal(store.data.pins[key], undefined, 'never pinned');
    assert.deepEqual(store.data.publicKeys, [key]);
    // A renewal: another key, still verified.
    s.use('leaf2');
    await readNow();
    assert.equal(gladys.fake.connectionStatus.connected, true);
    // Another name (a certificate of the authority for another domain): stopped.
    s.use('wrong');
    const before = s.requests.length;
    await readNow();
    assert.equal(s.requests.length, before, 'nothing sent to it');
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.match(
      gladys.fake.connectionStatus.message.en,
      /no longer verifies \(made out to another name/,
    );
    assert.equal(store.data.pins[key], undefined, 'never pinned silently');
    assert.equal(store.data.certChanged.why, 'name');
  },
);
