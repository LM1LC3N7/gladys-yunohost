# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for YunoHost servers: a Node.js
service (Node 22+, ESM, no build step) that runs in its own sandboxed Docker
container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It reads one server through the administration
API of YunoHost (AGPL: only called, nothing of it copied), and offers four
kinds of buttons, each off by default. See `TODO.md` for the status and every
decision.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "restart"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run cover                             # regenerate cover.png (plain Node)
node scripts/mutants.mjs [3,7]            # mutation check of the guards (memcap)
```

## Architecture

```
index.js                 SDK wiring only (src/handlers.js)
src/handlers.js          every SDK handler, registered before connect()
src/app.js               YnhApp: start, /data, pace, failures, certificate, login gate, states, actions
src/ynh/client.js        the API: login, reading (main + secondary routes), actions
src/ynh/http.js          the only network access (HTTPS, fingerprint checked first, no redirect)
src/ynh/parse.js         answers -> plain values (strict counts, bounded lists)
src/ynh/errors.js        error codes
src/devices.js           the server device (pure), never fewer features
src/config.js            DEFAULTS (mirror the manifest) + normalization
src/store.js             /data: salt, pins, refusal, gate, pause, delays, last attempt
src/publisher.js         states within 250 per minute
src/i18n.js              statuses and messages (en / fr)
scripts/mutants.*        mutation list and runner (not in the image, not in CI)
test/                    node --test, fake Gladys (SDK) + fake server + loopback TLS
```

## Rules

- **External ids are forever**: `server:main`, the feature keys of
  `src/constants.js`, `service_<id>` and `restart_<id>`. The same goes for the
  manifest keys and the action keys.
- **The actions** are `button`/`push`, never a switch nor a binary, each
  refused unless its option allows it (checked at the press, after the fresh
  read and in `beforeSend`). Any new action needs Louis's decision, off by
  default, never a switch. Gladys never upgrades, backs up nor restarts by
  itself.
- **Credentials**: only the login route refuses them (401 there); a 401 or a
  403 elsewhere, an unreadable or cut answer, never. After a 401, no login at
  all before the gate (fail2ban).
- **Secondary routes** (updates, services, diagnosis, backups) never block
  nor pause a reading, and a 401 there never opens a session; a final
  failure (certificate, login) is never swallowed.
- **/data**: every read and write bounded in time; a FIFO never waited for;
  unreadable is not empty (no pin learned, no action), read again every 10 s,
  one read at a time, what memory decided meanwhile merged.
- **The certificate** is checked before any byte is written: one Node
  verifies (public authority, name typed) is accepted unpinned; any other is
  pinned, the first pin written to /data before the password goes; one that
  stops verifying at a public address stops everything. Never turn the check
  off. HTTPS only.
- **Secrets and personal data**: the password, the session cookie, the
  domains, app names and messages of the server are never in a log, an error
  message, a status, a state or /data (`test/app.test.js` checks it).
- **Clocks**: one read of the monotonic clock per decision (`dueAt(mono)`);
  the tests use a clock that moves at every read, and `test/realclock.test.js`
  runs on the real clock.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  them by hand (0.1.0 was set by hand once). `test/manifest.test.js` checks
  they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`.
- **Manifest.** Texts are `{ "en": ..., "fr": ... }`; a secret field has no
  default and is described as kept by Gladys in its database, never shown
  again, never as protected by any cipher.
- **Units**: only those the core lists for the category.
- **Encoding.** UTF-8 without BOM, no mojibake (`test/encoding.test.js`).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
