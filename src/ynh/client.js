// -----------------------------------------------------------------------------
// The administration API of one YunoHost server, as its web admin calls it
// (documented in the developer docs: every route of the actionsmap is served
// under https://<server>/yunohost/api; this code only calls it, nothing of
// YunoHost, AGPL, is copied):
//
//   POST /login  {"credentials": "<user>:<password>"}  -> 200, cookie yunohost.admin
//   then every request carries that cookie and `X-Requested-With`
//   GET  /versions                      (main: a reading needs it; it says "YunoHost")
//   GET  /update                        the lists kept by YunoHost (no refresh)
//   GET  /services                      every service and its systemd state
//   GET  /diagnosis                     the last diagnosis (twice a day by YunoHost)
//   GET  /backups, /backups/<newest>    the local archives, the date of the newest
//   PUT  /upgrade/system | /upgrade/apps, POST /backups, PUT /services/<name>/restart
//                                       the actions, each behind its option
//
// One request at a time for a reading (sequential), each on its own
// connection. The session cookie is kept and used again; a route refusing it
// (401) opens a new session once in the same reading. Only the login route
// can refuse the credentials (401 there): a 401 or a 403 elsewhere, an
// unreadable or cut answer, are never a refusal of the credentials. A login
// is never sent while `loginGate()` throws (the app keeps fail2ban away).
//
// The password and the cookie only go into the request; never into a log, an
// error message or /data, and only on a connection whose certificate was
// checked first (src/ynh/http.js).
// -----------------------------------------------------------------------------

import { API_PREFIX, LIMITS, TIMEOUTS } from '../constants.js';
import { CODES, YnhError, isFinal } from './errors.js';
import { ynhRequest } from './http.js';
import {
  parseBackupCreated,
  parseBackupInfo,
  parseBackups,
  parseDiagnosis,
  parseService,
  parseServices,
  parseUpdates,
  parseVersions,
} from './parse.js';

/** The session cookie we send back: a JWT (base64url and dots), bounded. */
const TOKEN = /^[A-Za-z0-9_\-.]{16,2048}$/;
const COOKIE = 'yunohost.admin';

export const PATHS = Object.freeze({
  LOGIN: '/login',
  VERSIONS: '/versions',
  UPDATES: '/update',
  SERVICES: '/services',
  DIAGNOSIS: '/diagnosis',
  BACKUPS: '/backups',
  UPGRADE_SYSTEM: '/upgrade/system',
  UPGRADE_APPS: '/upgrade/apps',
});

/** The secondary parts of a reading, in their order. */
export const SECONDARY = Object.freeze(['updates', 'services', 'diagnosis', 'backups']);

/** The Retry-After of an answer, in ms (seconds only), or undefined. */
function retryAfterOf(headers) {
  const value = headers?.['retry-after'];
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Number(value.trim()) * 1000;
}

function jsonOf(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new YnhError(CODES.BAD_ANSWER, 'The answer is not JSON');
  }
}

/** The value of the yunohost.admin cookie set by the login, or null. */
export function cookieOf(headers) {
  const raw = headers?.['set-cookie'];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  for (const line of list.slice(0, 16)) {
    if (typeof line !== 'string' || line.length > 4096) continue;
    const first = line.split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq < 0 || first.slice(0, eq).trim() !== COOKIE) continue;
    const value = first
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (TOKEN.test(value)) return value;
  }
  return null;
}

export class YnhClient {
  /**
   * @param {object} options
   * @param {string} options.host
   * @param {number} options.port
   * @param {string} options.username
   * @param {string} options.password
   * @param {(fingerprint: string, authorized: boolean, why?: unknown) => Promise<void>|void} options.checkPeer
   * @param {() => void} [options.loginGate] throws a LOGIN_GATE YnhError when no login may be sent
   * @param {(status: number) => void} [options.onLogin] the outcome of each login sent (200, 401...)
   * @param {Function} [options.request] the transport (tests inject a fake server)
   */
  constructor({
    host,
    port,
    username,
    password,
    checkPeer,
    loginGate = () => {},
    onLogin = () => {},
    request = ynhRequest,
  }) {
    this.target = { host, port };
    this.username = username;
    this.password = password;
    this.checkPeer = checkPeer;
    this.loginGate = loginGate;
    this.onLogin = onLogin;
    this.request = request;
    /** The cookie of the open session, or null. */
    this.token = null;
    /** Secondary parts failing: name -> { fails, skip }. */
    this.spacing = new Map();
    /** The date of the newest archive, read once per archive: { name, at }. */
    this.backupDate = null;
    /** Cuts every reading request in flight and refuses the next ones (a stop, a new session). */
    this.controller = new AbortController();
    this.signal = this.controller.signal;
  }

