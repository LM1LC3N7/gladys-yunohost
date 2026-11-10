// -----------------------------------------------------------------------------
// Answers of the YunoHost administration API -> plain values. Strict: a value
// of an unexpected shape is unknown (null), never 0; a count is an integer of
// what was really listed; every list walked is bounded. Only own keys are read
// (never an inherited or `__proto__` key). The answers hold domain names and
// app names: none of them leaves this file but the service names (they become
// feature names, and are not personal).
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { SERVICE_NAME } from '../config.js';
import { CODES, YnhError } from './errors.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
const bad = (what) => new YnhError(CODES.BAD_ANSWER, `Unexpected answer (${what})`);
const count = (n) => (Number.isInteger(n) && n >= 0 && n <= LIMITS.COUNT ? n : null);
/** "No date" of YunoHost: 99999 hours (a missing apt cache). */
const NO_DATE_SECONDS = 99999 * 3600;
const VERSION = /^[0-9][0-9A-Za-z.+~:-]{0,40}$/;

/**
 * GET /versions: { yunohost: { version, repo }, moulinette: {...}, ... }.
 * The envelope of the API: without it, this is not a YunoHost (BAD_ANSWER).
 */
export function parseVersions(json) {
  const ynh = own(json, 'yunohost');
  const version = own(ynh, 'version');
  if (!isObject(ynh) || typeof version !== 'string') throw bad('versions');
  return { version: VERSION.test(version) ? version : null };
}

/**
 * GET /update (the lists YunoHost keeps, never refreshed by this read):
 *   system: { <category>: [ { name, current_version, new_version } ] }
 *   apps: [ { id, upgrade: { status } } ]   (only the apps not up to date)
 *   important_yunohost_upgrade: boolean, pending_migrations: [ ... ],
 *   last_apt_update: seconds since the package lists were fetched.
 */
export function parseUpdates(json) {
  if (!isObject(json)) throw bad('updates');
  const system = own(json, 'system');
  const apps = own(json, 'apps');
  let systemUpdates = null;
  if (isObject(system)) {
    let n = 0;
    let walked = 0;
    let ok = true;
    for (const key of Object.keys(system)) {
      const list = system[key];
      if (!Array.isArray(list)) {
        ok = false;
        break;
      }
      walked += list.length;
      if (walked > LIMITS.ITEMS) {
        ok = false;
        break;
      }
      n += list.length;
    }
    systemUpdates = ok ? count(n) : null;
  }
  let appUpdates = null;
  if (Array.isArray(apps) && apps.length <= LIMITS.ITEMS) {
    let n = 0;
    let ok = true;
    for (const app of apps) {
      const status = own(own(app, 'upgrade'), 'status');
      if (typeof status !== 'string') {
        ok = false;
        break;
      }
      // What `yunohost tools update` counts as an app to upgrade.
      if (status === 'upgradable' || status === 'fail_requirements') n += 1;
    }
    appUpdates = ok ? count(n) : null;
  }
  const important = own(json, 'important_yunohost_upgrade');
  const migrations = own(json, 'pending_migrations');
  const last = own(json, 'last_apt_update');
  return {
    systemUpdates,
    appUpdates,
    major: typeof important === 'boolean' ? important : null,
    migrations: Array.isArray(migrations) ? count(migrations.length) : null,
    checkedSeconds: Number.isInteger(last) && last >= 0 && last < NO_DATE_SECONDS ? last : null,
  };
}

/** systemd sub-states: running is up; dead and failed are down; anything else unknown. */
function runningOf(status) {
  if (status === 'running') return 1;
  if (status === 'dead' || status === 'failed') return 0;
  return null;
}

/** One service of GET /services, or GET /services/<name>. */
export function parseService(info) {
  if (!isObject(info)) return null;
  const boot = own(info, 'start_on_boot');
  const changed = own(info, 'last_state_change');
  return {
    running: runningOf(own(info, 'status')),
    enabled: boot === 'enabled' ? true : boot === 'disabled' ? false : null,
    changed:
      typeof changed === 'string' && changed !== 'unknown' && changed.length <= 40 ? changed : null,
  };
}

/** GET /services: { <name>: { status, start_on_boot, last_state_change, ... } }. */
export function parseServices(json) {
  if (!isObject(json)) throw bad('services');
  const names = Object.keys(json).filter((n) => SERVICE_NAME.test(n));
  if (names.length > LIMITS.ITEMS) throw bad('services');
  const services = new Map();
  for (const name of names.sort().slice(0, LIMITS.SERVICES)) {
    const service = parseService(json[name]);
    if (service) services.set(name, service);
  }
  let down = 0;
  for (const s of services.values()) if (s.enabled === true && s.running === 0) down += 1;
  return { services, down };
}

/**
 * GET /diagnosis: { reports: [ { id, items: [ { status } ] } ] } (the items
 * the user did not ignore), or null when the diagnosis never ran.
 */
export function parseDiagnosis(json) {
  if (json === null) return { errors: null, warnings: null };
  const reports = own(json, 'reports');
  if (!Array.isArray(reports) || reports.length > 200) throw bad('diagnosis');
  let errors = 0;
  let warnings = 0;
  let walked = 0;
  for (const report of reports) {
    const items = own(report, 'items');
    if (!Array.isArray(items)) throw bad('diagnosis');
    walked += items.length;
    if (walked > LIMITS.ITEMS) throw bad('diagnosis');
    for (const item of items) {
      const status = own(item, 'status');
      if (status === 'ERROR') errors += 1;
      else if (status === 'WARNING') warnings += 1;
    }
  }
  return { errors, warnings };
}

/** A backup archive name (`20261110-201500`, or one typed): the pattern of YunoHost. */
export const ARCHIVE = /^[\w\-.]{1,50}$/;

/** GET /backups: { archives: [ <name>, ... ] }, the oldest first. */
export function parseBackups(json) {
  const archives = own(json, 'archives');
  if (!Array.isArray(archives) || archives.length > LIMITS.ITEMS) throw bad('backups');
  const newest = archives.at(-1);
  return {
    count: count(archives.length),
    newest:
      typeof newest === 'string' && ARCHIVE.test(newest) && !newest.endsWith('.') ? newest : null,
  };
}

/**
 * GET /backups/<name>: { created_at: ISO date (UTC), size, ... } -> ms, or null.
 * A date without a time zone is UTC (how YunoHost writes it).
 */
export function parseBackupInfo(json) {
  const created = own(json, 'created_at');
  if (typeof created !== 'string' || created.length > 40) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(created)
  ) {
    return null;
  }
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(created) ? created : `${created}Z`;
  const ms = Date.parse(zoned.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

/** POST /backups: { name, size, results }. */
export function parseBackupCreated(json) {
  const name = own(json, 'name');
  return typeof name === 'string' && ARCHIVE.test(name) ? name : null;
}
