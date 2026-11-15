# Releasing the desktop app

The desktop app (`apps/desktop`) is released through GitHub Releases by `.github/workflows/release.yml`. The workflow builds every platform, then creates a **draft** release. A maintainer reviews the draft and publishes it by hand. Nothing is published automatically, and the workflow uses no secrets: the release job only gets the automatic `GITHUB_TOKEN`, with `contents: write`.

Released builds have no server address baked in. On first launch they show a setup page that asks for the server's address. One build therefore works with any Backroom server.

## Cutting a release

1. Start from an up-to-date, clean `main`.
2. Set the version everywhere it lives:

   ```sh
   node scripts/set-version.mjs 1.2.3
   ```

   - It updates `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, the `backroom-desktop` entry in `apps/desktop/src-tauri/Cargo.lock`, and the `apps/desktop` entry in `package-lock.json`. It prints each file it changed.
   - It refuses to run on a tree with uncommitted changes (`--force` overrides that), and it refuses anything that is not `x.y.z` or `x.y.z-pre`.
   - Running it again with the same version changes nothing.
   - `node scripts/set-version.mjs 1.2.3 --check` only verifies the files. The workflow runs this check.
3. Run the tests (`npm test`), then commit: `git commit -am "chore(release): 1.2.3"`.
4. Tag the commit and push the tag:

   ```sh
   git tag v1.2.3
   git push origin main v1.2.3
   ```

5. Watch the **Release** workflow run in the Actions tab.
   - The `version` job fails straight away if the tag (minus the `v`) does not match the version in the files, so a mis-tagged commit never builds.
   - The `linux`, `windows` and `macos` jobs build the installers.
   - The `release` job checks that every expected file exists (and nothing else), writes `SHA256SUMS`, and creates a draft release named "Backroom 1.2.3". The notes list the commit subjects since the previous tag.
6. Open the draft under Releases and check it:
   - every asset from the table below is attached;
   - `SHA256SUMS` lists them all;
   - the notes read well (edit them freely);
   - run the [manual checklist](#manual-pre-release-checklist) against the attached installers.
7. Click **Publish release**. Only then can anyone see it. Package-manager manifests are bumped from this release's `SHA256SUMS` after publishing.

If a build fails, fix it on `main`, delete the tag (`git push origin :refs/tags/v1.2.3` and `git tag -d v1.2.3`), delete any draft that was created, and tag again. The release job refuses to create a release for a tag that does not exist on GitHub (`--verify-tag`). Re-running a finished release job can leave a second draft for the same tag; delete the stale one.

## Dry run (manual build)

From the Actions tab, choose **Release** → **Run workflow**, then pick a branch. `dry_run` defaults to true.

- **What it builds:** the same three build jobs as a tag run, for the version the files on that branch carry. The `version` job still checks that all five files agree.
- **Where the bundles land:** the run's **Artifacts** section, as `backroom-linux`, `backroom-windows` and `backroom-macos`. They are kept for 14 days.
- **What it never does:** create a release. Manual runs never create one, whatever `dry_run` says. The `release` job runs only for a pushed `v*.*.*` tag. `dry_run` exists so the intent shows in the run's inputs. A real release always starts with a tag push.

Use a dry run before the first tag of a release cycle, and after any change to the bundle config or the workflow.

## Pre-releases

A version with a pre-release part (`1.3.0-beta.1`) becomes a GitHub pre-release, still a draft. Some formats cannot carry such a version:

- **No RPM.** RPM versions may not contain `-`. The Tauri CLI fails with `invalid version "0.2.0-beta.1": contains invalid character` (verified by a local build), so the Linux job builds only the deb and the AppImage.
- **No MSI.** WiX accepts only a numeric pre-release of at most 65535 (Tauri documentation), so the Windows job builds only the NSIS installer.
- The deb is built, but Debian reads `1.3.0-beta.1` as upstream version `1.3.0` with revision `beta.1`. It therefore sorts **after** a later `1.3.0` deb. Testers should uninstall the pre-release deb before installing the final release.

## Asset names

`<v>` is the version without the `v`, for example `1.2.3`. These names are what the workflow's asset check expects. The package-manager manifests must use exactly these names.

| Platform | File | Notes | How the name was established |
|---|---|---|---|
| Linux (Debian, Ubuntu) | `Backroom_<v>_amd64.deb` | | **Verified** by a local `tauri build` (0.1.0 and 0.2.0-beta.1) |
| Linux (Fedora, openSUSE) | `Backroom-<v>-1.x86_64.rpm` | not built for pre-releases | **Verified** by a local build (0.1.0); the pre-release failure was verified too |
| Linux (any) | `Backroom_<v>_amd64.AppImage` | | **Verified** by a local build (0.1.0 and 0.2.0-beta.1) |
| Windows | `Backroom_<v>_x64-setup.exe` | NSIS, per-user install | Tauri documentation (`<productName>_<version>_<arch>-setup.exe`); not built here |
| Windows | `Backroom_<v>_x64_en-US.msi` | MSI; not built for pre-releases | Tauri documentation (`<productName>_<version>_<arch>_<lang>.msi`); not built here |
| macOS (Apple silicon and Intel) | `Backroom_<v>_universal.dmg` | one universal dmg | Tauri documentation (`<productName>_<version>_<arch>.dmg`, `universal` for `universal-apple-darwin`); not built here |
| All | `SHA256SUMS` | `sha256sum` format, file names sorted | written by the release job |

Windows and macOS cannot be built on the Linux machine where this was set up. The first dry run confirms those names: if a name is wrong, the build job's "Collect the installers" step fails and lists what was produced.

Users can check a download with `sha256sum -c SHA256SUMS --ignore-missing` (on macOS: `shasum -a 256 -c SHA256SUMS --ignore-missing`).

## What the bundles contain

- **Linux:** the deb and rpm install `/usr/bin/backroom-desktop`, icons, and `Backroom.desktop`. The desktop file has `Exec=backroom-desktop %u` and `MimeType=x-scheme-handler/backroom;`, so `backroom://` links open the app. Dependencies are `libwebkit2gtk-4.1-0`, `libgtk-3-0` and `libayatana-appindicator3-1`. The AppImage carries its own libraries and registers the scheme itself on first start.
- **Windows:**
  - the NSIS installer installs for the current user only (no administrator prompt), adds a Start Menu shortcut, shows the MIT license, and runs in English;
  - when WebView2 is missing, it downloads Microsoft's bootstrapper and installs WebView2, which needs a network connection;
  - it registers `backroom://` under the current user's `Software\Classes`;
  - the MSI (English, fixed upgrade code) carries the same app.
