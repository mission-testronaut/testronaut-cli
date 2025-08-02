import { encoding_for_model } from '@dqbd/tiktoken';
import { wait } from './turnLoopUtils.js';

const TOKEN_BACKOFF_MS = 60000;
const TOKEN_LIMIT_PER_MIN = 90000;

export const tokenEstimate = async (model, text) => {
  const encoding = encoding_for_model(model);
  const tokenCount = encoding.encode(text).length;
  console.log(`🧠 Estimated token count: ${tokenCount}`);
  return tokenCount;
}

export const tokeUseCoolOff = async (totalTokensUsed, turnTimestamps) => {
  if (totalTokensUsed > TOKEN_LIMIT_PER_MIN) {
  console.warn(`⚠️ Token throttle risk → Waiting ${TOKEN_BACKOFF_MS / 1000}s to cool off...`);
      await wait(TOKEN_BACKOFF_MS);
      totalTokensUsed = 0; // Reset token count after backoff
      turnTimestamps = []; // Reset timestamps after backoff
      console.log('✅ Backoff complete, resuming...');
      return true;
  }
  return false;
}