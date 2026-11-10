// -----------------------------------------------------------------------------
// A fake YunoHost server in memory: the transport of src/ynh/http.js, with the
// same contract (checkPeer awaited, then beforeSend, then the request is
// "written"; a failure there marks the error notSent; `signal` cuts it).
// Every request the server received is recorded in `sent`, every connection
// in `connections`. The actions answer when the test says so (`finish`).
// -----------------------------------------------------------------------------

import { API_PREFIX } from '../../src/constants.js';
import { CODES, YnhError } from '../../src/ynh/errors.js';
import * as F from '../fixtures/ynh.js';

export const FINGERPRINT =
  'AA:11:BB:22:CC:33:DD:44:EE:55:FF:66:00:77:11:88:22:99:33:AA:44:BB:55:CC:66:DD:77:EE:88:FF:99:00';
export const OTHER_FINGERPRINT =
  '0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0:0F:1E:2D:3C:4B:5A:69:78:87:96:A5:B4:C3:D2:E1:F0';

const json = (value, status = 200, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(JSON.stringify(value)),
});
const plain = (status, text = '') => ({ status, headers: {}, body: Buffer.from(text) });

export function createFakeServer({
  fingerprint = FINGERPRINT,
  username = F.USERNAME,
  password = F.PASSWORD,
} = {}) {
  const srv = {
    fingerprint,
    username,
    password,
    version: '12.1.41.2',
    updates: F.updates(),
    services: F.services(),
    diagnosis: F.diagnosis(),
    backups: F.backups(),
    backupInfo: F.backupInfo(),
    /** 'down' | 'timeout' | null */
    state: null,
    /** path (without the API prefix) -> { response, times } forced once or always. */
    overrides: new Map(),
    sessions: new Set(),
    connections: 0,
    sent: [],
    logins: 0,
    /** The actions received, each { kind, entry, finish(response) }; `autoFinish` answers at once. */
    actions: [],
    autoFinish: null,
    /** Called with each request before it is answered (a test may await there). */
    hook: null,
    /** Called before the connection is up (a slow TCP or TLS handshake). */
    connectHook: null,
    override(path, response, times = Infinity) {
      srv.overrides.set(path, { response, times });
    },
    expireSessions() {
      srv.sessions.clear();
    },
    count(path, method) {
      return srv.sent.filter((r) => r.path === path && (!method || r.method === method)).length;
    },
    async request(target, options) {
      srv.connections += 1;
      // A slow handshake, cut by the signal as the real transport does.
      const hook = srv.connectHook?.(target);
      if (hook) {
        await new Promise((resolve, reject) => {
          const onAbort = () =>
            reject(new YnhError(CODES.LATE, 'Cut by a stop', { notSent: true }));
          if (options.signal?.aborted) return onAbort();
          options.signal?.addEventListener('abort', onAbort, { once: true });
          Promise.resolve(hook).then(resolve, reject);
          return undefined;
        });
      }
      if (srv.state === 'down') {
        throw new YnhError(CODES.UNREACHABLE, 'ECONNREFUSED', { notSent: true });
      }
      if (options.signal?.aborted) {
        throw new YnhError(CODES.LATE, 'Cut by a stop', { notSent: true });
      }
      try {
        await options.checkPeer(srv.fingerprint);
        options.beforeSend?.();
      } catch (err) {
        throw Object.assign(err, { notSent: true });
      }
      if (!target.path.startsWith(`${API_PREFIX}/`)) return plain(404);
      const path = target.path.slice(API_PREFIX.length);
      const entry = {
        method: target.method,
        path,
        headers: { ...options.headers },
        body: options.body,
        timeout: options.timeout,
      };
      srv.sent.push(entry);
      await srv.hook?.(entry);
      if (srv.state === 'timeout') {
        throw new YnhError(CODES.TIMEOUT, 'No answer within 30 s', { notSent: false });
      }
      const forced = srv.overrides.get(path);
      if (forced && forced.times > 0) {
        forced.times -= 1;
        const r = typeof forced.response === 'function' ? forced.response(entry) : forced.response;
        if (r instanceof Error) throw r;
        return {
          status: r.status,
          headers: r.headers ?? {},
          body: Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? '')),
        };
      }
      if (path === '/login' && target.method === 'POST') {
        srv.logins += 1;
        if (options.headers['content-type'] !== 'application/json') return plain(400);
        const { credentials } = JSON.parse(options.body);
        const i = credentials.indexOf(':');
        if (credentials.slice(0, i) !== srv.username || credentials.slice(i + 1) !== srv.password) {
          return plain(401, 'Invalid username or password');
        }
        const t = `${F.TOKEN}${srv.sessions.size}`;
        srv.sessions.add(t);
        return {
          status: 200,
          headers: {
            'set-cookie': [
              `yunohost.admin=${t}; Path=/yunohost/api; Secure; HttpOnly; SameSite=strict`,
            ],
          },
          body: Buffer.from('Logged in'),
        };
      }
      const token = /yunohost\.admin=([^;\s]+)/.exec(options.headers?.cookie ?? '')?.[1];
      if (!token || !srv.sessions.has(token)) return plain(401, 'Authentication required');
      if (target.method !== 'GET' && options.headers['x-requested-with'] !== 'XMLHttpRequest') {
        return plain(403, 'CSRF protection');
      }
      if (target.method === 'GET') {
        if (path === '/versions') return json(F.versions(srv.version));
        if (path === '/update') return json(srv.updates);
        if (path === '/services') return json(srv.services);
        if (path === '/diagnosis') return json(srv.diagnosis);
        if (path === '/backups') return json(srv.backups);
        const one = /^\/services\/([^/]+)$/.exec(path);
        if (one) {
          const info = srv.services[decodeURIComponent(one[1])];
          return info ? json(info) : json({ error: 'Unknown service' }, 400);
        }
        if (/^\/backups\/[^/]+$/.test(path)) return json(srv.backupInfo);
        return plain(404);
      }
      let kind = null;
      if (target.method === 'PUT' && path === '/upgrade/system') kind = 'upgrade_system';
      else if (target.method === 'PUT' && path === '/upgrade/apps') kind = 'upgrade_apps';
      else if (target.method === 'POST' && path === '/backups') kind = 'backup';
      const restart = /^\/services\/([^/]+)\/restart$/.exec(path);
      if (target.method === 'PUT' && restart) kind = 'restart';
      if (!kind) return plain(404);
      if (restart && !srv.services[decodeURIComponent(restart[1])]) {
        return json({ error: 'Unknown service' }, 400);
      }
      return new Promise((resolve, reject) => {
        const action = {
          kind,
          entry,
          finish(
            response = kind === 'backup'
              ? json({ name: '20261110-090000', size: 1 }, 201)
              : plain(204),
          ) {
            if (response instanceof Error) reject(response);
            else resolve(response);
          },
        };
        options.signal?.addEventListener(
          'abort',
          () => reject(new YnhError(CODES.LATE, 'Cut by a stop', { notSent: false })),
          { once: true },
        );
        srv.actions.push(action);
        if (srv.autoFinish) action.finish(srv.autoFinish(action));
      });
    },
  };
  srv.request = srv.request.bind(srv);
  return srv;
}
