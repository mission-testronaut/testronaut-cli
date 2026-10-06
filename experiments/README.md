# Optimization benchmark pilot

This benchmark compares seven optimization conditions across the OpenAI-focused
Testronaut Examples repository and the Gemini-focused Collegium repository. It
uses five randomized blocks by default: 35 runs per repository and 70 total.

The fixed mission subsets are:

- OpenAI: login, self-cleaning task creation/removal, and file transfer.
- Gemini: profile navigation, projects dashboard, and project workspace navigation.

Preview the complete deterministic schedule without making model calls:

```bash
npm run benchmark:optimization -- --dry-run
```

Run or resume both repositories:

```bash
npm run benchmark:optimization
```

Run only one target:

```bash
npm run benchmark:optimization -- --target=openai
npm run benchmark:optimization -- --target=gemini
```

Useful controls:

```bash
npm run benchmark:optimization -- --repetitions=1 --experiment-id=optimization-smoke
npm run benchmark:optimization -- --seed=my-fixed-seed
```

Progress is saved after every condition under
`experiments/results/<experiment-id>/state.json`; reusing the same experiment ID
skips completed conditions. `runs.csv` contains one row per completed run, and
captured CLI output is stored under the corresponding `logs` directory. Each
generated Testronaut JSON report also records its experiment ID, condition, and
block.

The runner invokes this checkout's `bin/cli.js` directly and fixes the routing
probability at 0.40. It does not alter either target repository's configuration.
Model/API credentials must already be available in the environment or target
repository `.env` files.
