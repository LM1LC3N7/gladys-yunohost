# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: one YunoHost server read through the API of its web
  administration: version, system packages and apps to upgrade, major upgrade
  available, pending migrations, age of the package lists, services down and
  per service running, diagnosis errors and warnings, local backups and the
  age of the newest, last action.
- HTTPS: a certificate of a public authority for the name typed accepted as
  Node verifies it (Let's Encrypt renewals included); any other pinned before
  the password is sent; another one, or a public one that stops verifying,
  stops everything until it is trusted (two clicks) or typed.
- After a refused login, no other login for 5 min, doubling per refusal in a
  row (fail2ban).
- A public certificate that no longer verifies says why (expired, another
  name, no authority); a stop cuts a reading in flight and writes /data.
- Buttons, off by default: upgrade the system, upgrade the apps (one option),
  back up the server (one option), restart the services listed; a delay
  between two presses of the same action.

[Unreleased]: https://github.com/LM1LC3N7/gladys-yunohost/commits/main
