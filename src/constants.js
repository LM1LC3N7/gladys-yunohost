// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys and the external id shapes are
// stored in user scenes and devices: never rename them (test/manifest.test.js
// ties them to the manifest).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
  TRUST_CERTIFICATE: 'trust_certificate',
});

/**
 * Device external id: `ext:<selector>:server:main`, one server per
 * installation (the address of the configuration). Fixed: it never depends
 * on a domain name nor on a version. The server it belongs to is the one
 * whose HTTPS certificate is pinned (src/app.js checkPeer).
 */
export const SERVER_TYPE = 'server';
export const SERVER_ID = 'main';

/** The features of the server itself. */
export const FEATURES = Object.freeze({
  VERSION: 'version',
  SYSTEM_UPDATES: 'system_updates',
  APP_UPDATES: 'app_updates',
  MAJOR_UPDATE: 'major_update',
  MIGRATIONS: 'pending_migrations',
  UPDATES_CHECKED: 'updates_checked',
  SERVICES_DOWN: 'services_down',
  DIAGNOSIS_ERRORS: 'diagnosis_errors',
  DIAGNOSIS_WARNINGS: 'diagnosis_warnings',
  BACKUPS: 'backups',
  LAST_BACKUP: 'last_backup',
  LAST_ACTION: 'last_action',
  // The buttons (off by default, never a switch).
  UPGRADE_SYSTEM: 'upgrade_system',
  UPGRADE_APPS: 'upgrade_apps',
  BACKUP: 'backup',
});

/** The features of each service: `service_<id>` (running), `restart_<id>` (button). */
export const SERVICE_PREFIX = 'service_';
export const RESTART_PREFIX = 'restart_';

/** Minutes between two readings. */
export const POLL_INTERVALS = Object.freeze(['5', '15', '30', '60']);

export const DEFAULT_PORT = 443;

/** The administration API of YunoHost, behind its nginx. */
export const API_PREFIX = '/yunohost/api';

export const LIMITS = Object.freeze({
  /** POST /state admits 300 states per minute per integration: we keep under 250. */
  STATES_PER_MINUTE: 250,
  /** A text published to Gladys (version, last action) is cut to this length. */
  TEXT_LENGTH: 120,
  /** Services read (a YunoHost has 15 to 40): more is not read. */
  SERVICES: 64,
  /** Services listed as restartable in the configuration. */
  RESTARTABLE: 16,
  /** A count published (updates, items): beyond it, not an answer of YunoHost. */
  COUNT: 100_000,
  /** Size cap of an answer (the update list carries the apps' notes). */
  ANSWER_BYTES: 2 * 1024 * 1024,
  /** Size cap of the answer of an action (they answer a few KB). */
  ACTION_BYTES: 256 * 1024,
  /** Size cap of the /data file read back. */
  STORE_BYTES: 16 * 1024,
  /** Items walked in one answer (packages, apps, diagnosis items, archives). */
  ITEMS: 5_000,
});

export const TIMEOUTS = Object.freeze({
  /** One reading request (TCP and TLS handshakes included; GET /services runs `nginx -t`...). */
  REQUEST_MS: 30_000,
  /** A whole reading (six requests one after the other). */
  READING_MS: 90_000,
  /** An action (upgrade, backup) runs inside its request: nginx gives up after 1 h. */
  ACTION_MS: 65 * 60_000,
  /** One read or write of /data: beyond it, taken as failed (never awaited without end). */
  STORE_MS: 5_000,
});

export const INTERVALS = Object.freeze({
  /** A failure (network, unexpected answer) is retried after max(this, the poll interval), doubling. */
  RETRY_MIN_MS: 60_000,
  RETRY_MAX_MS: 60 * 60_000,
  /** HTTP 429 / 5xx on the main route: pause of every request, within these bounds (Retry-After if given). */
  PAUSE_MIN_MS: 60_000,
  PAUSE_MAX_MS: 6 * 3600_000,
  /**
   * After a login refused, no other login before this (doubling per refusal
   * in a row, up to LOGIN_GATE_MAX): fail2ban bans the address of Gladys
   * after a few refusals in a few minutes.
   */
  LOGIN_GATE_MIN_MS: 5 * 60_000,
  LOGIN_GATE_MAX_MS: 6 * 3600_000,
  /** The time of the last attempt is written to /data at most this often. */
  ATTEMPT_SAVE_MS: 60_000,
  /** Configuration not given by Gladys: asked again from this delay, doubling up to the max. */
  CONFIG_RETRY_MIN_MS: 30_000,
  CONFIG_RETRY_MAX_MS: 10 * 60_000,
  /** /data unreadable or slow: read again this often, one read at a time. */
  STORE_RETRY_MS: 10_000,
  /** A secondary route failing is asked again at most this far apart. */
  SECONDARY_MAX_MS: 6 * 3600_000,
  /** Unchanged values are sent again this often (the core shows them as fresh). */
  HEARTBEAT_MS: 30 * 60_000,
  /** A stop waits this long at most for the reading in flight. */
  STOP_WAIT_MS: 3_000,
  /** The second click of "Trust the certificate met" must come within this. */
  TRUST_CONFIRM_MS: 2 * 60_000,
});

/** The actions: deadlines counted from the arrival of the press (Gladys acks within 5 s). */
export const COMMAND = Object.freeze({
  /** The fresh read just before (the session, the service) must end by then. */
  READ_BY_MS: 2_500,
  /** The request is refused unsent after this. */
  SEND_BY_MS: 3_500,
  /** The answer is awaited until this before Gladys is answered. */
  ANSWER_BY_MS: 4_500,
  /** The follow-up read of a service restarted. */
  FOLLOW_MS: 5_000,
  /** A reading after an upgrade or a backup ended (the counts it changed). */
  AFTER_ACTION_MS: 15_000,
  /** No second press of the same action before this delay (a scene in a loop): kept in /data. */
  COOLDOWN_MS: Object.freeze({
    upgrade_system: 30 * 60_000,
    upgrade_apps: 30 * 60_000,
    backup: 60 * 60_000,
    restart: 2 * 60_000,
  }),
});

/** The only value a `button`/`push` feature sends (BUTTON_PUSH.PRESSED of the core). */
export const PRESSED = 1;

/** The persistent store (see src/store.js). */
export const STORE_FILE = '/data/yunohost-state.json';

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return /^\d+\.\d+\.\d+$/.test(pkg.version) ? pkg.version : '0';
  } catch {
    return '0';
  }
})();

/** The User-Agent of every request: the integration says who it is, never a browser. */
export const USER_AGENT = `gladys-yunohost/${VERSION} (+https://github.com/LM1LC3N7/gladys-yunohost)`;
