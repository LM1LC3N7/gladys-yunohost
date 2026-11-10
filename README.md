# gladys-yunohost

A [Gladys Assistant](https://gladysassistant.com) external integration for
**YunoHost** servers (11.1 or later), through the API of their web
administration, in HTTPS (a certificate of a public authority, or else a
pinned one) with an administrator account.

- One device per server: YunoHost version, system packages and apps to
  upgrade, major upgrade available, pending migrations, age of the package
  lists, services down and per service running, diagnosis errors and
  warnings, local backups and the age of the newest, last action.
- Buttons, each off by default, never a switch: **upgrade the system**,
  **upgrade the apps**, **back up the server**, **restart** a listed service.
- A refused login holds every other login for 5 min or more (fail2ban).

**Never tested with a real YunoHost server**: follows the routes of the
administration API described by the YunoHost developer documentation
(actionsmap), tested against a fake server.

YunoHost is AGPL-3.0: this integration only calls its API; none of its code is
copied nor ported (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

Unofficial integration, not affiliated with the YunoHost project.

- User documentation: [English](docs/en.md), [français](docs/fr.md).
- Status, decisions and next steps: [TODO.md](TODO.md).
- Rules for contributors: [CLAUDE.md](CLAUDE.md).
- Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
node scripts/mutants.mjs      # mutation check of the guards (one at a time)
```

License: Apache-2.0 ([LICENSE](LICENSE)).