  close() {
    this.token = null;
    this.controller.abort();
  }

  async send(method, path, { headers, body, timeLeft, beforeSend, maxBytes, signal }) {
    // The signal of the reading (cut by a stop or a new session), unless the action brings its own.
    signal ??= this.signal;
    if (signal?.aborted) throw new YnhError(CODES.LATE, 'Cut by a stop', { notSent: true });
    const left = timeLeft();
    if (!(left > 0)) throw new YnhError(CODES.LATE, 'No time left', { notSent: true });
    return this.request(
      { ...this.target, method, path: `${API_PREFIX}${path}` },
      {
        headers: { 'x-requested-with': 'XMLHttpRequest', ...headers },
        body,
        maxBytes: maxBytes ?? LIMITS.ANSWER_BYTES,
        timeout: Math.max(1, Math.min(left, TIMEOUTS.ACTION_MS)),
        checkPeer: this.checkPeer,
        beforeSend,
        signal,
      },
    );
  }

  /** An answer that is not a success: the matching YnhError. */
  static failure(res) {
    const status = res.status;
    if (status >= 300 && status < 400) {
      return new YnhError(CODES.REDIRECT, `Redirected (HTTP ${status})`, { status });
    }
    if (status === 403) {
      return new YnhError(CODES.FORBIDDEN, 'Refused by the server (HTTP 403)', { status });
    }
    return new YnhError(CODES.HTTP, `HTTP ${status}`, {
      status,
      retryAfterMs: retryAfterOf(res.headers),
    });
  }

  /** Opens a session. Throws CODES.CREDENTIALS on a 401 of the login route only. */
  async login(timeLeft) {
    this.token = null;
    // Never a login while a refusal is fresh (fail2ban): nothing sent.
    this.loginGate();
    const body = JSON.stringify({ credentials: `${this.username}:${this.password}` });
    const res = await this.send('POST', PATHS.LOGIN, {
      // Exactly `application/json`: the API reads the body as JSON only then.
      headers: { 'content-type': 'application/json' },
      body,
      timeLeft: () => Math.min(timeLeft(), TIMEOUTS.REQUEST_MS),
      // The gate again, right before the first byte (a refusal by another path meanwhile).
      beforeSend: () => this.loginGate(),
    });
    this.onLogin(res.status);
    if (res.status === 401) {
      throw new YnhError(CODES.CREDENTIALS, 'Login refused (HTTP 401)', { status: 401 });
    }
    if (res.status !== 200) throw YnhClient.failure(res);
    const token = cookieOf(res.headers);
    if (!token) throw new YnhError(CODES.BAD_ANSWER, 'No session cookie');
    this.token = token;
  }

  authHeaders() {
    return { cookie: `${COOKIE}=${this.token}` };
  }

  /**
   * GET a route of the API, its JSON. Opens a session when none is open; a
   * session refused (401) by the main route is opened again once per reading
   * (`ctx.fresh`). A secondary route refusing it (401) once the main route
   * accepted it in this reading opens no session and keeps the cookie: that
   * part is "not read", never a refusal of the credentials.
   */
  async get(path, ctx, timeLeft, { secondary = false } = {}) {
    if (!this.token) {
      await this.login(timeLeft);
      ctx.fresh = true;
    }
    for (;;) {
      const res = await this.send('GET', path, {
        headers: this.authHeaders(),
        timeLeft: () => Math.min(timeLeft(), TIMEOUTS.REQUEST_MS),
      });
      if (res.status === 401 && secondary) {
        throw new YnhError(CODES.ACCESS, 'Route refused (HTTP 401)', { status: 401 });
      }
      if (res.status === 401 && !ctx.fresh) {
        // The session expired (3 days without use, or the server restarted it): a new one, once.
        await this.login(timeLeft);
        ctx.fresh = true;
        continue;
      }
      if (res.status === 401) {
        this.token = null;
        throw new YnhError(CODES.ACCESS, 'Refused after login (HTTP 401)', { status: 401 });
      }
      if (res.status !== 200) throw YnhClient.failure(res);
      return jsonOf(res.body);
    }
  }

