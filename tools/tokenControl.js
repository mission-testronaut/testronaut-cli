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

export const tokenUseCoolOff = async (totalTokensUsed, turnTimestamps) => {
  console.log("total tokens used: ", totalTokensUsed);
  console.log("turnTimestamps: ", turnTimestamps);
  
  if (totalTokensUsed > TOKEN_LIMIT_PER_MIN) {
    const msToWait = await getDynamicBackoffMs(turnTimestamps);
    console.warn(`⚠️ Token throttle risk → Waiting ${msToWait / 1000}s to cool off...`);
    await wait(msToWait);
    // totalTokensUsed = 0; // Reset token count after backoff
    // turnTimestamps = []; // Reset timestamps after backoff
    console.log('✅ Backoff complete, resuming...');
    // return true;
    return { shouldBackoff: true, totalTokensUsed: 0, turnTimestamps: [] };
  }
  // return false;
  return { shouldBackoff: false, totalTokensUsed, turnTimestamps };
}

export const recordTokenUsage = (turnTimestamps, tokensUsed) => {
  const now = Date.now();
  turnTimestamps.push([now, tokensUsed]);
};

export const pruneOldTokenUsage = (turnTimestamps, windowMs = 60000) => {
  const cutoff = Date.now() - windowMs;
  const recentEntries = turnTimestamps.filter(([timestamp]) => timestamp > cutoff);
  const totalTokensUsed = recentEntries.reduce((acc, [, tokens]) => acc + tokens, 0);
  return { turnTimestamps: recentEntries, totalTokensUsed };
};

const getDynamicBackoffMs = async (turnTimestamps, tokenLimit = TOKEN_LIMIT_PER_MIN) => {
  const now = Date.now();
  let runningTotal = 0;

  // Sort oldest → newest to find the earliest point to fall below the limit
  const sorted = [...turnTimestamps].sort((a, b) => a[0] - b[0]);

  for (let i = 0; i < sorted.length; i++) {
    runningTotal += sorted[i][1]; // add tokensUsed

    if (runningTotal > tokenLimit) {
      const [timestampOfExcess] = sorted[i];
      const msUntilSafe = 60000 - (now - timestampOfExcess);
      return Math.max(msUntilSafe, 1000); // wait at least 1s
    }
  }

  return 0; // Safe to proceed
}