- **macOS:** a universal `Backroom.app` inside the dmg. It keeps the bundle identifier `app.backroom.desktop`, needs at least macOS 10.13 (Tauri's default), and has the Productivity category. The `backroom://` scheme comes from the deep-link plugin configuration (CFBundleURLTypes in Info.plist). It is not signed, and hardened runtime is off.

## Unsigned builds: what users will see

The project has no code-signing certificates, so none of the installers are signed (ruling P8-R2).

- **Windows:**
  - SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.
  - Some antivirus tools may also flag a new unsigned installer.
  - The MSI shows "Unknown publisher".
- **macOS:**
  - Gatekeeper refuses to open the app ("Backroom can't be opened because Apple cannot check it for malicious software", or on newer macOS versions "Backroom Not Opened").
  - Fix: drag Backroom into Applications, then **right-click (or Control-click) Backroom → Open → Open**.
  - On macOS 15 and later, the override lives in **System Settings → Privacy & Security → Open Anyway**.
  - From a terminal: `xattr -dr com.apple.quarantine /Applications/Backroom.app`.
- **Linux:** no warning. The deb, rpm and AppImage are not GPG-signed, so check them against `SHA256SUMS`.

Describe this in the release notes for every release (the workflow's generated notes already include a short line).

## Adding signing later (not implemented)

Nothing below exists in the workflow today. If a maintainer gets certificates, these are the names Tauri uses, according to its documentation. Each one would become a repository secret, passed as an environment variable to the matching build step only.

- **Windows (Authenticode):**
  - either import a PFX certificate (secrets such as `WINDOWS_CERTIFICATE` holding the base64 PFX, and `WINDOWS_CERTIFICATE_PASSWORD`) and set `bundle.windows.certificateThumbprint`, `digestAlgorithm` and `timestampUrl` in `tauri.windows.conf.json`;
  - or set `bundle.windows.signCommand` for a cloud signing service (for example Azure Trusted Signing with `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`).
- **macOS (signing and notarization):** `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, plus either `APPLE_ID`, `APPLE_PASSWORD` (app-specific password) and `APPLE_TEAM_ID`, or `APPLE_API_ISSUER`, `APPLE_API_KEY` and `APPLE_API_KEY_PATH`. Hardened runtime (`bundle.macOS.hardenedRuntime`) should be turned back on with signing.
- **Linux:** `TAURI_SIGNING_RPM_KEY` and `TAURI_SIGNING_RPM_KEY_PASSPHRASE` (GPG-signed RPM). For the AppImage: `SIGN`, `SIGN_KEY` and `APPIMAGETOOL_SIGN_PASSPHRASE`.
- **Updater artifacts** (only if an updater is ever added): `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Signing secrets must never reach the `version` or `release` jobs, or any workflow that runs for pull requests.

## Manual pre-release checklist

None of these can be automated in CI. Run them on the draft's installers, on a real desktop for each OS, before publishing.

- [ ] **First-run setup page in a real webview:** WebKitGTK (Linux), WebView2 (Windows) and WKWebView (macOS).
  - Start with no saved server: delete `server.json` from the app's config directory (`~/.config/app.backroom.desktop/` on Linux).
  - The page appears, and typing a server address checks it and connects. This confirms that the page's CSP allows the IPC calls.
  - Hostile input is refused: `javascript:alert(1)`, `file:///etc/passwd`, `https://user:pass@host`, `https://host/path`.
  - Plain `http://` to a public host is refused; `http://localhost:8787` asks for confirmation.
- [ ] **Sign-in round trip:** the email link opens the browser, which hands back to the app through `backroom://`, and the app ends up signed in.
- [ ] **macOS app menu:** "Change server…" appears after "About". It clears the server and restarts into the setup page.
- [ ] **Linux without a tray** (for example GNOME without the AppIndicator extension):
  - the window shows the small "Backroom" menu bar with "Change server…" and "Quit";
  - closing the window quits.
  - With a tray: Show, Change server… and Quit work.
- [ ] **Internal CA:** a server whose certificate comes from a CA installed in the OS trust store passes the setup check (the health check uses the OS store, like the webview).
- [ ] **Windows installer and uninstaller:**
  - NSIS installs without an administrator prompt, creates the Start Menu entry, and launches;
  - the uninstaller (Settings → Apps) removes the app and its Start Menu entry;
  - the MSI installs and uninstalls as well;
  - on a machine without WebView2, the bootstrapper installs it.
- [ ] **Deep link registration after install, on each OS:** opening `backroom://channel/<id>` from a browser launches or focuses Backroom.
  - Linux: check deb, rpm and AppImage, including `xdg-mime query default x-scheme-handler/backroom`.
  - Windows: check NSIS and MSI.
  - macOS: check the dmg install in /Applications.
- [ ] **Change server** revokes the old origin: after switching, the old server's pages can no longer call the app's commands.
- [ ] **Version:** the package metadata (and macOS "About Backroom") shows the tagged version, and `SHA256SUMS` matches the downloaded files.
