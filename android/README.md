# Android companion

This authored native Android companion displays usage/quota snapshots and home-screen widgets. It does not manage MCP servers or desktop endpoint listeners.

Configure your own ntfy server, private topic and optional token in both desktop Settings and the Android app. The default server is `https://ntfy.sh`; topic and token are empty, so no shared personal channel is configured. Snapshot transport is separate from encrypted library Sharing.

Build prerequisites: JDK 17, Android SDK 34 and Gradle compatible with the Android Gradle Plugin version in `build.gradle`. Configure your local SDK through Android Studio or an ignored `local.properties` file. This tree does not include a Gradle wrapper. Build with `gradle :app:assembleDebug` from this directory after configuring those prerequisites.

The companion source is included for development; desktop 1.0 release assets target Windows and macOS. Release signing requires your own keystore, which must remain outside Git.
