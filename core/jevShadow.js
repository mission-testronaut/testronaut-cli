const DEFAULT_API_BASE = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_GATE_THRESHOLD = 0.8;

const SHADOW_QUESTIONS = {
  missionComplete: {
    type: 'noul',
    instructions: 'Is there enough evidence that the stated browser-testing mission is complete?',
    criteria: {
      true: 'The goal is demonstrably satisfied by the current state or observed results.',
      false: 'The goal is incomplete, failed, uncertain, or still requires verification.',
    },
  },
  progressState: {
    type: 'choice',
    instructions: 'Classify the current progress of this browser-testing mission.',
    criteria: {
      complete: 'The mission is demonstrably complete.',
      advancing: 'Recent actions made useful progress, but more work is required.',
      stalled: 'The agent is repeating, blocked, or not making useful progress.',
      failed: 'The available evidence shows the mission cannot or did not complete.',
      uncertain: 'There is not enough evidence to classify progress reliably.',
    },
  },
  nextCompute: {
    type: 'choice',
    instructions: 'What kind of computation should Testronaut use next?',
    criteria: {
      finish: 'No more browser-agent reasoning is needed.',
      deterministic_action: 'A known browser action can run without generative reasoning.',
      observe: 'More browser state should be collected before deciding.',
      full_reasoning: 'A generative reasoning model is needed to decide or construct the next action.',
      stop_failed: 'The mission should stop as failed rather than spend more tokens.',
    },
  },
};

