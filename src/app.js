// -----------------------------------------------------------------------------
// YnhApp: the integration. One YunoHost server, one device.
//
//   start(config)  (re)connects: /data read (bounded in time), the client of
//                  the address and login built, Discovery and the status sent
//                  again, the reading loop armed.
//   reading loop   every `poll_interval` min (15 by default): login when no
//                  session is open, then GET /versions (needed), /update,
//                  /services, /diagnosis and /backups (secondary: a failure
//                  there never blocks) -> version, upgrades waiting, services
//                  down and per service running, diagnosis errors and
//                  warnings, backups and the age of the newest.
//   actions        `button`s, each refused unless allowed in the
//                  configuration: upgrade the system, upgrade the apps (one
//                  option), back up the server (one option), restart a service
//                  (only those listed). The session is read again first, the
//                  option checked again right before the request is written,
//                  one request never retried, a delay between two presses of
//                  the same action (kept in /data, written before the first
//                  byte). An upgrade or a backup runs inside its request (up to
//                  1 h): the press is answered once the request left, the
//                  outcome goes to the "Last action" feature.
//   failures       credentials refused (by the login route only): kept in
//                  /data, never tried again by the loop until the user name
//                  or the password is saved again (the test button tries
//                  once), and no login at all for 5 min, doubling per refusal
//                  in a row (fail2ban bans an address after a few); another
//                  HTTPS certificate than the one pinned: nothing is sent
//                  until the user trusts it (two clicks) or types its
//                  fingerprint; HTTP 429 and 5xx of the main route pause every
//                  request (bounded, kept in /data); anything else is retried,
//                  never faster than the poll interval, doubling up to 1 h.
//
// Pace: never two readings less than an interval apart, whatever asks (a
// reconnection, a save of the form, the test button, a restart of the
// container: the time of the last attempt is kept in /data, written BEFORE
// the request). Only the end of an action, or a certificate just trusted,
// brings one reading forward.
//
// /data: every read and write is bounded in time (5 s). Unreadable or slow at
// start, it is read again on a timer of its own (10 s), one read at a time;
// what was decided in memory meanwhile (a refusal, a pause) is merged, never
// overwritten. While it cannot be read, no certificate is learned and no
// action is sent (its delay could not be kept).
//
// Two clocks: `now` (wall clock) dates what /data keeps and the age of a
// backup; `monotonic` paces the readings, the retries, the pauses, the login
// gate and the delays between actions, so that a wall clock set back or
// forward never stops nor hurries them. One read of the clock per decision:
// dueAt(mono) computes on the caller's instant. One timer at a time for the
// loop.
//
// A reading belongs to its session (the client of one address and login):
// when they change, a late answer of the old one publishes nothing and sets
// no status (checked after every await). Neither the password nor the session
// cookie is ever logged, published or written to /data.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { YnhClient } from './ynh/client.js';
import { CODES, YnhError, isFinal, isPause } from './ynh/errors.js';
import { normalizeConfig, targetKey } from './config.js';
import { COMMAND, FEATURES, INTERVALS, PRESSED, TIMEOUTS } from './constants.js';
import { buildServerDevice, createdServer, featureOf, statesOf } from './devices.js';
import { ACTION_NAMES, T, join, reasonOf } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory, prunePins, serializeMemory } from './store.js';

/** The "Test the connection" button waits 30 s: answer before. */
const TEST_BUDGET_MS = 28_000;
const defaultTimers = { setTimeout, clearTimeout };
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const hmac = (salt, value) => createHmac('sha256', salt).update(value).digest('hex');
/**
 * 8 bits of an HMAC of a refused password: a marker, never enough to tell a
 * password (1 password in 256 shares it). Saving the configuration always
 * tries the password saved, once, whatever its marker.
 */
export const refusalTag = (salt, password) => hmac(salt, `refused|${password}`).slice(0, 2);

/** An error for Gladys, with its cause kept (never shown). */
const userError = (message, cause) =>
  Object.assign(new Error(message, cause ? { cause } : undefined), { user: true });

/** The key of an action in the delays kept in /data. */
const cooldownKey = (kind, service) => (kind === 'restart' ? `restart:${service}` : kind);
const whatOf = (kind, service) =>
  kind === 'restart' ? `${ACTION_NAMES.restart} ${service}` : ACTION_NAMES[kind];

