const PROVIDER_ICONS: Record<string, { symbol: string; color: boolean }> = {
  anthropic: { symbol: "anthropic", color: false },
  openai: { symbol: "openai", color: false },
  "openai-codex": { symbol: "openai", color: false },
  google: { symbol: "google", color: true },
  "google-vertex": { symbol: "google", color: true },
  "ant-ling": { symbol: "antgroup", color: true },
  deepseek: { symbol: "deepseek", color: true },
  groq: { symbol: "groq", color: false },
  mistral: { symbol: "mistral", color: true },
  moonshotai: { symbol: "moonshot", color: false },
  "moonshotai-cn": { symbol: "moonshot", color: false },
  moonshot: { symbol: "moonshot", color: false },
  minimax: { symbol: "minimax", color: true },
  "minimax-cn": { symbol: "minimax", color: true },
  fireworks: { symbol: "fireworks", color: true },
  huggingface: { symbol: "huggingface", color: true },
  cerebras: { symbol: "cerebras", color: true },
  openrouter: { symbol: "openrouter", color: false },
  xai: { symbol: "xai", color: false },
  "cloudflare-ai-gateway": { symbol: "cloudflare", color: true },
  "cloudflare-workers-ai": { symbol: "cloudflare", color: true },
  "vercel-ai-gateway": { symbol: "vercel", color: false },
  "github-copilot": { symbol: "githubcopilot", color: false },
  "amazon-bedrock": { symbol: "aws", color: true },
  "azure-openai-responses": { symbol: "azure", color: true },
  "kimi-coding": { symbol: "kimi", color: true },
  nvidia: { symbol: "nvidia", color: true },
  opencode: { symbol: "opencode", color: false },
  "opencode-go": { symbol: "opencode", color: false },
  qwen: { symbol: "qwen", color: true },
  xiaomi: { symbol: "xiaomimimo", color: false },
  "xiaomi-token-plan-ams": { symbol: "xiaomimimo", color: false },
  "xiaomi-token-plan-cn": { symbol: "xiaomimimo", color: false },
  "xiaomi-token-plan-sgp": { symbol: "xiaomimimo", color: false },
  zai: { symbol: "zai", color: false },
  "zai-coding-cn": { symbol: "zai", color: false },
  zhipu: { symbol: "zhipu", color: true },
  cohere: { symbol: "cohere", color: true },
  perplexity: { symbol: "perplexity", color: true },
  together: { symbol: "together", color: true },
  grok: { symbol: "grok", color: false },
};

/** Resolve the model's brand before its transport provider (relay/OpenRouter/etc.). */
export function getModelIconProvider(provider: string, modelId: string, name = ""): string {
  const families: readonly [RegExp, string][] = [
    [/(?:^|[^a-z0-9])claude(?:[^a-z0-9]|$)/i, "anthropic"],
    [/(?:^|[^a-z0-9])(?:chatgpt|gpt|codex)(?:[^a-z0-9]|$)|(?:^|[^a-z0-9])o[134](?:[^a-z0-9]|$)/i, "openai"],
    [/(?:^|[^a-z0-9])(?:gemini|gemma)(?:[^a-z0-9]|$)/i, "google"],
    [/(?:^|[^a-z0-9])deepseek(?:[^a-z0-9]|$)/i, "deepseek"],
    [/(?:^|[^a-z0-9])(?:qwen[0-9]*|qwq)(?:[^a-z0-9]|$)/i, "qwen"],
    [/(?:^|[^a-z0-9])(?:kimi|moonshot)(?:[^a-z0-9]|$)/i, "kimi-coding"],
    [/(?:^|[^a-z0-9])minimax(?:[^a-z0-9]|$)/i, "minimax"],
    [/(?:^|[^a-z0-9])grok(?:[^a-z0-9]|$)/i, "xai"],
    [/(?:^|[^a-z0-9])(?:mistral|mixtral|codestral|devstral|magistral)(?:[^a-z0-9]|$)/i, "mistral"],
    [/(?:^|[^a-z0-9])glm(?:[^a-z0-9]|$)/i, "zhipu"],
    [/(?:^|[^a-z0-9])mimo(?:[^a-z0-9]|$)/i, "xiaomi"],
    [/(?:^|[^a-z0-9])command(?:[^a-z0-9]|$)/i, "cohere"],
  ];
  for (const text of [modelId, name]) {
    const match = families.find(([pattern]) => pattern.test(text));
    if (match) return match[1];
  }
  return provider.toLowerCase();
}

export function ModelIcon({ provider, modelId, name, size = 16 }: {
  provider: string; modelId: string; name?: string; size?: number;
}) {
  return <ProviderIcon id={getModelIconProvider(provider, modelId, name)} size={size} />;
}

export function ProviderIcon({ id, size }: { id: string; size: number }) {
  const icon = PROVIDER_ICONS[id];
  if (icon) {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={icon.color ? undefined : "currentColor"}
        style={{ color: "var(--text-muted)", flexShrink: 0 }}
      >
        <use href={`/provider-icons.svg#${icon.symbol}`} />
      </svg>
    );
  }

  const label = id
    .split(/[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: "var(--hairline) solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.max(8, Math.floor(size * 0.42)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  );
}