const STRATEGY_QUESTIONS = {
  modelRoute: {
    type: 'choice',
    instructions: 'Choose the least expensive reliable computation for the next turn.',
    criteria: {
      deterministic: 'The exact action and every required argument are already constructed in state; code can execute it directly.',
      fast_model: 'The relevant control or local intent is apparent, but a short tool choice, known-value mapping, or localized inference is still needed.',
      full_model: 'Multi-step planning, broad ambiguity, novel content, or difficult recovery requires frontier reasoning.',
      observe: 'Collect more browser evidence before choosing.',
      finish: 'The mission is complete and should finish.',
    },
  },
  postconditionSatisfied: {
    type: 'noul',
    instructions: 'Did the most recent browser action satisfy its intended postcondition?',
    criteria: {
      true: 'Structured browser evidence shows the intended state change or result.',
      false: 'The result is absent, contradicted, failed, or cannot yet be verified.',
    },
  },
  recoveryRoute: {
    type: 'choice',
    instructions: 'Choose the best recovery policy for the current mission state.',
    criteria: {
      continue: 'Progress is healthy; continue normally.',
      retry_action: 'Retry the most recent action once.',
      reobserve: 'Refresh browser evidence before deciding.',
      escalate: 'Use the full reasoning model to recover.',
      stop_failed: 'Further work is unlikely to succeed; stop as failed.',
    },
  },
  missionStage: {
    type: 'choice',
    instructions: 'Classify the current stage of this browser mission.',
    criteria: {
      setup: 'Preparing browser or initial state.',
      navigate: 'Navigating to the target area.',
      authenticate: 'Establishing or verifying authentication.',
      interact: 'Performing the mission-specific user actions.',
      verify: 'Checking that the requested outcome occurred.',
      complete: 'The mission outcome is complete.',
      failed: 'The mission cannot complete.',
    },
  },
  prerequisiteSatisfied: {
    type: 'noul',
    instructions: 'Does the current browser state already satisfy the mission prerequisite or required starting state?',
    criteria: {
      true: 'The required session, route, and starting conditions are already present.',
      false: 'Setup, navigation, authentication, or other prerequisite work remains.',
    },
  },
};

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function probability(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function trimTrailingSlash(value) {
  return String(value || DEFAULT_API_BASE).replace(/\/+$/, '');
}

function compactText(value, maxLength = 2000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…[truncated ${text.length - maxLength} chars]`;
}

export function resolveJevShadowConfig(env = process.env) {
  const gateEnabled = truthy(env.TESTRONAUT_JEV_GATE);
  const routingEnabled = /^(shadow|live)$/i.test(String(env.TESTRONAUT_JEV_ROUTING || '').trim());
  const strategiesEnabled = truthy(env.TESTRONAUT_JEV_STRATEGIES) || routingEnabled;
  return {
    enabled: truthy(env.TESTRONAUT_JEV_SHADOW) || gateEnabled || strategiesEnabled,
    gateEnabled,
    gateThreshold: probability(env.TESTRONAUT_JEV_GATE_THRESHOLD, DEFAULT_GATE_THRESHOLD),
    strategiesEnabled,
    apiKey: env.TESTRONAUT_JEV_API_KEY || env.TYPESAFE_API_KEY || env.JEV_API_KEY || '',
    apiBase: trimTrailingSlash(env.TESTRONAUT_JEV_API_BASE || env.TYPESAFE_BASE_URL),
    model: env.TESTRONAUT_JEV_MODEL || env.TYPESAFE_DEFAULT_MODEL || DEFAULT_MODEL,
    timeoutMs: positiveInteger(env.TESTRONAUT_JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function actionDescription(control = {}) {
  const selector = control.id ? `#${control.id}` : control.name ? `[name="${control.name}"]` : '';
  const label = control.label ? ` “${control.label}”` : '';
  const state = [
    control.hasValue ? 'currently populated' : 'currently empty',
    control.checked ? 'checked' : '',
    control.disabled ? 'disabled' : 'enabled',
    control.visible === false ? 'not visible' : 'visible',
  ].filter(Boolean).join(', ');
  if (['input', 'select', 'textarea'].includes(control.tag)) {
    return `Fill or select ${control.tag}${label}${selector ? ` at ${selector}` : ''} using an already-known mission value. Control state: ${state}. Do not refill an already populated control unless replacement is required.`;
  }
  return `Click ${control.role || control.tag || 'control'}${label}${selector ? ` at ${selector}` : ''}. Control state: ${state}.`;
}

export function buildJevStrategyQuestions(browserEvidence = {}) {
  const questions = { ...SHADOW_QUESTIONS, ...STRATEGY_QUESTIONS };
  const regions = (browserEvidence.regions || []).slice(0, 12);
  for (const region of regions) {
    questions[`regionRelevant_${region.id}`] = {
      type: 'noul',
      instructions: `Is browser region ${region.id} relevant to deciding or executing the next mission action?`,
      criteria: {
        true: 'The region contains evidence or controls needed for the next action.',
        false: 'The region can be omitted from the next generative-model context.',
      },
    };
  }

  const controls = (browserEvidence.controls || []).slice(0, 20);
  const actionCriteria = {
    observe: 'Collect more browser evidence before acting.',
    full_reasoning: 'No listed action is safely executable without generative reasoning.',
  };
  controls.forEach((control, index) => {
    actionCriteria[`action_${index + 1}`] = actionDescription(control);
  });
  if (controls.length) {
    questions.actionChoice = {
      type: 'choice',
      instructions: 'Choose the safest next action for progressing the mission.',
      criteria: actionCriteria,
    };
  }
  return { questions, regions, controls };
}

export function extractJevStrategyResults(answers = {}, catalog = {}) {
  const regionRelevance = (catalog.regions || []).map(region => ({
    ...region,
    probability: Number(answers[`regionRelevant_${region.id}`]?.noul),
  }));
  const actionAnswer = answers.actionChoice;
  const actionIndex = String(actionAnswer?.choice || '').match(/^action_(\d+)$/)?.[1];
  return {
    domRelevance: regionRelevance,
    actionChoice: actionAnswer ? {
      ...actionAnswer,
      selectedControl: actionIndex ? catalog.controls?.[Number(actionIndex) - 1] ?? null : null,
    } : null,
    modelRoute: answers.modelRoute ?? null,
    verification: answers.postconditionSatisfied ?? null,
    recovery: answers.recoveryRoute ?? null,
    missionStage: answers.missionStage ?? null,
    prerequisite: answers.prerequisiteSatisfied ?? null,
  };
}

export function evaluateJevCompletionCandidate(result, {
  threshold = DEFAULT_GATE_THRESHOLD,
  browserEvidence,
} = {}) {
  const answers = result?.status === 'ok' ? result.answers : null;
  const signals = {
    missionComplete: Number(answers?.missionComplete?.noul),
    progressComplete: Number(answers?.progressState?.probabilities?.complete),
    finish: Number(answers?.nextCompute?.probabilities?.finish),
  };
  const hasBrowserEvidence = Boolean(
    browserEvidence?.title
      || browserEvidence?.headings?.length
      || browserEvidence?.controls?.length,
  );
  const values = Object.values(signals);
  return {
    candidate: Boolean(
      hasBrowserEvidence
        && values.every(value => Number.isFinite(value) && value >= threshold),
    ),
    threshold,
    hasBrowserEvidence,
    signals,
  };
}

export function buildJevShadowState({
  mission,
  turn,
  maxTurns,
  phase,
  assistantSummary,
  assistantContent,
  proposedTools = [],
  events = [],
  groundControl,
  browserEvidence,
} = {}) {
  return {
    mission: compactText(mission, 3000),
    turn: { current: Number(turn) + 1, maximum: maxTurns },
    phase,
    assistant: {
      summary: compactText(assistantSummary, 1000),
      content: compactText(assistantContent, 2000),
      proposedTools: proposedTools.slice(0, 12).map(tool => ({
        name: compactText(tool?.name, 120),
        arguments: tool?.arguments,
      })),
    },
    recentEvents: events.slice(-12).map(event => compactText(event, 500)),
    groundControl: groundControl ?? null,
    browserEvidence: browserEvidence ?? null,
  };
}

export function sanitizeJevShadowEvents(events = [], redactText = value => String(value ?? '')) {
  return events
    .filter(event => !String(event).startsWith('[tool ] ←') || String(event).includes(' result:'))
    .map(event => redactText(event));
}

export async function evaluateJevShadow(state, {
  config = resolveJevShadowConfig(),
  questions = SHADOW_QUESTIONS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  if (!config.enabled) return null;
  if (!config.apiKey) {
    return { status: 'skipped', reason: 'missing_api_key' };
  }
  if (typeof fetchImpl !== 'function') {
    return { status: 'error', error: 'fetch_unavailable' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = now();

  try {
    const response = await fetchImpl(`${config.apiBase}/v1/systemone`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        state,
        model: config.model,
        questions,
      }),
      signal: controller.signal,
    });

    const latencyMs = Math.max(0, now() - startedAt);
    if (!response.ok) {
      return {
        status: 'error',
        error: `http_${response.status}`,
        latencyMs,
      };
    }

    const payload = await response.json();
    return {
      status: 'ok',
      model: payload.model,
      answers: payload.answers,
      usage: payload.usage,
      latencyMs,
    };
  } catch (error) {
    return {
      status: 'error',
      error: error?.name === 'AbortError' ? 'timeout' : compactText(error?.message || error, 300),
      latencyMs: Math.max(0, now() - startedAt),
    };
  } finally {
    clearTimeout(timer);
  }
}

export const __jevShadowInternals = { SHADOW_QUESTIONS, compactText, truthy };