export class YnhApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the transport (tests inject a fake server)
   * @param {() => number} [options.now] wall clock (ms)
   * @param {() => number} [options.monotonic] monotonic clock (ms)
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {{ load: Function, save: Function }} [options.store] /data
   * @param {(size: number) => Buffer} [options.random]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'yunohost' }),
    request,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = fileStore(),
    random,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.random = random;
    this.publisher = new StatePublisher({ gladys, logger, monotonic });
    this.config = normalizeConfig();
    /** `{ key, client }` of the current address and login; replaced when they change. */
    this.session = undefined;
    this.running = false;
    this.stopped = false;
    this.timer = undefined;
    this.configTimer = undefined;
    this.storeTimer = undefined;
    this.lifecycle = Promise.resolve();
    this.loopRun = Promise.resolve();
    /** The reading (or the steps of an action before its request left) in flight: one at a time. */
    this.busy = undefined;
    /** A press being handled (until Gladys is answered). */
    this.inFlight = undefined;
    this.lastStatus = null;
    /** What /data keeps (see src/store.js); loaded at the first start. */
    this.memory = undefined;
    /** /data could not be read: nothing is written there, no certificate learned, no action. */
    this.dataUnreadable = false;
    /** A read of /data still pending (slow): never a second one beside it. */
    this.loading = undefined;
    this.loadWarned = false;
    this.saveWarned = false;
    /** The pace (monotonic instants; undefined: none). */
    this.lastReadAt = undefined;
    this.savedAttemptAt = undefined;
    this.pauseDue = undefined;
    this.gateDue = undefined;
    /** Monotonic instants of the last press of each action, by cooldownKey. */
    this.cooldownMono = new Map();
    /** The outcome of the last action, published as "Last action". */
    this.lastAction = null;
    this.resetSession();
  }

  /** What belongs to one address and login: forgotten when they change. */
  resetSession() {
    // An action of the old server is cut here (YunoHost goes on with it).
    this.action?.controller.abort();
    this.action = null;
    this.online = false;
    /** The last reading (src/ynh/client.js read()). */
    this.srv = null;
    this.nextTryAt = undefined;
    this.retryDelay = undefined;
    this.followUpDue = undefined;
    /** A failure that stops every request until the user acts: { code, message } | null. */
    this.final = null;
    this.discoveredKey = null;
    this.transports = new Map();
    /** The first click of "Trust the certificate met": { seen, at } (monotonic). */
    this.trustPending = null;
    /** The status of the last failed reading, said again until a reading works. */
    this.failureMessage = null;
  }

  minRetry() {
    return Math.max(INTERVALS.RETRY_MIN_MS, this.config.pollMs);
  }

  key() {
    return targetKey(this.config);
  }

  // --- Lifecycle -------------------------------------------------------------

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * saved the configuration: a refused login is tried again once (the
   * password saved is always tried, after the login gate). Nothing reads
   * sooner than the interval, nor lifts a pause or a changed certificate.
   */
  start(rawConfig, { force = false } = {}) {
    return this.serialize(() => this.doStart(rawConfig, { force }));
  }

  /**
   * The configuration read from Gladys, then start. When Gladys does not give
   * it, asked again 30 s, 1 min, 2 min... 10 min at most, without end, the
   * status saying so. One chain at a time (cleared by pause()).
   */
  async startFromGladys(attempt = 0) {
    this.clearConfigTimer();
    if (this.stopped) return;
    let config;
    try {
      config = await this.gladys.getConfig();
    } catch (err) {
      if (this.stopped) return;
      const delay = clamp(
        INTERVALS.CONFIG_RETRY_MIN_MS * 2 ** attempt,
        INTERVALS.CONFIG_RETRY_MIN_MS,
        INTERVALS.CONFIG_RETRY_MAX_MS,
      );
      this.logger.warn(`Configuration not read (${err?.name ?? 'Error'}): asked again`);
      // A reading of an older configuration stops: the next start decides.
      this.pause();
      await this.setStatus(false, T.status.configNotRead(delay));
      this.clearConfigTimer();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.startFromGladys(attempt + 1).catch((e) =>
          this.logger.error(`Start failed (${e?.name ?? 'Error'})`),
        );
      }, delay);
      return;
    }
    await this.start(config);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  clearLoopTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  clearStoreTimer() {
    if (this.storeTimer !== undefined) {
      this.timers.clearTimeout(this.storeTimer);
      this.storeTimer = undefined;
    }
  }

  clearFollowTimer() {
    if (this.followTimer !== undefined) {
      this.timers.clearTimeout(this.followTimer);
      this.followTimer = undefined;
    }
  }

  /** Gladys went away: the loop stops; the session, the pace, the failures and an action running stay. */
  pause() {
    this.running = false;
    this.clearLoopTimer();
    this.clearConfigTimer();
    this.clearStoreTimer();
    this.clearFollowTimer();
  }

  /**
   * Stops the readings, waits (bounded) for the one running, cuts the request
   * of an action still running (YunoHost goes on with it), and writes /data
   * (bounded). No timer and no request after it.
   */
  stop() {
    this.stopped = true;
    this.pause();
    this.action?.controller.abort();
    return this.serialize(async () => {
      this.pause();
      if (this.busy)
        await this.within(
          this.busy.catch(() => {}),
          INTERVALS.STOP_WAIT_MS,
        );
      this.action?.controller.abort();
      this.session?.client?.close();
      if (this.memory) await this.save();
    });
  }

  /** Resolves once every queued start/stop, the reading and an action running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.loopRun;
    await this.busy?.catch(() => {});
    await this.action?.done;
    await this.following;
  }

  /** `promise`, or a rejection after `ms` (the promise is left to itself). */
  within(promise, ms) {
    let handle;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        handle = this.timers.setTimeout(
          () => reject(Object.assign(new Error('Too slow'), { code: 'ETIMEDOUT' })),
          ms,
        );
      }),
    ]).finally(() => this.timers.clearTimeout(handle));
  }

  // --- /data -------------------------------------------------------------------

  /**
   * /data, read once (bounded); while it cannot be read, read again on a
   * timer of its own, one read at a time. A read still pending is never
   * doubled. What was decided in memory meanwhile is merged.
   */
  async loadMemory() {
    if (this.memory && !this.dataUnreadable) return;
    if (this.loading) {
      // A read still pending (slow /data): the memory of this run serves.
      this.memory ??= normalizeMemory(null, this.now(), this.random);
      this.dataUnreadable = true;
      this.armStoreRetry();
      return;
    }
    const run = Promise.resolve().then(() => this.store.load());
    this.loading = run;
    run
      .finally(() => {
        if (this.loading === run) this.loading = undefined;
      })
      .catch(() => {});
    let raw;
    try {
      raw = await this.within(run, TIMEOUTS.STORE_MS);
    } catch (err) {
      if (!this.loadWarned) {
        this.loadWarned = true;
        this.logger.warn(
          `The storage /data cannot be read (${err?.code ?? 'error'}): nothing written there, no certificate learned, no action; read again every 10 s`,
        );
      }
      this.dataUnreadable = true;
      // Kept in memory only: a refusal or a pause of this run.
      this.memory ??= normalizeMemory(null, this.now(), this.random);
      this.armStoreRetry();
      return;
    }
    const now = this.now();
    const mono = this.monotonic();
    const disk = normalizeMemory(raw, now, this.random);
    const ram = this.dataUnreadable ? this.memory : null;
    if (ram) this.merge(disk, ram);
    this.memory = disk;
    const wasUnreadable = this.dataUnreadable;
    this.dataUnreadable = false;
    this.loadWarned = false;
    this.clearStoreTimer();
    // The last attempt before a restart: the next one never comes sooner than the interval.
    if (disk.lastAttemptAt > 0) {
      const at = mono - Math.max(0, now - disk.lastAttemptAt);
      if (this.lastReadAt === undefined || at > this.lastReadAt) this.lastReadAt = at;
      this.savedAttemptAt = disk.lastAttemptAt;
    }
    // The pause, the login gate and the delays kept are brought onto the
    // monotonic clock by the next start (they belong to an address).
    this.appliedKey = null;
    if (wasUnreadable) {
      this.logger.info('The storage /data can be read again');
      await this.save();
    }
  }

  /** What was decided in memory while /data could not be read, onto what it holds. */
  merge(disk, ram) {
    const c = this.config;
    if (ram.refused && ram.refused.key === targetKey(c) && ram.refused.user === c.username) {
      // The marker is salted: made again with the salt of /data.
      disk.refused = { ...ram.refused, tag: refusalTag(disk.salt, c.password) };
    }
    if (ram.pause && (!disk.pause || ram.pause.until > disk.pause.until)) disk.pause = ram.pause;
    if (
      ram.loginGate &&
      (!disk.loginGate ||
        ram.loginGate.until > disk.loginGate.until ||
        ram.loginGate.count > disk.loginGate.count)
    ) {
      disk.loginGate = ram.loginGate;
    }
    if (ram.certChanged) disk.certChanged = ram.certChanged;
    for (const [key, fp] of Object.entries(ram.pins)) {
      if (!disk.pins[key]) {
        prunePins(disk.pins, key);
        disk.pins[key] = fp;
      }
    }
    disk.lastAttemptAt = Math.max(disk.lastAttemptAt, ram.lastAttemptAt);
  }

  armStoreRetry() {
    if (this.storeTimer !== undefined || this.stopped) return;
    this.storeTimer = this.timers.setTimeout(() => {
      this.storeTimer = undefined;
      return this.serialize(() => this.reloadMemory()).catch((err) =>
        this.logger.error(`Reading /data failed (${err?.name ?? 'Error'})`),
      );
    }, INTERVALS.STORE_RETRY_MS);
  }

  /** The timer of an unreadable /data: read again, applied to the running configuration. */
  async reloadMemory() {
    if (!this.dataUnreadable || this.stopped) return;
    await this.loadMemory();
    if (this.dataUnreadable || !this.running || this.configProblem(this.config)) return;
    // A stop that came from /data alone is over: tried again (one handshake, nothing sent before the check).
    if (this.final?.code === CODES.PIN_UNAVAILABLE) this.final = null;
    await this.applyMemory(this.config);
    if (this.final) {
      await this.setStatus(false, this.final.message);
      this.clearLoopTimer();
      return;
    }
    this.schedule();
  }

  /** Writes /data (bounded). Never throws: the values stay in memory (a warning once). */
  async save() {
    if (this.dataUnreadable || !this.memory) return false;
    try {
      await this.within(
        Promise.resolve().then(() => this.store.save(serializeMemory(this.memory))),
        TIMEOUTS.STORE_MS,
      );
      this.saveWarned = false;
      return true;
    } catch (err) {
      if (!this.saveWarned) {
        this.saveWarned = true;
        this.logger.warn(`The storage /data cannot be written (${err?.code ?? 'error'})`);
      }
      return false;
    }
  }

  // --- Start -------------------------------------------------------------------

  sessionKeyOf(config) {
    return JSON.stringify([
      config.host,
      config.port,
      config.username,
      config.password,
      config.fingerprint,
    ]);
  }

  async doStart(rawConfig, { force = false } = {}) {
    if (this.stopped) return;
    this.pause();
    const config = normalizeConfig(rawConfig);
    const key = this.sessionKeyOf(config);
    this.config = config;
    await this.loadMemory();
    if (this.stopped) return;
    if (!this.session || this.session.key !== key) {
      this.session?.client?.close();
      this.resetSession();
      this.session = { key, client: null };
    }
    if (force) {
      // The password saved is always tried once (after the login gate), whatever its marker.
      if (this.memory.refused) {
        this.memory.refused = null;
        await this.save();
      }
      if (this.final?.code === CODES.CREDENTIALS) this.final = null;
    }
    // Stops that sent nothing and are not kept in /data are tried again at
    // each start (one TLS handshake, never the password before the check).
    if (['config', CODES.CERTIFICATE_TYPED, CODES.PIN_UNAVAILABLE].includes(this.final?.code)) {
      this.final = null;
    }
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again.
    this.lastStatus = null;
    this.transports.clear();
    this.discoveredKey = null;
    this.gladys.forgetPublishedStates?.();

    const invalid = this.configProblem(config);
    if (invalid) {
      this.final = { code: 'config', message: invalid };
      await this.publishDiscovered();
      await this.publishTransports();
      await this.setStatus(false, invalid);
      return;
    }
    await this.applyMemory(config);
    if (this.final && this.final.code !== CODES.CREDENTIALS) {
      // A final stop of this session (certificate): said again.
      await this.publishDiscovered();
      await this.publishTransports();
      await this.setStatus(false, this.final.message);
      return;
    }
    const session = this.session;
    session.client ??= new YnhClient({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      checkPeer: (fingerprint) => this.checkPeer(session, fingerprint),
      loginGate: () => this.loginGate(),
      onLogin: (status) => this.loginAnswered(session, status),
      ...(this.request ? { request: this.request } : {}),
    });
    this.retryDelay ??= this.minRetry();
    await this.publishDiscovered();
    if (this.fresh()) {
      // The last reading is younger than the interval (Gladys reconnected):
      // sent again from it; the server is read again when the interval is over.
      await this.publishStates();
      await this.publishTransports();
      await this.setStatus(true, this.okMessage());
    } else {
      // The badge waits for the next reading (never "unreachable" before it).
      if (this.final) await this.publishTransports();
      const mono = this.monotonic();
      const gate = this.gateLeft(mono);
      await this.setStatus(
        false,
        this.final
          ? gate > 0
            ? join(this.final.message, T.status.loginGate(gate))
            : this.final.message
          : (this.failureMessage ??
              (gate > 0 ? T.status.loginGate(gate) : this.waitingMessage(mono))),
      );
    }
    await this.publishLastAction();
    this.schedule();
  }

  configProblem(config) {
    if (config.hostError === 'missing') return T.status.hostMissing;
    if (config.hostError === 'http') return T.status.hostHttp;
    if (config.hostError) return T.status.hostInvalid;
    if (!config.username) return T.status.usernameMissing;
    if (config.usernameInvalid) return T.status.usernameInvalid;
    if (!config.password) return T.status.missingPassword;
    if (config.passwordInvalid) return T.status.passwordInvalid;
    if (config.fingerprint === null) return T.status.fingerprintInvalid;
    if (config.servicesInvalid) return T.status.servicesInvalid;
    return null;
  }

  /** The refusal, the gate, the pause, the delays and the changed certificate kept in /data, against this configuration. */
  async applyMemory(config) {
    const m = this.memory;
    const key = targetKey(config);
    let dirty = false;
    if (this.appliedKey !== key) {
      // The pause, the gate and the delays of this address, onto the monotonic clock.
      const now = this.now();
      const mono = this.monotonic();
      this.pauseDue =
        m.pause?.key === key
          ? mono + clamp(m.pause.until - now, 0, INTERVALS.PAUSE_MAX_MS)
          : undefined;
      this.gateDue =
        m.loginGate?.key === key
          ? mono + clamp(m.loginGate.until - now, 0, INTERVALS.LOGIN_GATE_MAX_MS)
          : undefined;
      this.cooldownMono = new Map();
      if (m.cooldowns?.key === key) {
        for (const [name, at] of Object.entries(m.cooldowns.at)) {
          this.cooldownMono.set(name, mono - Math.max(0, now - at));
        }
      }
      this.appliedKey = key;
    }
    // A login refused stands only for the same address, user and password.
    if (m.refused) {
      if (this.refusedApplies()) {
        this.final = { code: CODES.CREDENTIALS, message: T.status.credentialsRefused };
      } else {
        m.refused = null;
        dirty = true;
        if (this.final?.code === CODES.CREDENTIALS) this.final = null;
      }
    }
    if (m.certChanged?.key === key) {
      if (config.fingerprint) {
        // A fingerprint typed is the authority: checkPeer imposes it (another
        // certificate is refused, showing the one really met, nothing sent).
        m.certChanged = null;
        dirty = true;
        if (this.final?.code === CODES.CERTIFICATE) this.final = null;
        this.logger.info('A certificate fingerprint was typed: it is the one trusted now');
      } else {
        this.final = {
          code: CODES.CERTIFICATE,
          message: T.status.certificateChanged(m.certChanged.seen),
        };
      }
    }
    if (dirty) await this.save();
  }

  refusedApplies() {
    const r = this.memory?.refused;
    const c = this.config;
    return Boolean(
      r &&
      r.key === targetKey(c) &&
      r.user === c.username &&
      r.tag === refusalTag(this.memory.salt, c.password),
    );
  }

  waitingMessage(mono) {
    return T.status.waiting(Math.max(0, this.dueAt(mono) - mono));
  }

  // --- The login gate (fail2ban) -----------------------------------------------

  /** The rest of the login gate (ms, monotonic), capped at every use; 0 when none. */
  gateLeft(mono) {
    if (this.gateDue === undefined) return 0;
    return clamp(this.gateDue - mono, 0, INTERVALS.LOGIN_GATE_MAX_MS);
  }

  /** Called by the client before every login: throws while the gate stands (nothing sent). */
  loginGate() {
    const left = this.gateLeft(this.monotonic());
    if (left > 0) {
      throw new YnhError(CODES.LOGIN_GATE, 'Login gate', { notSent: true, waitMs: left });
    }
  }

  /**
   * The answer of a login sent. A 401: no login at all for 5 min, 10, 20...
   * (6 h at most) until one works, kept in /data (written by the failure path).
   */
  loginAnswered(session, status) {
    if (session !== this.session || status !== 401) return;
    const m = this.memory;
    const key = this.key();
    const count = Math.min((m.loginGate?.key === key ? m.loginGate.count : 0) + 1, 64);
    const delay = clamp(
      INTERVALS.LOGIN_GATE_MIN_MS * 2 ** (count - 1),
      INTERVALS.LOGIN_GATE_MIN_MS,
      INTERVALS.LOGIN_GATE_MAX_MS,
    );
    this.gateDue = this.monotonic() + delay;
    m.loginGate = { key, until: this.now() + delay, count };
  }

  // --- The certificate ---------------------------------------------------------

  /**
   * Right after the TLS handshake, before any byte is written: the
   * certificate of the server must be the fingerprint typed, else the pin
   * kept in /data; with neither, it is learned, written to /data BEFORE the
   * request goes. /data unreadable or not writable: nothing learned, nothing
   * sent.
   */
  async checkPeer(session, fingerprint) {
    if (session !== this.session) throw new YnhError(CODES.LATE, 'Configuration changed');
    const m = this.memory;
    const key = this.key();
    const typed = this.config.fingerprint;
    if (typed) {
      if (fingerprint !== typed) {
        throw new YnhError(CODES.CERTIFICATE_TYPED, 'Not the certificate typed', {
          fingerprint,
        });
      }
      if (m.pins[key] !== typed) {
        prunePins(m.pins, key);
        m.pins[key] = typed;
        if (m.certChanged?.key === key) m.certChanged = null;
        // Kept when /data allows it; the typed value is the reference anyway.
        await this.save();
      }
      return;
    }
    const pin = m.pins[key];
    if (pin) {
      if (fingerprint === pin) return;
      throw new YnhError(CODES.CERTIFICATE, 'Another certificate', { fingerprint });
    }
    if (this.dataUnreadable) {
      throw new YnhError(CODES.PIN_UNAVAILABLE, '/data unreadable', {
        reason: 'unreadable',
        fingerprint,
      });
    }
    prunePins(m.pins, key);
    m.pins[key] = fingerprint;
    if (!(await this.save())) {
      delete m.pins[key];
      throw new YnhError(CODES.PIN_UNAVAILABLE, '/data not writable', {
        reason: 'unwritable',
        fingerprint,
      });
    }
    this.logger.info('HTTPS certificate of the server learned and pinned');
  }

  /**
   * "Trust the certificate met", in two clicks: the first shows the
   * fingerprint refused, the second (within 2 min, the same fingerprint)
   * pins it, written to /data first. Never a certificate not met, never
   * while a fingerprint is typed.
   */
  async trustCertificate() {
    await this.lifecycle;
    const m = this.memory;
    if (this.config.fingerprint) throw new Error(T.trust.typed.en);
    const key = this.key();
    const changed = m?.certChanged?.key === key ? m.certChanged : null;
    if (!changed) return T.trust.nothing;
    if (this.dataUnreadable) throw new Error(T.trust.notKept.en);
    const mono = this.monotonic();
    const pending = this.trustPending;
    if (
      !pending ||
      pending.seen !== changed.seen ||
      mono - pending.at > INTERVALS.TRUST_CONFIRM_MS ||
      mono < pending.at
    ) {
      this.trustPending = { seen: changed.seen, at: mono };
      return T.trust.confirm(changed.seen);
    }
    this.trustPending = null;
    const before = { pin: m.pins[key], changed: m.certChanged };
    prunePins(m.pins, key);
    m.pins[key] = changed.seen;
    m.certChanged = null;
    if (!(await this.save())) {
      if (before.pin) m.pins[key] = before.pin;
      else delete m.pins[key];
      m.certChanged = before.changed;
      throw new Error(T.trust.notKept.en);
    }
    this.logger.info('The certificate met was trusted by the user (two clicks): pinned');
    if (this.final?.code === CODES.CERTIFICATE) this.final = null;
    this.failureMessage = null;
    // Nothing was sent to the refused certificate: a reading now.
    this.followUpDue = this.monotonic();
    this.schedule();
    return T.trust.done(changed.seen);
  }

  // --- Pace ------------------------------------------------------------------

  /** The rest of the pause (ms, monotonic), capped to PAUSE_MAX at every use; 0 when none. */
  pauseLeft(mono) {
    if (this.pauseDue === undefined) return 0;
    return clamp(this.pauseDue - mono, 0, INTERVALS.PAUSE_MAX_MS);
  }

  /** The monotonic time from which the next reading may start, from the caller's instant `mono`. */
  dueAt(mono) {
    let due = this.lastReadAt === undefined ? mono : this.lastReadAt + this.config.pollMs;
    if (this.followUpDue !== undefined) due = Math.min(due, this.followUpDue);
    if (this.nextTryAt !== undefined) due = Math.max(due, this.nextTryAt);
    // Without a session, a reading starts with a login: never while the gate stands.
    if (!this.session?.client?.token) due = Math.max(due, mono + this.gateLeft(mono));
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  /** One timer: the next reading when it is due; none while a final failure stands. */
  schedule() {
    this.clearLoopTimer();
    if (!this.running || this.stopped || !this.session?.client || this.final) return;
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.loopRun = this.loop();
      return this.loopRun;
    }, wait);
  }

  async loop() {
    const session = this.session;
    try {
      await this.tick();
    } catch (err) {
      this.logger.error(`Loop failed (${err?.name ?? 'Error'})`);
    }
    if (session === this.session && this.running) this.schedule();
  }

  /** One reading when it is due; a reading (or the steps of an action) running is never doubled. */
  tick({ evenRefused = false } = {}) {
    if (this.busy) return this.busy.catch(() => {});
    const run = this.read({ evenRefused }).finally(() => {
      if (this.busy === run) this.busy = undefined;
    });
    this.busy = run;
    return run;
  }

  async read({ evenRefused }) {
    const session = this.session;
    const client = session?.client;
    if (!client || !this.running || this.stopped) return;
    // A refused login is never tried again by the loop: only the test button, once.
    if (this.final && !(evenRefused && this.final.code === CODES.CREDENTIALS)) return;
    const mono = this.monotonic();
    if (mono < this.dueAt(mono)) return;
    const gone = () => session !== this.session || !this.running || this.stopped;
    this.lastReadAt = mono;
    this.followUpDue = undefined;
    // Kept BEFORE the request: a restart during it never reads again sooner.
    await this.saveAttempt(this.now());
    if (gone()) return;
    let srv;
    try {
      srv = await client.read({
        timeLeft: () => mono + TIMEOUTS.READING_MS - this.monotonic(),
        maxSkip: Math.max(0, Math.floor(INTERVALS.SECONDARY_MAX_MS / this.config.pollMs) - 1),
      });
    } catch (err) {
      if (gone()) return;
      await this.failed(err);
      return;
    }
    if (gone()) return;
    await this.succeeded(srv, gone);
  }

  async saveAttempt(now) {
    this.memory.lastAttemptAt = now;
    if (
      this.savedAttemptAt === undefined ||
      now < this.savedAttemptAt ||
      now - this.savedAttemptAt >= Math.min(INTERVALS.ATTEMPT_SAVE_MS, this.config.pollMs)
    ) {
      this.savedAttemptAt = now;
      await this.save();
    }
  }

  // --- Outcomes ----------------------------------------------------------------

  /** A reading (or the fresh read of an action) failed. Never throws. */
  async failed(err) {
    const wasOnline = this.online;
    this.online = false;
    const m = this.memory;
    const key = this.key();
    await this.publishTransports();
    const mono = this.monotonic();
    switch (err?.code) {
      case CODES.CREDENTIALS:
        m.refused = {
          key,
          user: this.config.username,
          tag: refusalTag(m.salt, this.config.password),
        };
        this.final = { code: CODES.CREDENTIALS, message: T.status.credentialsRefused };
        this.session?.client?.close();
        await this.save();
        this.logger.warn(
          'YunoHost refused the user name or the password: not tried again until they are saved again',
        );
        return this.stopWithFinal(
          join(this.final.message, T.status.loginGate(this.gateLeft(mono))),
        );
      case CODES.LOGIN_GATE: {
        // Nothing sent: the next try once the gate is over (a refusal stays final).
        const wait = this.gateLeft(mono);
        this.nextTryAt = mono + wait;
        const message =
          this.final?.code === CODES.CREDENTIALS
            ? join(this.final.message, T.status.loginGate(wait))
            : T.status.loginGate(wait);
        this.failureMessage = this.final ? null : message;
        await this.setStatus(false, message);
        return undefined;
      }
      case CODES.CERTIFICATE:
        m.certChanged = { key, seen: err.fingerprint };
        this.trustPending = null;
        this.final = {
          code: CODES.CERTIFICATE,
          message: T.status.certificateChanged(err.fingerprint),
        };
        await this.save();
        this.logger.warn('The HTTPS certificate of the server is not the one pinned: nothing sent');
        return this.stopWithFinal();
      case CODES.CERTIFICATE_TYPED:
        this.final = {
          code: CODES.CERTIFICATE_TYPED,
          message: T.status.certificateTyped(err.fingerprint),
        };
        this.logger.warn('The HTTPS certificate of the server is not the one typed: nothing sent');
        return this.stopWithFinal();
      case CODES.PIN_UNAVAILABLE:
        this.final = {
          code: CODES.PIN_UNAVAILABLE,
          message: T.status.pinUnavailable(err.reason, err.fingerprint),
        };
        this.logger.warn('The certificate of the server cannot be kept in /data: nothing sent');
        return this.stopWithFinal();
      default:
        break;
    }
    let message;
    if (isPause(err)) {
      const delay = clamp(
        err.retryAfterMs ?? this.retryDelay,
        Math.max(INTERVALS.PAUSE_MIN_MS, this.config.pollMs),
        INTERVALS.PAUSE_MAX_MS,
      );
      this.pauseDue = mono + delay;
      m.pause = { key, until: this.now() + delay, status: err.status };
      await this.save();
      message = T.status.paused(err.status, delay);
      if (err.status !== 429)
        this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
    } else {
      const delay = this.retryDelay;
      this.nextTryAt = mono + delay;
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
      if (err?.code === CODES.TLS) message = T.status.tls(delay);
      else if (err?.code === CODES.FORBIDDEN) message = T.status.forbidden(delay);
      else {
        message = T.status.failure(err, delay, {
          // A refusal lately and no connection now: fail2ban, maybe.
          banHint:
            (err?.code === CODES.UNREACHABLE || err?.code === CODES.TIMEOUT) &&
            m.loginGate?.key === key,
          action: this.action ? this.action.what : null,
        });
      }
    }
    // A YnhError message never holds a secret nor a domain; anything else is
    // reduced to its name. At most one line per retry (1 min or more).
    const what = err?.name === 'YnhError' ? err.message : String(err?.name ?? 'error');
    this.logger[wasOnline ? 'warn' : 'info'](`The server fails: ${what}`);
    this.failureMessage = message;
    await this.setStatus(false, message);
    return undefined;
  }

  async stopWithFinal(message = this.final.message) {
    this.clearLoopTimer();
    await this.setStatus(false, message);
  }

  async succeeded(srv, gone) {
    const m = this.memory;
    // An answer: a pause asked before, the retries, the gate and a refused login are over.
    this.pauseDue = undefined;
    this.gateDue = undefined;
    this.nextTryAt = undefined;
    this.retryDelay = this.minRetry();
    this.failureMessage = null;
    let dirty = false;
    for (const field of ['pause', 'refused', 'loginGate']) {
      if (m[field]) {
        m[field] = null;
        dirty = true;
      }
    }
    if (this.final?.code === CODES.CREDENTIALS) {
      this.final = null;
      this.logger.info('YunoHost accepts the login again');
    }
    if (dirty) await this.save();
    if (gone()) return;
    // The age of the newest backup: from its date (UTC) on the wall clock; a
    // date ahead of the clock by more than a day is not believed.
    const newestAt = srv.backups?.newestAt;
    const age = typeof newestAt === 'number' ? Math.round((this.now() - newestAt) / 1000) : null;
    this.srv = {
      ...srv,
      backupAgeSeconds: age === null || age < -86_400 ? null : Math.max(0, age),
    };
    this.online = true;
    this.lastOkAt = this.monotonic();
    await this.publishDiscovered();
    if (gone()) return;
    await this.publishStates();
    if (gone()) return;
    await this.publishTransports();
    if (gone()) return;
    await this.setStatus(true, this.okMessage());
  }

  okMessage() {
    const s = this.srv;
    const sys = s?.updates?.systemUpdates;
    const apps = s?.updates?.appUpdates;
    return T.status.ok({
      version: s?.version ?? null,
      updates: typeof sys === 'number' && typeof apps === 'number' ? sys + apps : null,
      down: s?.services?.down ?? null,
      missing: s?.missing ?? [],
      running: this.action?.what ?? null,
    });
  }

  async setStatus(connected, message) {
    const key = JSON.stringify({ connected, message });
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent (${err?.name ?? 'Error'})`);
    });
  }

  // --- Gladys side -------------------------------------------------------------

  serviceNames() {
    return this.srv?.services?.services ? [...this.srv.services.services.keys()] : [];
  }

  /** Never throws: a refusal of Gladys is not a failure of the server. Sent when what it lists changed. */
  async publishDiscovered({ always = false } = {}) {
    const what = { services: this.serviceNames(), restartable: this.config.restartable };
    const key = JSON.stringify(what);
    if (!always && key === this.discoveredKey) return;
    try {
      await this.gladys.publishDiscoveredDevices([buildServerDevice(this.gladys, what)]);
      this.discoveredKey = key;
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  /** Discovery (scan button): what is known, never a reading (the next one comes at its time). */
  async publishDiscovery() {
    await this.publishDiscovered({ always: true });
  }

  /** Online, with a reading younger than the interval: its values may be sent (again). */
  fresh() {
    return (
      this.online &&
      this.lastOkAt !== undefined &&
      this.monotonic() - this.lastOkAt < this.config.pollMs
    );
  }

  async publishStates() {
    if (!this.fresh()) return;
    await this.publisher.publish(statesOf(this.gladys, { ...this.srv, lastAction: null }));
  }

  /** "Last action": what the integration did, published as it changes (not a reading of the server). */
  async publishLastAction() {
    if (!this.lastAction) return;
    await this.publisher.publish(
      statesOf(this.gladys, { lastAction: this.lastAction }, { only: [FEATURES.LAST_ACTION] }),
    );
  }

  async setLastAction(text, session) {
    if (session !== this.session || this.stopped) return;
    this.lastAction = text;
    await this.publishLastAction();
  }

  async publishTransports() {
    const created = createdServer(this.gladys);
    if (!created) return;
    const transport = this.online ? 'local' : 'unreachable';
    if (this.transports.get(created.external_id) === transport) return;
    this.transports.set(created.external_id, transport);
    await this.gladys
      .publishTransports([{ external_id: created.external_id, transport }])
      .catch((err) => {
        this.transports.delete(created.external_id);
        this.logger.debug(`Transport not published (${err?.name ?? 'Error'})`);
      });
  }

  /** A device created or updated: its values now (the last reading, never older than the interval). */
  async deviceCreated(device) {
    if (typeof device?.external_id === 'string') {
      this.gladys.forgetPublishedStates?.(device.external_id);
      this.transports.delete(device.external_id);
    }
    await this.publishStates();
    await this.publishLastAction();
    await this.publishTransports();
  }

  async deviceUpdated(device) {
    await this.deviceCreated(device);
  }

  deviceDeleted(device) {
    if (typeof device?.external_id === 'string') this.transports.delete(device.external_id);
  }

  // --- The actions -------------------------------------------------------------

  /** Whether the configuration allows this action now. Throws the refusal otherwise. */
  allowed(kind, service) {
    if (kind === 'upgrade_system' || kind === 'upgrade_apps') {
      if (!this.config.allowUpgrades) throw userError(T.errors.upgradesDisabled);
    } else if (kind === 'backup') {
      if (!this.config.allowBackup) throw userError(T.errors.backupDisabled);
    } else if (kind === 'restart') {
      if (!this.config.restartable.includes(service)) {
        throw userError(T.errors.restartDisabled(service));
      }
    } else {
      throw userError(T.errors.readOnly);
    }
  }

  /**
   * A command from Gladys. Only the buttons act; every reading refuses.
   * Resolves once the request of the action left and YunoHost did not refuse
   * it at once (an upgrade or a backup then runs on, its outcome in "Last
   * action"); a restart resolves on the answer of YunoHost.
   */
  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const f = featureOf(this.gladys, feature?.external_id);
    if (f === undefined || f === null) throw userError(T.errors.unknownDevice);
    let kind;
    if (f.key === FEATURES.UPGRADE_SYSTEM) kind = 'upgrade_system';
    else if (f.key === FEATURES.UPGRADE_APPS) kind = 'upgrade_apps';
    else if (f.key === FEATURES.BACKUP) kind = 'backup';
    else if (f.restart) kind = 'restart';
    else throw userError(T.errors.readOnly);
    // Strictly the value of a button: never a 0, a true or an empty text.
    if (value !== PRESSED && value !== String(PRESSED)) throw userError(T.errors.badValue);
    this.allowed(kind, f.restart);
    if (this.action) throw userError(T.errors.stillRunning(this.action.what));
    if (this.inFlight) throw userError(T.errors.stillRunning(this.inFlight.what));
    const what = whatOf(kind, f.restart);
    const run = this.act(kind, f.restart, what, received);
    this.inFlight = { run, what };
    try {
      return await run;
    } finally {
      if (this.inFlight?.run === run) this.inFlight = undefined;
    }
  }

  /**
   * The checks of an action, on the latest configuration: before the read
   * and right before sending. An action does not wait for the readings to
   * come back (an outage, the retry delay): its own fresh read decides.
   */
  checkAction(session, mono, kind, service) {
    this.allowed(kind, service);
    if (session !== this.session || !session?.client || !this.running || this.stopped) {
      throw userError(T.errors.notConnected);
    }
    if (this.final) throw userError(T.errors.notConnected);
    if (this.dataUnreadable) throw userError(T.errors.dataUnreadable);
    const pause = this.pauseLeft(mono);
    if (pause > 0) throw userError(T.errors.paused(pause));
    const last = this.cooldownMono.get(cooldownKey(kind, service));
    if (last !== undefined) {
      const span = COMMAND.COOLDOWN_MS[kind];
      // A press "in the future" (a clock set back in /data) counts as one now.
      const ago = Math.max(0, mono - last);
      if (ago < span) throw userError(T.errors.cooldown(whatOf(kind, service), span - ago));
    }
  }

  /** A failure of the action that the loop must follow (final, pause): the usual path. */
  follow(err) {
    if (!isPause(err) && !isFinal(err) && err?.code !== CODES.LOGIN_GATE) return;
    this.following = this.failed(err).catch(() => {});
  }

  async act(kind, service, what, received) {
    const session = this.session;
    const client = session?.client;
    this.checkAction(session, received, kind, service);
    // The reading in flight finishes first (one request at a time), within the read budget.
    if (this.busy) {
      let late = false;
      await this.within(
        this.busy.catch(() => {}),
        Math.max(0, received + COMMAND.READ_BY_MS - this.monotonic()),
      ).catch(() => {
        late = true;
      });
      if (late || this.busy) throw userError(T.errors.tooSlow);
    }
    const run = this.actSteps(kind, service, what, received, session, client);
    this.busy = run.then(
      () => {},
      () => {},
    );
    const busy = this.busy;
    try {
      return await run;
    } finally {
      if (this.busy === busy) this.busy = undefined;
    }
  }

  /** The delay of this action, set (before the first byte) or put back (nothing happened). */
  async keepCooldown(ck, at, mono) {
    const m = this.memory;
    const key = this.key();
    const before = {
      cooldowns: m.cooldowns ? { key: m.cooldowns.key, at: { ...m.cooldowns.at } } : null,
      mono: this.cooldownMono.get(ck),
    };
    const base = m.cooldowns?.key === key ? m.cooldowns.at : {};
    m.cooldowns = { key, at: { ...base, [ck]: at } };
    this.cooldownMono.set(ck, mono);
    const undo = async () => {
      m.cooldowns = before.cooldowns;
      if (before.mono === undefined) this.cooldownMono.delete(ck);
      else this.cooldownMono.set(ck, before.mono);
      await this.save();
    };
    return { saved: await this.save(), undo };
  }

  async actSteps(kind, service, what, received, session, client) {
    // The server read just before acting, never the one in memory: the
    // session must work, and the service exist (a restart).
    const readLeft = () => received + COMMAND.READ_BY_MS - this.monotonic();
    let before = null;
    try {
      if (kind === 'restart') {
        before = await client.service(service, { timeLeft: readLeft });
        if (!before) throw userError(T.errors.unknownService(service));
      } else {
        await client.check({ timeLeft: readLeft });
      }
    } catch (err) {
      if (err?.user) throw err;
      this.follow(err);
      if (err?.code === CODES.TIMEOUT || err?.code === CODES.LATE) {
        throw userError(T.errors.tooSlow, err);
      }
      throw userError(T.errors.unknownState(reasonOf(err).en), err);
    }
    // A read that ended after its budget leaves no time to act safely.
    if (readLeft() < 0) throw userError(T.errors.tooSlow);
    // The option may have been turned off during the read: checked again.
    const sendBy = received + COMMAND.SEND_BY_MS;
    let mono = this.monotonic();
    this.checkAction(session, mono, kind, service);
    if (mono > sendBy) throw userError(T.errors.tooSlow);
    // The delay is kept BEFORE the first byte: a restart right after keeps it.
    // /data unreadable or not writable: nothing is sent.
    const ck = cooldownKey(kind, service);
    const { saved, undo } = await this.keepCooldown(ck, this.now(), mono);
    if (!saved) {
      await undo();
      throw userError(T.errors.cooldownNotKept);
    }
    mono = this.monotonic();
    if (mono > sendBy || session !== this.session) {
      await undo();
      throw userError(T.errors.tooSlow);
    }
    this.logger.info(`${what} requested from Gladys`);
    const controller = new AbortController();
    let written = false;
    const request = client.action(kind, {
      service,
      signal: controller.signal,
      timeLeft: () => received + TIMEOUTS.ACTION_MS - this.monotonic(),
      // The very last check, right before the request is written (after the
      // TCP and TLS handshakes): the option, the session, the deadline.
      beforeSend: () => {
        const at = this.monotonic();
        this.allowed(kind, service);
        if (session !== this.session || !this.running || this.stopped) {
          throw userError(T.errors.notConnected);
        }
        if (at > sendBy) throw userError(T.errors.tooSlow);
        written = true;
      },
    });
    const action = { kind, service, what, controller };
    this.action = action;
    // The outcome, whenever it comes (an upgrade may take most of an hour).
    action.done = request.then(
      (result) => this.actionDone(action, session, client, before, result, null, undo),
      (err) => this.actionDone(action, session, client, before, null, err, undo),
    );
    // Gladys is answered within its 5 s: the answer if it came, else what left.
    let deadline;
    const answered = await Promise.race([
      action.done.then(() => true),
      new Promise((resolve) => {
        deadline = this.timers.setTimeout(
          () => resolve(false),
          Math.max(0, received + COMMAND.ANSWER_BY_MS - this.monotonic()),
        );
      }),
    ]);
    this.timers.clearTimeout(deadline);
    if (answered) {
      if (action.error) throw action.error;
      return undefined;
    }
    if (!written) {
      // Still not sent at the deadline (a handshake that hangs): cut, nothing sent.
      controller.abort();
      await action.done;
      throw action.error ?? userError(T.errors.tooSlow);
    }
    if (kind === 'restart') {
      throw userError(T.errors.sentUnconfirmed(what, reasonOf({ code: CODES.TIMEOUT }).en));
    }
    // Still running (an outcome that came meanwhile is never overwritten).
    if (this.action === action) {
      await this.setLastAction(`${what}: running (sent from Gladys)`, session);
    }
    return undefined;
  }

  /**
   * The end of the request of an action: its outcome in "Last action" and
   * the log, the delay put back when nothing happened, a reading after an
   * upgrade or a backup, the service read again after a restart. Never
   * throws; `action.error` holds what the press must answer.
   */
  async actionDone(action, session, client, before, result, err, undo) {
    const { kind, service, what } = action;
    if (this.action === action) this.action = null;
    let text;
    if (!err) {
      this.logger.info(`${what}: YunoHost answered (HTTP ${result.status})`);
      text =
        kind === 'restart'
          ? `${what}: YunoHost answered, checking the service`
          : `${what}: finished (YunoHost answered)`;
      if (kind === 'restart') this.followService(session, client, service, before);
      else this.readSoon(session);
    } else if (err.user) {
      // Refused by the last check (option off, too late): nothing sent.
      await undo();
      action.error = err;
      text = `${what}: not sent (${err.message})`;
    } else {
      const reason = reasonOf(err).en;
      this.logger.warn(`${what}: ${err?.name === 'YnhError' ? err.message : 'error'}`);
      // A refusal of the action route never pauses the readings (a 500 of
      // YunoHost there is the lock of another operation, or the action that
      // failed); a certificate changed still stops everything.
      if (isFinal(err)) this.follow(err);
      const answeredNo =
        err.code === CODES.ACCESS ||
        err.code === CODES.REDIRECT ||
        err.code === CODES.FORBIDDEN ||
        (err.code === CODES.HTTP && err.status < 500);
      if (err.notSent) {
        await undo();
        action.error = userError(T.errors.notSent(what, reason), err);
        text = `${what}: not sent (${reason})`;
      } else if (answeredNo) {
        // YunoHost answered "no": nothing runs.
        await undo();
        action.error = userError(T.errors.refused(what, reason), err);
        text = `${what}: refused by YunoHost (${reason})`;
      } else if (err.code === CODES.HTTP && err.status === 500) {
        // Failed while running, or another operation held the lock: the delay stays.
        action.error = userError(T.errors.refused(what, reason), err);
        text = `${what}: failed or refused by YunoHost (${reason}); see its web admin`;
        if (kind !== 'restart') this.readSoon(session);
      } else {
        // A 502/504, a silence, a cut answer after the request was written:
        // it may have reached YunoHost, it may still run.
        action.error = userError(T.errors.sentUnconfirmed(what, reason), err);
        text = `${what}: sent, no final answer (${reason}); it may still be running`;
        if (kind !== 'restart') this.readSoon(session);
        else this.followService(session, client, service, before);
      }
    }
    await this.setLastAction(text, session);
    if (session === this.session && this.online && !this.stopped) {
      await this.setStatus(true, this.okMessage());
    }
  }

  /** A reading soon after an action ended (the counts it changed), within the pace rules. */
  readSoon(session) {
    if (session !== this.session || this.stopped) return;
    this.followUpDue = this.monotonic() + COMMAND.AFTER_ACTION_MS;
    this.schedule();
  }

  /** The service read again 5 s after its restart: running and restarted, or said otherwise. */
  followService(session, client, service, before) {
    this.clearFollowTimer();
    if (session !== this.session || this.stopped) return;
    this.followTimer = this.timers.setTimeout(() => {
      this.followTimer = undefined;
      this.following = this.checkRestarted(session, client, service, before).catch(() => {});
      return this.following;
    }, COMMAND.FOLLOW_MS);
  }

  async checkRestarted(session, client, service, before) {
    if (session !== this.session || this.stopped || !this.running) return;
    const what = whatOf('restart', service);
    let after;
    try {
      const at = this.monotonic();
      after = await client.service(service, {
        timeLeft: () => at + TIMEOUTS.REQUEST_MS - this.monotonic(),
      });
    } catch (err) {
      await this.setLastAction(`${what}: not read again (${reasonOf(err).en})`, session);
      return;
    }
    let text;
    if (!after) text = `${what}: the service is no longer listed`;
    else if (after.running !== 1) text = `${what}: done, but the service is not running`;
    else if (before?.changed && after.changed && before.changed === after.changed) {
      // Running, but since before the press: the restart is not seen.
      text = `${what}: running, the restart is not seen yet`;
    } else text = `${what}: done, the service is running`;
    this.logger.info(text);
    await this.setLastAction(text, session);
  }

  // --- Configuration buttons -------------------------------------------------

  /**
   * Reads when a reading is due (never sooner than the interval), then
   * reports within 28 s. A refused login is tried once, after the login gate
   * (it is lifted only by a success); a changed certificate or a pause is not
   * lifted. The reading counts as the one of the loop.
   */
  async testConnection() {
    try {
      await this.within(
        (async () => {
          await this.lifecycle;
          await this.tick({ evenRefused: true });
        })(),
        TEST_BUDGET_MS,
      );
    } catch (err) {
      if (err?.code === 'ETIMEDOUT') throw new Error(T.errors.testTooLong, { cause: err });
      throw err;
    }
    if (this.running && !this.final) this.schedule();
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus).message : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok(this.okMessage());
  }
}
