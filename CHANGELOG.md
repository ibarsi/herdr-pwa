# Changelog

## 0.5.0 (2026-10-05)

### Features

- spellcheck replies, recall sent ones, and trim the key row (#9)

### CI

- **deps:** bump actions/checkout from 4 to 7 (#7)
- **deps:** bump docker/setup-qemu-action from 3 to 4 (#4)
- **deps:** bump docker/login-action from 3 to 4 (#5)
- **deps:** bump docker/metadata-action from 5 to 6 (#6)
- **deps:** bump actions/setup-node from 4 to 7 (#8)
- watch actions and the Node image with Dependabot

## 0.4.0 (2026-09-25)

### Features

- stream the feed and agent list instead of polling (#3)

## 0.3.0 (2026-09-22)

### Features

- show a light for the Herdr connection

### CI

- push the release tag with the version commit

## 0.2.0 (2026-09-22)

### Features

- publish versioned GHCR releases from conventional commits (#1)
- colour the feed by line role and tint the header by status
- title agents by space name, widen recent scrollback
- Docker Compose deployment on loopback
- Herdr socket adapter, HTTP API, and PWA shell

### Fixes

- open the feed on scrollback instead of the visible screen

### CI

- cut a release when main is updated

### Chores

- **release:** 0.1.0
- drop the manual mise release task
- mise tasks and setup docs

## 0.1.0 (2026-09-22)

### Features

- publish versioned GHCR releases from conventional commits (#1)
- colour the feed by line role and tint the header by status
- title agents by space name, widen recent scrollback
- Docker Compose deployment on loopback
- Herdr socket adapter, HTTP API, and PWA shell

### Fixes

- open the feed on scrollback instead of the visible screen

### CI

- cut a release when main is updated

### Chores

- drop the manual mise release task
- mise tasks and setup docs
