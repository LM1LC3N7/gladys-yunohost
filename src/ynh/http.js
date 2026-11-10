// -----------------------------------------------------------------------------
// The only network access of the integration: one HTTPS request to the
// YunoHost server, on node:https. A deadline for the whole exchange, a size
// cap on the body (counted while it arrives, the connection cut beyond it), no
// redirect followed (the password and the session never go anywhere else), no
// connection reused (`agent: false`, and never a custom `createConnection`:
// Node would then ignore it and open a second socket).
//
// Node verifies the certificate as usual (the chain up to a public authority
// of its trust store, and the name typed: `checkServerIdentity`), and gives
// the verdict in `socket.authorized`; the handshake is not cut by it
// (`rejectUnauthorized: false`) because a YunoHost reached by its local
// address presents a self-signed certificate, or one made out to a domain
// that is not the address typed, which the app pins instead. Right after the
// TLS handshake and BEFORE a single byte of the request (password, session
// cookie) is written, `checkPeer(fingerprint, authorized)` (async) decides,
// and may take its time (the app writes a first pin to /data there). Then `beforeSend()` runs, the very last check of an action. What
// either throws is rethrown marked `notSent`. `signal` (an AbortSignal) cuts
// the exchange (a stop during a long action).
//
// Resolves { status, headers, body } for any status; rejects a YnhError for
// the transport failures, whose message never holds the address (Node's
// messages do).
// -----------------------------------------------------------------------------

import https from 'node:https';
import { isIP } from 'node:net';
import { USER_AGENT } from '../constants.js';
import { CODES, YnhError } from './errors.js';

function transportError(err, sent) {
  const code = String(err?.code ?? '');
  const text = String(err?.message ?? '').toLowerCase();
  if (code === 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' || text.includes('handshake failure')) {
    return new YnhError(CODES.TLS, 'TLS handshake refused', { notSent: !sent });
  }
  // Something answered, but not in HTTP or TLS (a wrong port, the wrong protocol).
  if (code.startsWith('HPE_') || code === 'EPROTO' || code.startsWith('ERR_SSL')) {
    return new YnhError(CODES.BAD_ANSWER, `Not the expected protocol (${code})`, {
      notSent: !sent,
    });
  }
  return new YnhError(
    CODES.UNREACHABLE,
    /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'Connection failed',
    { notSent: !sent },
  );
}

/**
 * @param {{ host: string, port: number, method: string, path: string }} target
 * @param {object} options
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} options.maxBytes body size cap
 * @param {(fingerprint: string, authorized: boolean) => Promise<void>|void} options.checkPeer
 * @param {() => void} [options.beforeSend]
 * @param {AbortSignal} [options.signal]
 */
export function ynhRequest(
  { host, port, method, path },
  { headers = {}, body, timeout, maxBytes, checkPeer, beforeSend, signal } = {},
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let early = false;
    let req = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) {
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new YnhError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`, {
            notSent: !sent,
          }),
        ),
      timeout,
    );
    const onAbort = () => finish(new YnhError(CODES.LATE, 'Cut by a stop', { notSent: !sent }));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    /** The connection is up and its TLS done: the certificate, the last checks, then the request. */
    const ready = async (socket) => {
      if (settled) return;
      try {
        const fingerprint = socket.getPeerCertificate?.()?.fingerprint256 ?? null;
        if (!fingerprint) throw new YnhError(CODES.BAD_ANSWER, 'No certificate');
        if (typeof checkPeer !== 'function') {
          throw new YnhError(CODES.BAD_ANSWER, 'No certificate check');
        }
        // Node's own verdict: a valid chain to a public authority AND the name typed.
        await checkPeer(fingerprint, socket.authorized === true);
        if (settled) return;
        if (early) throw new YnhError(CODES.BAD_ANSWER, 'Answer before the request');
        beforeSend?.();
      } catch (err) {
        finish(Object.assign(err, { notSent: true }));
        return;
      }
      sent = true;
      req.end(body);
    };

    try {
      const bare = host.replace(/^\[(.*)\]$/, '$1');
      const options = {
        method,
        host: bare,
        port,
        path,
        agent: false,
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
          ...headers,
        },
      };
      // Verified by Node all the same (socket.authorized); a failure is decided above.
      options.rejectUnauthorized = false;
      if (!isIP(bare)) options.servername = bare;
      req = https.request(options, (res) => {
        // An answer before the request was written (the peer spoke first,
        // while its certificate was still being checked): never accepted.
        if (!sent) {
          early = true;
          res.resume();
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          finish(new YnhError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new YnhError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('aborted', () =>
          finish(new YnhError(CODES.BAD_ANSWER, 'Answer cut', { notSent: false })),
        );
        res.on('error', (err) => finish(transportError(err, sent)));
      });
      req.on('socket', (socket) => socket.once('secureConnect', () => ready(socket)));
      req.on('error', (err) => finish(transportError(err, sent)));
    } catch (err) {
      // request() throws synchronously on a value it refuses: a failure,
      // never a crash.
      finish(transportError(err, false));
    }
  });
}
