# Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Clascheurduturfu/ai-usage/security/advisories/new). Do not include live tokens, API keys or private account data in a public issue.

## Data and credentials

Usage history is stored locally. Saved endpoint keys and app-managed OAuth credentials use current-user DPAPI on Windows and a Keychain-protected encryption key on macOS. Custom MCP environment/header secrets remain in local client/registry configuration; the ntfy settings token is stored with local settings. Those device files must not be committed or attached to issues. These protections do not replace operating-system account security.

Encrypted Sharing intentionally includes saved endpoint API keys, local connection keys and portable OAuth credentials. Anyone with both the encrypted file and its passphrase can import them. Use a strong unique passphrase and a folder shared only with trusted devices or people. A provider can still expire or revoke a grant.

MCP installations and skills may contain executable third-party code. Review their source and requested permissions. AI Usage is a manager, not a sandbox for those programs.

Local endpoint listeners bind to `127.0.0.1`. Enable a client key for a credential-backed connection unless every local caller is trusted. No-key mode is an explicit compatibility option. Listeners are stopped on new imports unless an existing device's local autostart preference is retained.

ntfy snapshot sharing is off until a topic is configured. Use a private authenticated topic: snapshots may contain usage, quota, model and account metadata. ntfy snapshot transport is separate from encrypted library Sharing.

## Releases

Version 1.0 packages are unsigned on Windows and use an ad-hoc signature on macOS. They are not notarized. In-app automatic updates are not included in 1.0; future updater artifacts must use a dedicated signing key rather than a credential embedded in source.