  /**
   * One reading. /versions is needed (its failure fails the reading); the
   * updates, the services, the diagnosis and the backups are read when they
   * answer, never blocking (`missing` lists the ones that did not). A part
   * that fails is asked again 1, 2, 4... readings later (`maxSkip` readings
   * skipped at most), an answer resetting it. A failure that stops
   * everything (certificate, login refused) is never swallowed.
   */
  async read({ timeLeft, maxSkip = Infinity }) {
    const ctx = { fresh: false };
    const versions = parseVersions(await this.get(PATHS.VERSIONS, ctx, timeLeft));
    const missing = [];
    const part = async (name, fn) => {
      const spacing = this.spacing.get(name);
      if (spacing && spacing.skip > 0) {
        spacing.skip -= 1;
        missing.push(name);
        return null;
      }
      try {
        const answer = await fn();
        this.spacing.delete(name);
        return answer;
      } catch (err) {
        if (isFinal(err) || err?.code === CODES.LOGIN_GATE) throw err;
        const fails = (spacing?.fails ?? 0) + 1;
        this.spacing.set(name, { fails, skip: Math.min(2 ** (fails - 1) - 1, maxSkip) });
        missing.push(name);
        return null;
      }
    };
    const get = (path) => this.get(path, ctx, timeLeft, { secondary: true });
    const updates = await part('updates', async () => parseUpdates(await get(PATHS.UPDATES)));
    const services = await part('services', async () => parseServices(await get(PATHS.SERVICES)));
    const diagnosis = await part('diagnosis', async () =>
      parseDiagnosis(await get(PATHS.DIAGNOSIS)),
    );
    const backups = await part('backups', async () => {
      const list = parseBackups(await get(PATHS.BACKUPS));
      let newestAt = null;
      if (list.newest) {
        if (this.backupDate?.name === list.newest) {
          newestAt = this.backupDate.at;
        } else {
          // The date of an archive never changes: read once per newest archive.
          newestAt = parseBackupInfo(await get(`${PATHS.BACKUPS}/${list.newest}`));
          if (newestAt !== null) this.backupDate = { name: list.newest, at: newestAt };
        }
      }
      return { count: list.count, newestAt, newest: list.newest };
    });
    return { version: versions.version, updates, services, diagnosis, backups, missing };
  }

  /** The main route only (the session works, the server is a YunoHost), for the fresh read of an action. */
  async check({ timeLeft }) {
    return parseVersions(await this.get(PATHS.VERSIONS, { fresh: false }, timeLeft));
  }

  /** One service, for the fresh read of a restart and its follow-up: parsed, or null when unknown. */
  async service(name, { timeLeft }) {
    try {
      return parseService(
        await this.get(`${PATHS.SERVICES}/${encodeURIComponent(name)}`, { fresh: false }, timeLeft),
      );
    } catch (err) {
      // YunoHost answers 400 for a service it does not know.
      if (err?.code === CODES.HTTP && err.status === 400) return null;
      throw err;
    }
  }

  /**
   * One action, on the session of the fresh read just before. One request,
   * never retried. `beforeSend` runs right before it is written. Resolves
   * { status, json } of a 2xx; throws a YnhError otherwise.
   */
  async action(kind, { timeLeft, beforeSend, signal, service }) {
    if (!this.token) throw new YnhError(CODES.ACCESS, 'No session', { notSent: true });
    let method = 'PUT';
    let path;
    let body;
    const headers = { ...this.authHeaders() };
    if (kind === 'upgrade_system') path = PATHS.UPGRADE_SYSTEM;
    else if (kind === 'upgrade_apps') path = PATHS.UPGRADE_APPS;
    else if (kind === 'restart') path = `${PATHS.SERVICES}/${encodeURIComponent(service)}/restart`;
    else if (kind === 'backup') {
      method = 'POST';
      path = PATHS.BACKUPS;
      // Everything (every app, every system part), as the web admin's default.
      body = 'description=Gladys';
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else throw new YnhError(CODES.BAD_ANSWER, 'Unknown action', { notSent: true });
    const res = await this.send(method, path, {
      headers,
      body,
      timeLeft,
      beforeSend,
      signal,
      maxBytes: LIMITS.ACTION_BYTES,
    });
    if (res.status === 401) {
      this.token = null;
      throw new YnhError(CODES.ACCESS, 'Action refused (HTTP 401)', { status: 401 });
    }
    if (res.status < 200 || res.status >= 300) throw YnhClient.failure(res);
    let json = null;
    if (res.body.length > 0) {
      try {
        json = JSON.parse(res.body.toString('utf8'));
      } catch {
        json = null;
      }
    }
    return {
      status: res.status,
      json,
      archive: kind === 'backup' ? parseBackupCreated(json) : null,
    };
  }
}
