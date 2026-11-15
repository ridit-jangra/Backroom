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
   - Major and minor may be at most 255 and patch at most 65535: an MSI product version cannot carry more.
   - It refuses files with CRLF line endings (convert them to LF first).
   - Running it again with the same version changes nothing.
   - `node scripts/set-version.mjs 1.2.3 --check` only verifies the files. The workflow runs this check.
3. Run the tests (`npm test`), then commit: `git commit -am "chore(release): 1.2.3"`.
4. Tag the commit and push the branch and the tag together:

   ```sh
   git tag v1.2.3
   git push --atomic origin main v1.2.3
   ```

   `--atomic` pushes both or neither. The tag must point at a commit of `main`: the workflow refuses to build any other commit. Protect release tags with a repository ruleset (Settings → Rules → Rulesets → new tag ruleset targeting `v*`, restricting creation, update and deletion to maintainers), so nobody else can push a `v*` tag.

5. Watch the **Release** workflow run in the Actions tab.
   - The `version` job fails straight away if the tagged commit is not on `main`, or if the tag (minus the `v`) does not match the version in the files, so a mis-tagged commit never builds.
   - The `linux`, `windows` and `macos` jobs build the installers.
   - The `arch` job builds the Arch package (`backroom-bin`) in an Arch container from the deb the `linux` job just built, and runs `namcap`. The `arch-source` job builds the from-source `backroom` package end to end. Both are skipped for pre-releases.
   - The `release` job:
     - checks that every expected file exists (and nothing else);
     - writes `SHA256SUMS` and compares it with the hashes each build job recorded right after building;
     - refuses to continue if any release (draft or published) already exists for the tag;
     - creates a draft release named "Backroom 1.2.3", whose notes list the commit subjects since the previous tag;
     - downloads every uploaded asset again and checks it against `SHA256SUMS`.
