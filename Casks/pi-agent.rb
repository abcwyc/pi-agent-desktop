cask "pi-agent" do
  arch arm: "aarch64", intel: "x64"

  version "0.8.5"
  sha256 arm:   "025b0837e7900c8c6bdbf7260ccc4b2131e4cfd7a7fc6c155d55550c86dd7f04",
         intel: "898a834a89d2b675d105f4eb39ee99cbb2a2093b92bfc18ef0f3ecbd955480bc"

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
