# Desktop release updates

`pi-agent-desktop` updates the installed macOS app as one signed, atomic bundle. The bundle records the exact versions of all three components in `src-tauri/resources/component-versions.json`:

1. `abcwyc/pi-agent-desktop`
2. `earendil-works/pi`
3. `agegr/pi-web`

The settings screen checks the three repositories' latest stable GitHub Releases once a week. If any bundled version is older, its single **Upgrade** button downloads the newest signed `pi-agent-desktop` release, installs the complete app, and restarts it. It never replaces JavaScript or dependencies inside an already installed signed app.

## Weekly component sync

`.github/workflows/component-updates.yml` runs every Monday and can also be started manually. It applies updates in dependency order:

1. update all `@earendil-works/pi-*` packages to the released `pi` version;
2. merge the released `pi-web` tag;
3. bump `pi-agent-desktop`, regenerate the component manifest, and run tests, typecheck, and lint;
4. open or refresh `codex/component-updates` as a reviewable pull request.

Merge that pull request only after reviewing any upstream conflicts or UI changes.

The repository must allow GitHub Actions to create pull requests. If that setting is disabled, the version check still fails visibly in Actions but cannot open the sync pull request.

## One-time signing setup

Tauri updater signatures are mandatory. Generate the updater signing key once on a trusted machine:

```bash
npm exec tauri signer generate -- -w ~/.tauri/pi-agent-desktop.key
```

Store these repository Actions secrets:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the private key file;
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password chosen during generation;
- `TAURI_UPDATER_PUBLIC_KEY`: the printed public key.

Never commit the private key or its password. The public key is embedded at compile time only in release builds. Local builds deliberately do not register the updater plugin.

## Publishing

Merging a component sync pull request changes `src-tauri/pi-agent-desktop-package.json` and automatically starts **Publish signed macOS release**. It can also be started manually. The workflow verifies that the bundled `pi` and `pi-web` versions exactly match their latest stable Releases, then sequentially creates Apple Silicon and Intel app artifacts so their shared `latest.json` cannot race. The Release stays in draft until both signed updater archives and the component manifest are present; only then is `v<pi-agent-desktop version>` published as the latest Release.

The workflow currently uses ad-hoc macOS application signing. Before distributing outside a controlled environment, configure an Apple Developer ID certificate and notarization in the release workflow as well.
