import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelSelector } from "../components/ModelSelector";
import { I18nProvider } from "../hooks/useI18n";

const options = [
  ["claude-sonnet-4-6", "Claude Sonnet"], ["gpt-5.4", "GPT 5.4"],
  ["gemini-3-pro", "Gemini 3 Pro"], ["deepseek-v4-flash", "DeepSeek V4"],
  ["qwen3.5-plus", "Qwen 3.5"], ["kimi-k2.5", "Kimi K2.5"],
  ["glm-5", "GLM 5"], ["minimax-m2.5", "MiniMax M2.5"],
  ["grok-4", "Grok 4"], ["custom-model", "Custom model"],
].map(([modelId, name]) => ({ provider: "my-relay", modelId, name }));

function Fixture() {
  const [value, setValue] = useState({ provider: "my-relay", modelId: "claude-sonnet-4-6" });
  const [defaultValue, setDefaultValue] = useState(value);
  return <I18nProvider><main style={{ padding: 12, marginTop: 20 }}>
    <ModelSelector options={options} value={value} defaultValue={defaultValue} placement="auto"
      ariaLabel="Model" onChange={(provider, modelId) => setValue({ provider, modelId })}
      onSetDefault={(provider, modelId) => setDefaultValue({ provider, modelId })} />
  </main></I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
