import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../hooks/useI18n";
import { HomeExperienceSettings } from "../components/HomeExperienceSettings";
import { HomeUsageDashboard } from "../components/HomeUsageDashboard";
import { HomeRipple } from "../components/HomeRipple";
import { ComposerCompanion, type CompanionState } from "../components/ComposerCompanion";

function Fixture() {
  const [state, setState] = useState<CompanionState>("idle");
  return <I18nProvider><main>
    <HomeExperienceSettings />
    <div className="home-fixture-stage chat-window" data-home-dashboard="true"><HomeRipple /><HomeUsageDashboard /></div>
    <div className="home-fixture-composer"><ComposerCompanion state={state} /><textarea aria-label="Composer" /></div>
    <div>{(["idle", "thinking", "working", "attention", "error"] as const).map((value) =>
      <button key={value} onClick={() => setState(value)}>{value}</button>)}</div>
  </main></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
