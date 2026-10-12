import { describe, expect, it, vi } from 'vitest';
import {
  buildJevShadowState,
  buildJevStrategyQuestions,
  evaluateJevCompletionCandidate,
  evaluateJevShadow,
  resolveJevShadowConfig,
  sanitizeJevShadowEvents,
  extractJevStrategyResults,
} from '../../core/jevShadow.js';

describe('Jev shadow evaluation', () => {
  it('is disabled by default and resolves supported environment overrides', () => {
    expect(resolveJevShadowConfig({}).enabled).toBe(false);
    expect(resolveJevShadowConfig({
      TESTRONAUT_JEV_GATE: 'true',
      TYPESAFE_API_KEY: 'secret',
      TESTRONAUT_JEV_MODEL: 'jev-test',
      TESTRONAUT_JEV_TIMEOUT_MS: '1234',
      TESTRONAUT_JEV_GATE_THRESHOLD: '0.85',
    })).toMatchObject({
      enabled: true,
      gateEnabled: true,
      gateThreshold: 0.85,
      apiKey: 'secret',
      model: 'jev-test',
      timeoutMs: 1234,
    });
  });

  it('requires all completion signals and browser evidence to clear the gate', () => {
    const result = {
      status: 'ok',
      answers: {
        missionComplete: { noul: 0.82 },
        progressState: { probabilities: { complete: 0.91 } },
        nextCompute: { probabilities: { finish: 0.88 } },
      },
    };

    expect(evaluateJevCompletionCandidate(result, {
      threshold: 0.8,
      browserEvidence: { headings: ['Dashboard'] },
    }).candidate).toBe(true);
    expect(evaluateJevCompletionCandidate(result, {
      threshold: 0.9,
      browserEvidence: { headings: ['Dashboard'] },
    }).candidate).toBe(false);
    expect(evaluateJevCompletionCandidate(result, {
      threshold: 0.8,
      browserEvidence: null,
    }).candidate).toBe(false);
  });

  it('builds and maps the optional strategy questions', () => {
    const evidence = {
      regions: [{ id: 'region_1', kind: 'main', headings: ['Dashboard'] }],
      controls: [{ tag: 'button', id: 'save', label: 'Save' }],
    };
    const catalog = buildJevStrategyQuestions(evidence);

    expect(catalog.questions).toMatchObject({
      modelRoute: { type: 'choice' },
      postconditionSatisfied: { type: 'noul' },
      recoveryRoute: { type: 'choice' },
      missionStage: { type: 'choice' },
      prerequisiteSatisfied: { type: 'noul' },
      regionRelevant_region_1: { type: 'noul' },
      actionChoice: { type: 'choice' },
    });

    const result = extractJevStrategyResults({
      regionRelevant_region_1: { type: 'noul', noul: 0.9 },
      actionChoice: { type: 'choice', choice: 'action_1', confidence: 0.8 },
      modelRoute: { type: 'choice', choice: 'deterministic' },
    }, catalog);
    expect(result.domRelevance[0].probability).toBe(0.9);
    expect(result.actionChoice.selectedControl).toEqual(evidence.controls[0]);
    expect(result.modelRoute.choice).toBe('deterministic');
  });

  it('builds a bounded state for the decision request', () => {
    const state = buildJevShadowState({
      mission: 'visit the dashboard',
      turn: 1,
      maxTurns: 10,
      phase: 'after_action',
      assistantContent: 'x'.repeat(3000),
      proposedTools: [{ name: 'click_text', arguments: { text: 'Continue' } }],
      events: Array.from({ length: 20 }, (_, index) => `event ${index}`),
    });

    expect(state.turn).toEqual({ current: 2, maximum: 10 });
    expect(state.assistant.content).toContain('[truncated');
    expect(state.recentEvents).toHaveLength(12);
  });

  it('excludes raw tool payloads while retaining tool status telemetry', () => {
    expect(sanitizeJevShadowEvents([
      '[tool ] ← get_dom result: OK',
      '[tool ] ← <html>private page text</html>',
      'Navigation completed',
    ])).toEqual([
      '[tool ] ← get_dom result: OK',
      'Navigation completed',
    ]);
  });

  it('returns API answers and usage without exposing the credential', async () => {
    const fetchImpl = vi.fn(async (url, options) => ({
      ok: true,
      json: async () => ({
        model: 'jev-resolved',
        answers: { missionComplete: { type: 'noul', noul: 0.8 } },
        usage: { input_tokens: 100, output_tokens: 3 },
      }),
    }));
    const times = [100, 125];

    const result = await evaluateJevShadow({ mission: 'test' }, {
      config: {
        enabled: true,
        apiKey: 'top-secret',
        apiBase: 'https://jev.example',
        model: 'jev-latest',
        timeoutMs: 1000,
      },
      fetchImpl,
      now: () => times.shift(),
    });

    expect(result).toMatchObject({ status: 'ok', model: 'jev-resolved', latencyMs: 25 });
    const [, request] = fetchImpl.mock.calls[0];
    expect(request.headers.authorization).toBe('Bearer top-secret');
    expect(JSON.stringify(result)).not.toContain('top-secret');
  });

  it('turns API failures into shadow telemetry', async () => {
    const result = await evaluateJevShadow({}, {
      config: {
        enabled: true,
        apiKey: 'secret',
        apiBase: 'https://jev.example',
        model: 'jev-latest',
        timeoutMs: 1000,
      },
      fetchImpl: async () => ({ ok: false, status: 429 }),
    });

    expect(result).toMatchObject({ status: 'error', error: 'http_429' });
  });

  it('skips safely when enabled without a key', async () => {
    await expect(evaluateJevShadow({}, {
      config: { enabled: true, apiKey: '' },
    })).resolves.toEqual({ status: 'skipped', reason: 'missing_api_key' });
  });
});