6. Open the draft under Releases and check it:
   - every asset from the table below is attached;
   - `SHA256SUMS` lists them all;
   - the notes read well (edit them freely). Every `@` in a commit subject gets an invisible zero-width space after it so the notes cannot mention a user or team, but still scan the notes for anything that should not be public before publishing;
   - run the [manual checklist](#manual-pre-release-checklist) against the attached installers.
7. Click **Publish release**. Only then can anyone see it. Then bump the package-manager manifests from this release's `SHA256SUMS` and publish them by hand: see [packaging/README.md](../packaging/README.md).

If a build fails, fix it on `main`, delete the tag (`git push origin :refs/tags/v1.2.3` and `git tag -d v1.2.3`), delete any draft that was created, and tag again. The release job refuses to create a release for a tag that does not exist on GitHub (`--verify-tag`). It also stops with an error when a release for the tag already exists; delete that draft or release first, then re-run the job.

## Dry run (manual build)

From the Actions tab, choose **Release** → **Run workflow**, then pick a branch. `dry_run` defaults to true.

- **What it builds:** the same three build jobs as a tag run, for the version the files on that branch carry. The `version` job still checks that all five files agree.
- **Where the bundles land:** the run's **Artifacts** section, as `backroom-linux`, `backroom-windows`, `backroom-macos` and `backroom-arch`. Each holds `release-assets/` (the installers) and `hashes/<job>.sha256`. They are kept for 14 days.
- **Caches:** a dry run may restore the Rust build cache, and only a dry run on `main` saves it. Tag builds never restore any cache, so nothing another run wrote can end up in a released installer.
- **What it never does:** create a release. Manual runs never create one, whatever `dry_run` says. The `release` job runs only for a pushed `v*.*.*` tag. `dry_run` exists so the intent shows in the run's inputs. A real release always starts with a tag push.

Use a dry run before the first tag of a release cycle, and after any change to the bundle config or the workflow.

## Pre-releases

A version with a pre-release part (`1.3.0-beta.1`) becomes a GitHub pre-release, still a draft. Some formats cannot carry such a version:

- **No RPM.** RPM versions may not contain `-`. The Tauri CLI fails with `invalid version "0.2.0-beta.1": contains invalid character` (verified by a local build), so the Linux job builds only the deb and the AppImage.
- **No MSI.** WiX accepts only a numeric pre-release of at most 65535 (Tauri documentation), so the Windows job builds only the NSIS installer.
- **No Arch package, no manifests.** pacman versions cannot contain `-`, so the `arch` jobs are skipped. The package-manager manifests (`packaging/`) target stable releases only, and `scripts/packaging-bump.mjs` refuses pre-release versions.
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
| Arch Linux | `backroom-bin-<v>-1-x86_64.pkg.tar.zst` | `sudo pacman -U`; not built for pre-releases | **Verified** by a local `makepkg` of `packaging/aur/backroom-bin` from the 0.1.0 deb |
| All | `SHA256SUMS` | `sha256sum` format, file names sorted | written by the release job |

Windows and macOS cannot be built on the Linux machine where this was set up. The first dry run confirms those names: if a name is wrong, the build job's "Collect the installers" step fails and lists what was produced.

Users can check a download with `sha256sum -c SHA256SUMS --ignore-missing` (on macOS: `shasum -a 256 -c SHA256SUMS --ignore-missing`).

## What the bundles contain

- **Linux:** the deb and rpm install `/usr/bin/backroom-desktop`, icons, and `Backroom.desktop`. The desktop file has `Exec=backroom-desktop %u` and `MimeType=x-scheme-handler/backroom;`, so `backroom://` links open the app. Dependencies are `libwebkit2gtk-4.1-0`, `libgtk-3-0` and `libayatana-appindicator3-1`. The AppImage carries its own libraries and registers the scheme itself on first start.
- **Windows:**
  - the NSIS installer installs for the current user only (no administrator prompt), adds a Start Menu shortcut, and runs in English. It should show the MIT license (from the Tauri documentation, confirm on the first dry run);
  - when WebView2 is missing, it downloads Microsoft's bootstrapper and installs WebView2, which needs a network connection;
  - it registers `backroom://` under the current user's `Software\Classes` (seen in the NSIS template inside the Tauri CLI);
  - the MSI (English, fixed upgrade code) carries the same app. It should register `backroom://` and show the license as well (from the Tauri documentation, confirm on the first dry run).
- **macOS:** a universal `Backroom.app` inside the dmg. It keeps the bundle identifier `app.backroom.desktop`, needs at least macOS 10.13 (Tauri's default), and has the Productivity category. The `backroom://` scheme should come from the deep-link plugin configuration as CFBundleURLTypes in Info.plist (from the Tauri documentation, confirm on the first dry run). The app is ad-hoc signed (`signingIdentity: "-"` in `tauri.macos.conf.json`): it has a signature, but no certificate and no notarization. Hardened runtime is off.

## Unsigned builds: what users will see

The project has no code-signing certificates, so none of the installers are signed with a certificate (ruling P8-R2). The macOS app is only ad-hoc signed.

- **Windows:**
  - SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**.
  - Some antivirus tools may also flag a new unsigned installer.
  - The MSI shows "Unknown publisher".
- **macOS** (expected behaviour; confirm on the first dry run):
  - Without a signature, Apple silicon Macs usually report the app as "damaged" with no way to open it. The ad-hoc signature is there to avoid that.
  - With the ad-hoc signature, Gatekeeper should refuse the first launch with an overridable warning ("Backroom can't be opened because Apple cannot check it for malicious software", or "Backroom Not Opened" on newer versions).
  - Override: drag Backroom into Applications, then **right-click (or Control-click) Backroom → Open → Open**. On macOS 15 and later the override lives in **System Settings → Privacy & Security → Open Anyway**.
  - Guaranteed workaround, whatever the dialog says: `xattr -dr com.apple.quarantine /Applications/Backroom.app` in a terminal, then open the app normally.
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

## Known residual: unpinned AppImage tooling

To build the AppImage, the Tauri CLI downloads `linuxdeploy` and its plugins from GitHub on every run, without pinning or checksums. One of them, `linuxdeploy-plugin-appimage`, comes from a `continuous` release URL whose contents can change. This is upstream Tauri CLI behaviour and the workflow cannot pin it today. Of all the release artifacts, the AppImage therefore has the weakest supply chain. The deb and rpm are written by the CLI itself.

## Manual pre-release checklist

None of these can be automated in CI. Run them on the draft's installers, on a real desktop for each OS, before publishing.

- [ ] **First-run setup page in a real webview:** WebKitGTK (Linux), WebView2 (Windows) and WKWebView (macOS).
  - Start with no saved server: delete `server.json` from the app's config directory (`~/.config/app.backroom.desktop/` on Linux).
  - The page appears, and typing a server address checks it and connects. This confirms that the page's CSP allows the IPC calls.
  - Hostile input is refused: `javascript:alert(1)`, `file:///etc/passwd`, `https://user:pass@host`, `https://host/path`.
  - Plain `http://` to a public host is refused; `http://localhost:8787` asks for confirmation.
- [ ] **Sign-in round trip:** the email link opens the browser, which hands back to the app through `backroom://`, and the app ends up signed in.
- [ ] **macOS ad-hoc signature and first launch:** `codesign -dv /Applications/Backroom.app` reports `Signature=adhoc`. On an Apple silicon Mac, a fresh download opens through the documented Gatekeeper override (not "damaged"). Note which dialog appears and update the section above.
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
