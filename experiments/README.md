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

Progress is saved after every condition under target-specific
`experiments/results/<experiment-id>/state-openai.json` and
`state-gemini.json` files, so both loops may run concurrently without clobbering
state. Reusing the same experiment ID skips completed conditions. The matching
`runs-openai.csv` and `runs-gemini.csv` files contain one row per completed run,
and captured CLI output is stored under the corresponding `logs` directory.
Each generated Testronaut JSON report also records its experiment ID, condition,
and block. If state is lost, the runner recovers completed conditions from those
report fields before resuming.

The runner invokes this checkout's `bin/cli.js` directly and fixes the routing
probability at 0.40. It does not alter either target repository's configuration.
Model/API credentials must already be available in the environment or target
repository `.env` files.

After all 70 reports are present, generate the findings report and portable data
package with:

```bash
npm run benchmark:package
```

This writes a Markdown report, normalized CSV datasets, the raw JSON reports,
manifest, and checksums under `experiments/results/optimization-pilot-v1/`, plus
a compressed `optimization-pilot-v1-data-package.tar.gz` archive.
