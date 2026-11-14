# Desktop release updates

`pi-agent-desktop` 会将已安装的 macOS、Windows 或 Linux 应用作为一个由 updater 签名的完整包更新。该安装包会记录三个组件在 `src-tauri/resources/component-versions.json` 中的确切版本：

1. `abcwyc/pi-agent-desktop`
2. `earendil-works/pi`
3. `agegr/pi-web`

The settings screen checks only the latest stable `abcwyc/pi-agent-desktop` GitHub Release, at most once a week. If the installed desktop app version is older, its single **Upgrade** button downloads that signed release, installs the complete app, and restarts it. It never replaces JavaScript or dependencies inside an already installed signed app.

## Automatic component sync

`.github/workflows/component-updates.yml` runs every day and can also be started manually. It applies updates in dependency order:

1. update all `@earendil-works/pi-*` packages to the released `pi` version;
2. merge the released `pi-web` tag;
3. bump `pi-agent-desktop`, regenerate the component manifest, and run tests, typecheck, and lint;
4. commit and push the verified result directly to `main`;
5. explicitly dispatch the signed desktop release workflow.

The repository intentionally keeps only `main`; the automation does not create a component-update branch or pull request. Pushes use no force option. If an upstream merge conflicts or any validation fails, the workflow stops before updating `main` or publishing a Release, and the failed Actions run must be resolved manually.

## One-time signing setup

Tauri updater signatures are mandatory. Generate the updater signing key once on a trusted machine:

```bash
npm exec tauri signer generate -- -w ~/.tauri/pi-agent-desktop.key
```

Store these repository Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the private key file;
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password chosen during generation;
- `TAURI_UPDATER_PUBLIC_KEY`: the exact Base64 contents of the `.pub` file generated next to the private key.

The release workflow validates this public key before installing dependencies and
injects it into Tauri's updater configuration for both bundle signing and runtime
verification. The key is never printed by the workflow.

Never commit the private key or its password. The public key is embedded at compile time only in release builds. Local builds deliberately do not register the updater plugin.

## Publishing

After a successful component sync updates `main`, it explicitly starts **Publish signed desktop release**. The release workflow can also be started manually. It verifies that the bundled `pi` and `pi-web` versions exactly match their latest stable Releases, then sequentially creates Apple Silicon (`aarch64`) and Intel Mac (`x86_64-apple-darwin`, `x64` assets) DMG/updater artifacts, a Linux x64 `.deb`, and a Windows x64 NSIS `-setup.exe`/updater archive. The Intel build is cross-compiled on the Apple Silicon runner with an x64 Node, which `prepare-desktop` bundles as the server runtime; a `lipo` check fails the job if that runtime does not match the target. `latest.json` carries both `darwin-aarch64` and `darwin-x86_64`, and the Homebrew job writes both DMG digests into the cask. The Release stays in draft until all platforms and the component manifest are present; only then is `v<pi-agent-desktop version>` published as the latest Release.

The workflow currently uses ad-hoc macOS application signing, Tauri updater signatures, and the native Linux package format. Before distributing outside a controlled environment, configure an Apple Developer ID certificate/notarization and a Windows Authenticode certificate. Without Authenticode, Windows may show a SmartScreen warning even though updater verification remains cryptographically signed.
