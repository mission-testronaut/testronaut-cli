import { encoding_for_model } from '@dqbd/tiktoken';

export const tokenEstimate = async (model, text) => {
  const encoding = encoding_for_model(model);
  const tokenCount = encoding.encode(text).length;
  console.log(`🧠 Estimated token count: ${tokenCount}`);
  return tokenCount;
}