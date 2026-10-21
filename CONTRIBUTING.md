# Contributing

Start with an issue describing the observable problem or feature. Keep changes focused, preserve existing user configuration and distinguish local preparation, connection checks and live client sessions.

## Development

Use Node.js 24.14 or newer within the 24.x line, Rust stable and the native build prerequisites in the README.

```sh
npm ci
npm run dev
```

The UI preview uses fictional data and does not contact providers:

```sh
npm run preview:ui
```

Before requesting review, run the checks appropriate to your change and describe their results. Available checks are `npm run typecheck`, `npm test` and a native package build. Provider-dependent checks require your own local credentials; never put them in a fixture or CI configuration. A successful tools-list check does not prove every tool permission or integration.

## Repository boundaries

Commit authored source, lockfiles, public documentation and license notices. Dependencies, Rust targets, packaged installers, databases, logs, device configuration and credential stores belong outside Git. Use reserved example domains and invented data in fixtures. Inspect screenshots and binary metadata before publication.

Do not embed a default account, shared ntfy topic, private endpoint or agent profile. Optional endpoint templates may contain documented public API URLs but no credential or active listener.
