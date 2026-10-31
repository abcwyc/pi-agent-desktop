import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SessionSidebar } from "../components/SessionSidebar";
import { ComposerProjectChip } from "../components/ComposerProjectChip";
import { ProjectPicker } from "../components/ProjectPicker";
import { I18nProvider } from "../hooks/useI18n";

const root = "D:/work/app";
function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  return <I18nProvider>
    <div style={{ width: 280, height: 600 }}>
      <SessionSidebar selectedSessionId={null} onSelectSession={() => {}} selectedCwd={root} skipInitialProjectSelection />
    </div>
    <ComposerProjectChip menuRef={ref} open={open} onOpenChange={setOpen} label="app"
      projectPath={root} maxWidth={260} projectOptions={[root, "D:/other/app"]} onProjectChange={() => {}} />
    <ProjectPicker recentProjects={[root, "D:/other/app", ...Array.from({length: 7}, (_, i) => "D:/project" + i)]}
      selectedCwd={root} selectedProject={root} homeDir="D:/" onSelectCwd={() => {}} />
  </I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
