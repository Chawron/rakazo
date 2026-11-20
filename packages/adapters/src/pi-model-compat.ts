import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { canonicalPiProviderId } from "@rakazo/contracts";

/** Apply provider protocol capabilities before catalog and runtime selection. */
export function applyPiModelCompatibility(models: MutableModels): MutableModels {
  const provider = models.getProvider?.("amazon-bedrock");
  if (provider) {
    const guardedId = "in.anthropic.claude-haiku-4-5-20251001-v1:0";
    const guardedModels = provider
      .getModels()
      .map((model) =>
        model.id === guardedId
          ? { ...model, compat: { ...model.compat, supportsStrictMode: false } }
          : model,
      );
    models.setProvider({ ...provider, getModels: () => guardedModels });
  }
  // Only OpenAI's own endpoints, and OpenRouter (which translates per model), accept the
  // developer role. Other chat templates know system/user/assistant/tool and reject the
  // whole request ("Unexpected message role") when a reasoning model sends developer.
  for (const compatible of models.getProviders?.() ?? []) {
    if (DEVELOPER_ROLE_PROVIDERS.has(compatible.id)) continue;
    const original = compatible.getModels();
    if (!original.some(defaultsToDeveloperRole)) continue;
    const systemModels = original.map((model) =>
      defaultsToDeveloperRole(model)
        ? { ...model, compat: { ...model.compat, supportsDeveloperRole: false } }
        : model,
    );
    models.setProvider({ ...compatible, getModels: () => systemModels });
  }
  // The Qwen Token Plan and OpenCode Go serve qwen4-max and qwen4-max-preview,
  // but Pi's bundled catalog predates them: they resolve as unknown models and
  // image input is blocked at send time. Register them explicitly as
  // image-capable clones of the same provider's qwen3.8-max catalog entry
  // (same endpoint and protocol). Owner directive 2026-11-20: every model in
  // use carries an explicit image tag instead of the unknown-model fallback.
  const imageInput: Model<Api>["input"] = ["text", "image"];
  for (const providerId of ["qwen-token-plan", "opencode-go"]) {
    const served = models.getProvider?.(providerId);
    if (!served) continue;
    const existing = served.getModels();
    const sibling = existing.find((model) => model.id === "qwen3.8-max");
    if (!sibling) continue;
    const additions = ["qwen4-max", "qwen4-max-preview"]
      .filter((id) => !existing.some((model) => model.id === id))
      .map((id) => ({ ...sibling, id, name: id, input: imageInput }));
    if (additions.length > 0) {
      const all = [...existing, ...additions];
      models.setProvider({ ...served, getModels: () => all });
    }
  }
  const getModel = models.getModel.bind(models);
  models.getModel = (provider, id) => getModel(canonicalPiProviderId(provider), id);
  const getProvider = models.getProvider?.bind(models);
  if (getProvider) models.getProvider = (provider) => getProvider(canonicalPiProviderId(provider));
  return models;
}

const DEVELOPER_ROLE_PROVIDERS = new Set(["openai", "azure", "openrouter"]);

/** A reasoning chat-completions model that pi would send the developer role by default. */
function defaultsToDeveloperRole(model: Model<Api>): boolean {
  if (model.api !== "openai-completions" || !model.reasoning) return false;
  const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
  return compat?.supportsDeveloperRole === undefined;
}
