// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// No key starts with `gladys_` (the core keeps GLADYS_* for itself).
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS, POLL_INTERVALS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  poll_interval: '15',
  allow_upgrades: false,
  allow_backup: false,
  restart_services: '',
});

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
/**
 * A YunoHost administrator: a user of the `admins` group (a POSIX user name:
 * lower case letters, digits, `_`, `-`, `.`). The login sends `user:password`,
 * so a `:` is never part of it.
 */
const USERNAME = /^[a-z0-9_][a-z0-9_.-]{0,63}$/;
/** A control character (a newline pasted with the password). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
/** A systemd service name as YunoHost lists it (`php8.2-fpm`, `yunohost-api`). */
export const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,63}$/;

/** The port: an integer 1-65535, or null. */
export function parsePort(value) {
  if (!/^\d{1,5}$/.test(value ?? '')) return null;
  const n = Number(value);
  return n > 0 && n < 65536 ? n : null;
}

/** An IPv4 address that is never one server: any, broadcast, multicast. */
function forbiddenV4(host) {
  const [a, b, c, d] = host.split('.').map(Number);
  if (a === 0) return true;
  if (a >= 224) return true;
  return a === 255 && b === 255 && c === 255 && d === 255;
}

/**
 * The server: an IPv4 address, a host name or an IPv6 address (brackets
 * allowed), with an optional port and an optional `https://`. HTTPS only:
 * the administration of YunoHost is never served in plain HTTP (`http://`
 * is refused, the password would cross the network readable). An address
 * pasted from a browser (`https://box.example/yunohost/admin/`) is read as its
 * host and port. Credentials, a query, a fragment are refused.
 *   -> { host, port } or { error: 'missing' | 'invalid' | 'http' }
 */
export function parseHost(value) {
  let raw = text(value);
  if (!raw) return { error: 'missing' };
  if (raw.length > 300) return { error: 'invalid' };
  let port = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { error: 'invalid' };
    }
    if (url.protocol === 'http:') return { error: 'http' };
    if (url.protocol !== 'https:') return { error: 'invalid' };
    if (url.username || url.password || url.search || url.hash) return { error: 'invalid' };
    port = url.port ? Number(url.port) : null;
    raw = url.hostname;
  } else {
    const match = /^([^:[\]/]+):(\d{1,5})$/.exec(raw) ?? /^\[([^\]]+)\]:(\d{1,5})$/.exec(raw);
    if (match) {
      raw = match[1];
      port = parsePort(match[2]);
      if (port === null) return { error: 'invalid' };
    } else if (raw.includes('/')) {
      return { error: 'invalid' };
    }
  }
  const host = raw.replace(/^\[(.*)\]$/, '$1');
  const out = (h) => ({ host: h, port: port ?? DEFAULT_PORT });
  if (IPV4.test(host)) {
    if (!host.split('.').every((n) => Number(n) <= 255)) return { error: 'invalid' };
    if (forbiddenV4(host)) return { error: 'invalid' };
    return out(host);
  }
  if (host.includes(':')) {
    if (!IPV6.test(host)) return { error: 'invalid' };
    const lower = host.toLowerCase();
    // The unspecified address and multicast are never one server.
    if (/^(::|0*:)+0*$/.test(lower) || /^ff/.test(lower)) return { error: 'invalid' };
    return out(lower);
  }
  return HOSTNAME.test(host) ? out(host.toLowerCase().replace(/\.$/, '')) : { error: 'invalid' };
}

/**
 * A SHA-256 fingerprint as typed (colons, spaces or nothing between the
 * bytes, any case) -> `AA:BB:...` (Node's `fingerprint256`), '' when empty,
 * null when it is not 32 bytes of hex.
 */
export function parseFingerprint(value) {
  const raw = text(value).replace(/^sha-?256\s*[:=]?\s*/i, '');
  if (!raw) return '';
  const hex = raw.replace(/[\s:-]/g, '');
  if (!/^[0-9A-Fa-f]{64}$/.test(hex)) return null;
  return hex.toUpperCase().match(/../g).join(':');
}

/**
 * The services Gladys may restart, as typed: names separated by commas,
 * spaces or new lines. -> { names: string[] (unique, in order), invalid: boolean }
 */
export function parseServices(value) {
  const raw = text(value);
  if (!raw) return { names: [], invalid: false };
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  const names = [];
  for (const part of parts) {
    if (!SERVICE_NAME.test(part)) return { names: [], invalid: true };
    if (!names.includes(part)) names.push(part);
  }
  if (names.length > LIMITS.RESTARTABLE) return { names: [], invalid: true };
  return { names, invalid: false };
}

/** A boolean of the configuration: true only for true (or "true"). */
const flag = (value) => value === true || value === 'true';

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const target = parseHost(raw.host);
  const username = text(raw.username);
  // The password is kept as typed (a space may belong to it), never trimmed.
  const password = typeof raw.password === 'string' ? raw.password : '';
  const fingerprint = parseFingerprint(raw.certificate_fingerprint);
  const poll = POLL_INTERVALS.includes(String(raw.poll_interval))
    ? String(raw.poll_interval)
    : DEFAULTS.poll_interval;
  const services = parseServices(raw.restart_services);
  return {
    host: target.error ? null : target.host,
    hostError: target.error ?? null,
    port: target.error ? DEFAULT_PORT : target.port,
    username,
    usernameInvalid: username !== '' && !USERNAME.test(username),
    password,
    // A newline or a control character pasted with it: said, never sent.
    passwordInvalid: password !== '' && (CONTROL.test(password) || password.length > 256),
    /** The fingerprint typed: '' none, null invalid. */
    fingerprint,
    pollMs: Number(poll) * 60_000,
    allowUpgrades: flag(raw.allow_upgrades),
    allowBackup: flag(raw.allow_backup),
    restartable: services.names,
    servicesInvalid: services.invalid,
  };
}

/** `https://host:port`: the key of the pin, the refusal, the pause and the cooldowns in /data. */
export const targetKey = (config) => `https://${config.host}:${config.port}`;
