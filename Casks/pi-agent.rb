cask "pi-agent" do
  arch arm: "aarch64", intel: "x64"

  version "0.8.7"
  sha256 arm:   "50ade76f02f604d695afc24e95497da0e1381728b9102c385a3132cb1d909cf6",
         intel: "303d0e164fdefbbe7737da17d716cd7d50c224c3fe21b35b03b29cfa061f6e21"

  url "https://github.com/abcwyc/pi-agent-desktop/releases/download/v#{version}/Pi.Agent_#{version}_macOS_#{arch}.dmg"
  name "Pi Agent"
  desc "Local AI agent desktop app built on pi"
  homepage "https://github.com/abcwyc/pi-agent-desktop"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app upgrades itself from Settings with signed updater builds.
  auto_updates true
  # The app builds against macOS 11 (Tauri `minimumSystemVersion`), which is also
  # Homebrew's own floor, so a bare `depends_on :macos` is the whole requirement.
  depends_on :macos

  app "Pi Agent.app"

  # Sessions, models and credentials live in ~/.pi and are shared with the pi
  # CLI, so they are deliberately not part of zap.
  zap trash: [
    "~/Library/Application Support/com.abcwyc.pi-agent",
    "~/Library/Caches/com.abcwyc.pi-agent",
    "~/Library/Preferences/com.abcwyc.pi-agent.plist",
    "~/Library/Saved Application State/com.abcwyc.pi-agent.savedState",
    "~/Library/WebKit/com.abcwyc.pi-agent",
  ]
end
