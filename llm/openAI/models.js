/**
 * Supported OpenAI model aliases and the capabilities Testronaut relies on.
 * Dated snapshots and specialized Chat, Codex, Pro, and Cyber models are
 * intentionally excluded from the interactive catalog.
 */
export const OPENAI_MODELS = [
  { id: 'gpt-5.6', label: 'GPT-5.6 Sol', description: 'flagship capability', contextWindow: 1050000, chatToolReasoningEffort: 'none' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'balanced intelligence and cost', contextWindow: 1050000, chatToolReasoningEffort: 'none' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'cost-sensitive, high-volume workloads', contextWindow: 1050000, chatToolReasoningEffort: 'none' },
  { id: 'gpt-5.5', label: 'GPT-5.5', description: 'previous flagship model', contextWindow: 1050000 },

  { id: 'gpt-5.4', label: 'GPT-5.4', description: 'earlier professional model', contextWindow: 1050000, legacy: true },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'earlier balanced model', contextWindow: 400000, legacy: true },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', description: 'earlier high-volume model', contextWindow: 400000, legacy: true },
  { id: 'gpt-5.2', label: 'GPT-5.2', description: 'previous frontier model', contextWindow: 400000, legacy: true },
  { id: 'gpt-5.1', label: 'GPT-5.1', description: 'legacy reasoning model', legacy: true },
  { id: 'gpt-5', label: 'GPT-5', description: 'legacy reasoning model', legacy: true },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', description: 'legacy faster model', legacy: true },
  { id: 'gpt-5-nano', label: 'GPT-5 nano', description: 'legacy lightweight model', legacy: true },
  { id: 'gpt-4.1', label: 'GPT-4.1', description: 'legacy general-purpose model', legacy: true },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'legacy faster model', legacy: true },
  { id: 'gpt-4o', label: 'GPT-4o', description: 'legacy multimodal model', legacy: true },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'legacy cost-optimized model', legacy: true },
  { id: 'o3', label: 'o3', description: 'legacy reasoning model', legacy: true },
  { id: 'o4-mini', label: 'o4-mini', description: 'legacy cost-effective reasoning model', legacy: true },
];

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6';

export function getOpenAIModel(modelId) {
  return OPENAI_MODELS.find(({ id }) => id === modelId);
}
