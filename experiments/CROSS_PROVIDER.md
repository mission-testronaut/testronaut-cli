# Cross-provider benchmark

This benchmark runs three example-repository missions across four fixed-model controls and four two-model OpenAI/Gemini portfolios. Jev selects one model at the mission boundary for portfolio conditions; that model owns the complete mission transcript.

The default design is 8 conditions × 5 randomized blocks × 3 missions, or 120 isolated mission executions. Failed missions are not retried with the other provider.

Preview the complete deterministic schedule without making API calls:

```sh
npm run benchmark:cross-provider -- --dry-run
```

Run or resume it:

```sh
npm run benchmark:cross-provider
```

Keys are loaded from `/home/shane/workspace/testronaut-examples/.env`. Progress, selections, logs, report paths, and a summary CSV are written under `experiments/results/cross-provider-pilot-v1/`. Re-running the command resumes completed work. Useful overrides include `--repetitions=5`, `--seed=...`, `--repo=...`, `--experiment-id=...`, and `--selection-threshold=0.55`.
