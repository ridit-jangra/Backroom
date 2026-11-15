# Homebrew cask for the Backroom desktop app. Published from the maintainer's tap repository
# `homebrew-backroom` as Casks/backroom.rb (see packaging/README.md):
#   brew install --cask <owner>/backroom/backroom
# version and sha256 are set by scripts/packaging-bump.mjs from the release's SHA256SUMS.
# Version 0.0.0 with an all-zero sha256 is the placeholder used before the first release.
cask "backroom" do
  version "0.0.1"
  sha256 "6c4f74753c1b597936aa045b418147a51037b56c5db7dc76ad086c3e5f8e5470"

  url "https://github.com/ridit-jangra/Backroom/releases/download/v#{version}/Backroom_#{version}_universal.dmg"
  name "Backroom"
  desc "Desktop client for a self-hosted team chat"
  homepage "https://github.com/ridit-jangra/Backroom"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Backroom.app"

  zap trash: [
    "~/Library/Application Support/app.backroom.desktop",
    "~/Library/Caches/app.backroom.desktop",
    "~/Library/HTTPStorages/app.backroom.desktop",
    "~/Library/Preferences/app.backroom.desktop.plist",
    "~/Library/Saved Application State/app.backroom.desktop.savedState",
    "~/Library/WebKit/app.backroom.desktop",
  ]

  caveats <<~EOS
    Backroom is not signed with an Apple Developer ID certificate or notarized (it is only
    ad-hoc signed), so Gatekeeper blocks the first launch. To open it once:
      right-click (or Control-click) Backroom in Applications, choose Open, then Open again;
      on macOS 15 and later use System Settings > Privacy & Security > Open Anyway.
    Or remove the quarantine attribute in a terminal:
      xattr -dr com.apple.quarantine /Applications/Backroom.app
  EOS
end
