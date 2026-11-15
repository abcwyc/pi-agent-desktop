cask "pi-agent" do
  arch arm: "aarch64", intel: "x64"

  version "0.8.6"
  sha256 arm:   "4901add68d5f128b27c4a3bf654f94d6e8125e4df8ca91b55cf79a23ef057109",
         intel: "914f046f5c308baba0f5f3180ed34b8ac18b8d4770730e396d5eefdafe8c610c"

  url "https://github.com/abcwyc/pi-agent-desktop/releases/download/v#{version}/Pi.Agent_#{version}_#{arch}.dmg"
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
