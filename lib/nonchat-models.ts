/** Kinds of model pi lists besides chat models (pi >= 0.99). Neither appears in the model selector. */
export const NON_CHAT_MODEL_TYPES = ["classifier", "image"] as const;
export type NonChatModelType = typeof NON_CHAT_MODEL_TYPES[number];

export interface NonChatModelInfo {
  provider: string;
  id: string;
  name: string;
  /** The provider has a credential, so codemode scripts can call it now. */
  available: boolean;
  /** USD per million tokens, as the catalog lists it; absent when the catalog has no price. */
  cost?: { input: number; output: number };
  /** Image models: whether the model can also answer with text. */
  textOutput?: boolean;
}

export type NonChatModels = Record<NonChatModelType, NonChatModelInfo[]>;

interface CatalogModel {
  provider: string;
  id: string;
  name?: string;
  cost?: { input?: number; output?: number };
  output?: readonly string[];
}

/** The part of pi's ModelRuntime this listing needs. */
export interface NonChatModelRuntime {
  getModelsOfType(type: NonChatModelType): readonly CatalogModel[];
  getAvailableOfType(type: NonChatModelType): Promise<readonly CatalogModel[]>;
}

const keyOf = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

/**
 * Every classifier and image model in the catalog, marked with whether its provider is signed
 * in. pi reaches them only from codemode scripts (`models.classify()`,
 * `models.generateImages()`), so listing them is how a user learns they exist at all.
 * Available models first, then by provider and name.
 */
export async function listNonChatModels(runtime: NonChatModelRuntime): Promise<NonChatModels> {
  const result = {} as NonChatModels;
  for (const type of NON_CHAT_MODEL_TYPES) {
    const available = new Set((await runtime.getAvailableOfType(type)).map(keyOf));
    result[type] = runtime.getModelsOfType(type)
      .map((model): NonChatModelInfo => {
        const input = model.cost?.input ?? 0;
        const output = model.cost?.output ?? 0;
        return {
          provider: model.provider,
          id: model.id,
          name: model.name || model.id,
          available: available.has(keyOf(model)),
          ...(input > 0 || output > 0 ? { cost: { input, output } } : {}),
          ...(type === "image" ? { textOutput: model.output?.includes("text") ?? false } : {}),
        };
      })
      .sort((a, b) => Number(b.available) - Number(a.available)
        || a.provider.localeCompare(b.provider)
        || a.name.localeCompare(b.name));
  }
  return result;
}
