// -----------------------------------------------------------------------------
// The transport against real servers on loopback: HTTPS with a self-signed
// certificate like the one of a YunoHost reached by its address (the
// fingerprint checked before a byte of the request is written), one
// connection per request, a size cap counted while the answer arrives, a
// deadline, no redirect followed, a cut by an AbortSignal.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { createServer as createTlsServer } from 'node:tls';
import { createServer as createNetServer } from 'node:net';
import { CODES } from '../src/ynh/errors.js';
import { ynhRequest } from '../src/ynh/http.js';
import { selfSigned, serialOf } from './helpers/selfSigned.js';

const CERT = selfSigned('yunohost');

async function server(handler) {
  const requests = [];
  let connections = 0;
  let bytes = 0;
  const onRequest = (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  };
  const srv = createServer({ key: CERT.key, cert: CERT.cert }, onRequest);
  srv.on('secureConnection', (socket) => {
    connections += 1;
    socket.on('data', (d) => (bytes += d.length));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    port: srv.address().port,
    requests,
    get connections() {
      return connections;
    },
    get bytes() {
      return bytes;
    },
    close: () =>
      new Promise((resolve) => {
        srv.closeAllConnections?.();
        srv.close(resolve);
      }),
  };
}

const target = (port, path = '/yunohost/api/versions', method = 'GET') => ({
  host: '127.0.0.1',
  port,
  method,
  path,
});

test('HTTPS: the fingerprint is checked first, then the request goes; one connection; our own User-Agent', async (t) => {
  const s = await server((req, res) => res.end('{"result":"None"}'));
  t.after(() => s.close());
  const seen = [];
  const verdicts = [];
  const res = await ynhRequest(target(s.port, '/yunohost/api/upgrade/system', 'POST'), {
    body: 'x',
    timeout: 5000,
    maxBytes: 1000,
    checkPeer: async (fingerprint, authorized) => {
      seen.push(fingerprint);
      verdicts.push(authorized);
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [CERT.fingerprint256]);
  assert.deepEqual(verdicts, [false], 'Node does not verify a self-signed certificate');
  assert.equal(s.requests[0].body, 'x');
  assert.match(s.requests[0].headers['user-agent'], /^gladys-yunohost\/\d+\.\d+\.\d+ \(\+https:/);
  assert.doesNotMatch(s.requests[0].headers['user-agent'], /Mozilla|Chrome|Safari/);
  assert.equal(s.connections, 1);
});

test('HTTPS: a certificate refused: not a byte of the request written (password safe)', async (t) => {
  const s = await server((req, res) => res.end('{}'));
  t.after(() => s.close());
  const err = await ynhRequest(target(s.port, '/yunohost/api/login', 'POST'), {
    body: '{"credentials":"camille:secret"}',
    timeout: 5000,
    maxBytes: 1000,
    checkPeer: () => {
      throw Object.assign(new Error('pin'), { code: CODES.CERTIFICATE });
    },
  }).catch((e) => e);
  assert.equal(err.code, CODES.CERTIFICATE);
  assert.equal(err.notSent, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.requests.length, 0);
  assert.equal(s.bytes, 0, 'no application data after the handshake');
});

test('HTTPS without a certificate check is refused, nothing sent', async (t) => {
  const s = await server((req, res) => res.end('{}'));
  t.after(() => s.close());
  const err = await ynhRequest(target(s.port), { timeout: 5000, maxBytes: 1000 }).catch((e) => e);
  assert.equal(err.notSent, true);
  assert.equal(s.requests.length, 0);
});

test('an answer written before the request (impostor), the verdict right after it: never accepted', async (t) => {
  // Deterministic: the peer writes a forged 200 as soon as TLS is up, then
  // releases the verdict on the next turn of the loop. The request may only
  // be written once the bytes already there were read (and refused).
  let release;
  let verdict;
  let received = 0;
  const sockets = new Set();
  const tls = createTlsServer({ key: CERT.key, cert: CERT.cert }, (socket) => {
    sockets.add(socket);
    socket.on('data', (d) => (received += d.length));
    socket.write('HTTP/1.1 200 OK\r\ncontent-length: 17\r\n\r\n{"result":"None"}');
    setImmediate(release);
  });
  await new Promise((resolve) => tls.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        tls.close(resolve);
      }),
  );
  for (let i = 0; i < 20; i += 1) {
    // A verdict of its own per round, released by this round's peer.
    verdict = new Promise((resolve) => (release = resolve));
    const err = await ynhRequest(target(tls.address().port, '/x', 'POST'), {
      body: 'secret',
      timeout: 3000,
      maxBytes: 1000,
      checkPeer: () => verdict,
    }).catch((e) => e);
    assert.ok(err instanceof Error, `round ${i}: the forged answer was taken`);
    assert.equal(err.notSent, true);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received, 0, 'not a byte of the request (nor of the secret) sent');
});

test('the serial number of the test certificates is always a valid DER INTEGER', () => {
  assert.deepEqual([...serialOf([0x00, 0x10, 1, 2])], [0x01, 0x10, 1, 2]);
  assert.deepEqual([...serialOf([0xff, 0])], [0x7f, 0]);
  const c = selfSigned('yunohost', { serial: Buffer.from([0x00, 0x10, 0, 0, 0, 0, 0, 1]) });
  assert.match(c.fingerprint256, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
});

test('beforeSend throwing: nothing sent, marked notSent', async (t) => {
  {
    const s = await server((req, res) => res.end('{}'));
    t.after(() => s.close());
    const err = await ynhRequest(target(s.port, '/x', 'POST'), {
      body: '{}',
      timeout: 5000,
      maxBytes: 1000,
      checkPeer: () => {},
      beforeSend: () => {
        throw new Error('option off');
      },
    }).catch((e) => e);
    assert.equal(err.message, 'option off');
    assert.equal(err.notSent, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(s.requests.length, 0);
  }
});

test('an AbortSignal cuts a long exchange (a stop during an action)', async (t) => {
  const s = await server(() => {});
  t.after(() => s.close());
  const controller = new AbortController();
  const pending = ynhRequest(target(s.port, '/yunohost/api/upgrade/system', 'PUT'), {
    timeout: 60_000,
    maxBytes: 1000,
    checkPeer: () => {},
    signal: controller.signal,
  }).catch((e) => e);
  while (s.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const err = await pending;
  assert.equal(err.code, CODES.LATE);
  assert.equal(err.notSent, false, 'it had left');
  const early = await ynhRequest(target(s.port), {
    timeout: 1000,
    maxBytes: 1000,
    checkPeer: () => {},
    signal: AbortSignal.abort(),
  }).catch((e) => e);
  assert.equal(early.notSent, true);
});

test('size cap: an endless answer is cut while it arrives; a declared size above it too', async (t) => {
  const s = await server((req, res) => {
    if (req.url === '/declared') {
      res.writeHead(200, { 'content-length': '100000' });
      res.write('x');
      return;
    }
    res.writeHead(200);
    const chunk = Buffer.alloc(16 * 1024, 120);
    const pump = () => {
      if (!res.destroyed && res.write(chunk)) setImmediate(pump);
    };
    res.on('drain', pump);
    pump();
  });
  t.after(() => s.close());
  for (const path of ['/endless', '/declared']) {
    const err = await ynhRequest(target(s.port, path, 'GET'), {
      checkPeer: () => {},
      timeout: 5000,
      maxBytes: 64 * 1024,
    }).catch((e) => e);
    assert.equal(err.code, CODES.TOO_LARGE, path);
  }
});

test('deadline: a silent peer (TCP, no TLS) times out; a redirection is returned, never followed', async (t) => {
  const sockets = new Set();
  const hole = createNetServer((socket) => sockets.add(socket));
  await new Promise((resolve) => hole.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        hole.close(resolve);
      }),
  );
  const err = await ynhRequest(target(hole.address().port, '/a', 'GET'), {
    checkPeer: () => {},
    timeout: 200,
    maxBytes: 1000,
  }).catch((e) => e);
  assert.equal(err.code, CODES.TIMEOUT);
  const s = await server((req, res) =>
    res.writeHead(302, { location: 'https://evil.example/' }).end(),
  );
  t.after(() => s.close());
  const res = await ynhRequest(target(s.port, '/a', 'GET'), {
    checkPeer: () => {},
    timeout: 2000,
    maxBytes: 1000,
  });
  assert.equal(res.status, 302);
  assert.equal(s.requests.length, 1);
});

test('unreachable: a refused port, the address never in the message', async () => {
  const srv = createNetServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  const err = await ynhRequest(target(port, '/a', 'GET'), {
    checkPeer: () => {},
    timeout: 2000,
    maxBytes: 1000,
  }).catch((e) => e);
  assert.equal(err.code, CODES.UNREACHABLE);
  assert.doesNotMatch(err.message, /127\.0\.0\.1/);
});
