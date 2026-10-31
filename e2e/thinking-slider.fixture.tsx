import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThinkingLevelSlider } from "../components/ThinkingLevelSlider";

function Fixture() {
  const [value, setValue] = useState("medium");
  const [commits, setCommits] = useState(0);
  const [restricted, setRestricted] = useState(false);
  const levels = restricted ? ["auto", "low", "high"] : ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
  return <main style={{ maxWidth: 300, margin: "30px auto", padding: 8 }}>
    <div className="app-menu native-popover" style={{ position: "relative" }}>
      <ThinkingLevelSlider key={levels.join()} label="思考强度" faster="更快响应" deeper="更深入思考"
        steps={levels.map(value => ({ value, label: value, description: "当前思考等级：" + value }))}
        value={value} onChange={next => { setValue(next); setCommits(count => count + 1); }} />
    </div>
    <output data-commits={commits}>{value}</output>
    <button onClick={() => { setRestricted(true); setValue("low"); }}>Restricted</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
