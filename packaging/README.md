# Package-manager manifests

This directory holds the manifests that let people install the Backroom desktop app with a package manager:

| Manager | File | Installs |
|---|---|---|
| AUR (`yay -S backroom-bin`) | `aur/backroom-bin/PKGBUILD`, `.SRCINFO` | the release's `.deb`, repackaged |
| AUR (`yay -S backroom`) | `aur/backroom/PKGBUILD`, `.SRCINFO` | built from the tagged source |
| Homebrew (`brew install --cask`) | `homebrew/backroom.rb` | the universal `.dmg` |
| Scoop (`scoop install backroom`) | `scoop/backroom.json` | the NSIS installer, run silently per user |
| winget (`winget install Ridit.Backroom`) | `winget/manifests/r/Ridit/Backroom/<version>/*.yaml` | the NSIS installer |

**Nothing here is published automatically.** The repository's CI only checks these files, and the release workflow builds an Arch package for the GitHub release. Publishing to the AUR, a Homebrew tap, a Scoop bucket or winget is a **manual step**. It needs the maintainer's own accounts and SSH keys.

The manifests only target **stable** releases. A pre-release (a version with `-`) has no RPM or MSI, pacman versions cannot contain `-`, and the bump script refuses pre-release versions.

## State before the first release

Every manifest is committed at version `0.0.0` with all-zero checksums. This placeholder cannot install anything. `node scripts/packaging-bump.mjs --check` accepts it as "not yet released". Do not publish a manifest in this state.

## After each release: bump the manifests

Do this once the GitHub release is published (the workflow now publishes it automatically): a draft's assets cannot be downloaded anonymously.

```sh
node scripts/packaging-bump.mjs 1.2.3
```

- **Downloads:** it fetches `https://github.com/ridit-jangra/Backroom/releases/download/v1.2.3/SHA256SUMS`. It also downloads the tag's source tarball (`https://github.com/ridit-jangra/Backroom/archive/refs/tags/v1.2.3.tar.gz`) and hashes it for the from-source AUR package, because that tarball is not in `SHA256SUMS`.
- **What it updates:** the version and checksums in both PKGBUILDs and their `.SRCINFO`, the cask, the Scoop manifest and the three winget manifests. It renames the winget version directory, resets `pkgrel` to 1 for a new version, and prints every changed line.
- **The LICENSE checksum** (backroom-bin downloads `LICENSE` from the tag) is the hash of `https://raw.githubusercontent.com/ridit-jangra/Backroom/v1.2.3/LICENSE`, downloaded online (64 KiB cap, 30 s timeout). `--check` fails, naming the mismatch, if the PKGBUILD carries another hash.
- **Offline:** `--sums path/to/SHA256SUMS --source-sha256 <hex> --license-sha256 <hex>` uses no network. A local `--sums` file requires `--source-sha256`. Without `--license-sha256` it falls back to this checkout's `LICENSE` and prints a warning: that is only right when the checkout's `LICENSE` equals the tag's.
- **Where it downloads from:** only https, only `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `raw.githubusercontent.com` and `codeload.github.com` (where GitHub serves tag tarballs), with at most 3 redirects, each checked the same way. `--sums <url>` must be an https URL under `https://github.com/ridit-jangra/Backroom/releases/download/`; a `SHA256SUMS` from any other source must be downloaded by hand and passed as a file.
- **Safety:** it writes nothing if anything is wrong: a pre-release or invalid version, a missing asset, a malformed `SHA256SUMS` line, a failed download, or an I/O error. The files are staged next to their targets and renamed only after every staged write succeeded; the winget directory is swapped last. Running it twice changes nothing.

Then verify, review and commit:

```sh
node scripts/packaging-bump.mjs --check          # downloads SHA256SUMS and the tarball again
node scripts/packaging-validate.mjs               # offline structure checks
(cd packaging/aur/backroom-bin && makepkg --printsrcinfo | diff - .SRCINFO)
(cd packaging/aur/backroom && makepkg --printsrcinfo | diff - .SRCINFO)
git diff packaging/
git commit -am "chore(packaging): 1.2.3"
```

If you edit a PKGBUILD by hand (a new dependency, a `pkgrel` bump for a packaging fix), regenerate its `.SRCINFO` with `makepkg --printsrcinfo > .SRCINFO`. `packaging-validate.mjs` (and CI) fail when the two disagree.

Before publishing, test-build on an Arch machine: `cd packaging/aur/backroom-bin && makepkg -si` (and `namcap PKGBUILD *.pkg.tar.zst`).

## Publishing (manual, maintainer accounts)

### AUR: `backroom-bin` and `backroom`

One-time setup:

1. Create an account at https://aur.archlinux.org/register.
2. Generate an SSH key just for the AUR (`ssh-keygen -t ed25519 -f ~/.ssh/aur`). Add the **public** key (`~/.ssh/aur.pub`) to your AUR account under "My Account" → "SSH Public Key".
3. Tell SSH to use it, in `~/.ssh/config`:

   ```
   Host aur.archlinux.org
     IdentityFile ~/.ssh/aur
     User aur
   ```

For each release, for `backroom-bin` and then `backroom`:

```sh
git clone ssh://aur@aur.archlinux.org/backroom-bin.git aur-backroom-bin   # first time: creates the package
cp packaging/aur/backroom-bin/PKGBUILD packaging/aur/backroom-bin/.SRCINFO aur-backroom-bin/
cd aur-backroom-bin
git add PKGBUILD .SRCINFO
git commit -m "Update to 1.2.3"
git push
```

Use the same steps with `backroom` and `packaging/aur/backroom/`. The AUR repository must contain only the files the package needs (here `PKGBUILD` and `.SRCINFO`), on the `master` branch. The first push of a new package name creates it on the AUR.

The GitHub release also carries `backroom-bin-<version>-1-x86_64.pkg.tar.zst`, built by the release workflow from the same PKGBUILD. People can install it with `sudo pacman -U` without the AUR.

### Homebrew: a tap named `homebrew-backroom`

1. Create a public GitHub repository named `homebrew-backroom` under your account.
2. Copy `packaging/homebrew/backroom.rb` to `Casks/backroom.rb` in that repository, then commit and push.
3. Users install with `brew install --cask <your-github-user>/backroom/backroom` (or `brew tap <your-github-user>/backroom` followed by `brew install --cask backroom`).
4. On each release, copy the bumped cask again.
5. Optionally, on a Mac, run `brew audit --cask --online <your-github-user>/backroom/backroom` and `brew style`. This repository's checks are structural only: Ruby and Homebrew were not available where the cask was written.

The app is ad-hoc signed and not notarized, so the cask prints a caveat about the Gatekeeper override. An unsigned, unnotarized app is not accepted in Homebrew's main `homebrew/cask` repository, which is why a personal tap is used.

### Scoop: a bucket repository

1. Create a public GitHub repository (for example `scoop-backroom`) with the manifest at `bucket/backroom.json`, copied from `packaging/scoop/backroom.json`.
2. Users install with `scoop bucket add backroom https://github.com/<your-github-user>/scoop-backroom`, then `scoop install backroom`.
3. On each release, copy the bumped manifest. Alternatively, Scoop's `checkver`/`autoupdate` tooling (`bin/checkver.ps1 -App backroom -Update` in the bucket) can update it from the GitHub release and its `SHA256SUMS`.

The manifest runs the NSIS installer silently into Scoop's app directory (`/S /NS /D=$dir`, so the installer creates no Start Menu entry; Scoop makes its own shortcut). The installer registers the `backroom://` link handler for the current user. The uninstaller runs in place (`/S _?=$dir`). **This has not been tried on a real Windows machine yet**: try `scoop install`, sign-in via a `backroom://` link, `scoop update` and `scoop uninstall` before announcing it.

### winget: a pull request to microsoft/winget-pkgs

- **With wingetcreate** (Windows): `wingetcreate submit --token <a GitHub token> packaging/winget/manifests/r/Ridit/Backroom/1.2.3`. Or use `wingetcreate update Ridit.Backroom --version 1.2.3 --urls <the exe URL> --submit` once the package exists.
- **By hand:**
  1. Fork https://github.com/microsoft/winget-pkgs.
  2. Copy the three files to `manifests/r/Ridit/Backroom/1.2.3/` in your fork.
  3. Run `winget validate --manifest manifests/r/Ridit/Backroom/1.2.3` on Windows (and ideally `winget install --manifest ...` in a sandbox).
  4. Open a pull request.

**Warning: no `ProductCode` yet.** Nullsoft (NSIS) installers usually need `ProductCode` and `AppsAndFeaturesEntries` in the installer manifest so winget can detect an installed version and upgrade it. The moderators' pipeline may ask for them, and `winget upgrade` may not work without them. After a first install on Windows, find the value in the registry, under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\` (the installs are per-user): open the subkey whose `DisplayName` is Backroom. Use that subkey's name as `ProductCode` and `DisplayName`, `DisplayVersion` and `Publisher` for `AppsAndFeaturesEntries`. Do not guess a value.

Microsoft's validation pipeline installs the package, and a moderator reviews it. The publisher (`Ridit`) and identifier (`Ridit.Backroom`) are taken by the first accepted submission. The manifests use schema 1.9.0. `scripts/packaging-validate.mjs` checks them against that schema's required fields and patterns offline, but it is not a substitute for `winget validate`.

## What CI checks

- **`packaging-check` job** (ci.yml, every push and pull request): `bash -n` on both PKGBUILDs, `ruby -c` on the cask when Ruby is present, `node scripts/packaging-validate.mjs`, the placeholder `--check`, and the script tests. No network.
- **`arch` job** (release.yml, tags and dry runs):
  - builds `backroom-bin` in an Arch container from the deb the same run just built;
  - runs `namcap`;
  - uploads the package, which then becomes a release asset.
- **`arch-source` job** (release.yml): builds the `backroom` PKGBUILD end to end from a `git archive` of the commit. A broken source package blocks the release. It runs on every `workflow_dispatch` dry run as well as on tags, and it takes a long time: its `timeout-minutes` is 75 (the `arch` job's is 30). **The first dry run is the first real test of both container jobs**; expect to fix something there.
