# Dynamic rate-limit manual test runbook

This runbook validates initialization, precedence, successful-response learning,
project/model scoping, projected-request throttling, and `429` recovery. Run it
against a disposable Testronaut project and a provider project where test spend
and quota consumption are acceptable.

## Prerequisites and evidence

- Use Node 20 or newer and run `npm test` before live tests.
- Record the CLI version, Node version, provider, selected model, API project,
  configured region, configured tier hint, and test timestamp.
- Never include API keys in screenshots or captured logs.
- For every case, retain the relevant config fragment, console output, elapsed
  time, result, and any provider dashboard observation.

The generated rate-limit shape should resemble:

```json
{
  "rateLimits": {
    "tier": "unknown",
    "region": "global",
    "safetyMargin": 0.9,
    "models": {
      "gpt-4o": { "fallbackTPM": 450000 }
    }
  }
}
```

`fallbackTPM` is only a startup estimate. A model-level `tpm` is an intentional
hard override. `TESTRONAUT_TOKENS_PER_MIN` overrides both.

When the environment override is numeric, Testronaut prints a warning on every
process start so the reduced limit is not mistaken for provider throttling. To
clear it permanently, remove it from `.env` or the shell profile and run:

```bash
unset TESTRONAUT_TOKENS_PER_MIN
```

To ignore a numeric value inherited from `.env` for one invocation without
editing that file, place `auto` in the parent shell environment:

```bash
TESTRONAUT_TOKENS_PER_MIN=auto testronaut your-mission.mission.js
```

## A. Initialization and configuration

### A1. Fresh initialization for every provider

In three empty temporary directories, run `testronaut init` and select one model
from OpenAI, Gemini, and Anthropic respectively.

Expected:

- Only the selected model appears under `rateLimits.models`.
- `tier` is `unknown`, `region` is `global`, and `safetyMargin` is `0.9`.
- The fallback is positive and appropriate to the selected model family.
- No API key appears in `testronaut-config.json`.

### A2. Re-running init

Modify `safetyMargin`, add a model-level `tpm`, and rerun `testronaut init`.

Expected: initialized projects remain unchanged; custom rate-limit settings and
the existing `.env` are preserved.

### A3. Model switching

Change the configured model without adding it under `rateLimits.models`, then run
a short mission.

Expected: the built-in conservative fallback is used; the old model's generated
fallback is not incorrectly applied to the new model.

## B. Precedence tests without consuming meaningful quota

Use a mission requiring several model turns.

### B1. Generated fallback

Run with no environment override and no model-level `tpm`.

Expected: the mission starts normally and can learn a provider-advertised limit
after a successful response. OpenAI should log `Updated TPM ... (from headers)`
when its advertised value differs from the startup fallback.

### B2. Explicit config override

Set the selected model to a deliberately low but usable value:

```json
"gpt-4o": { "fallbackTPM": 450000, "tpm": 2000 }
```

Expected: `2000` remains authoritative even if successful responses advertise a
different limit. The CLI may log learned provider metadata, but pacing continues
to use the explicit configuration.

### B3. Environment override

Run the same mission with:

```bash
TESTRONAUT_TOKENS_PER_MIN=1500 testronaut your-mission.mission.js
```

Expected: `1500` takes priority over config and learned values. Remove the
variable afterward so it does not affect later tests. The startup log must state
that the override is active and show both permanent-clear and one-run commands.

Repeat with `TESTRONAUT_TOKENS_PER_MIN=auto`. Expected: the numeric value from
`.env` is bypassed for that invocation and automatic config/header resolution is
used.

### B4. Invalid values

Try zero, a negative number, and nonnumeric values in the environment and config.

Expected: invalid values are ignored safely and execution uses the next valid
source. There should be no crash or zero-capacity retry loop.

## C. Successful-response learning

### C1. OpenAI raw headers

Run a mission with at least three LLM turns using a real OpenAI project.

Expected:

- A successful call exposes rate-limit headers through the SDK raw response.
- The learned TPM applies to later turns in that process.
- Token accounting continues normally.
- A changed advertised limit updates the live value rather than retaining stale
  startup data.

Compare the observed limit with the provider project's rate-limit dashboard. A
difference should be investigated before assuming either value is wrong: limits
can be model-, project-, or traffic-specific.

### C2. Missing headers

Run Gemini and Anthropic missions, where the current SDK path may not expose the
same successful-response headers.

Expected: absence of headers is harmless. Testronaut retains its configured or
built-in fallback and still completes the mission.

### C3. Model isolation

Run model A, then start a separate run with model B.

Expected: a learned value for A is never used for B. Current learned state is
process-local, so a new process begins from config/fallback again.

## D. Proactive throttling

Use a multi-turn mission with a page containing a moderately large DOM. Start
with a low override that still permits one request.

### D1. Projected request crosses the safety boundary

Choose a TPM where one turn succeeds but accumulated usage plus the next request
estimate exceeds 90% of the cap.

Expected:

- The CLI prints `Token throttle risk` before sending the risky request.
- It waits until enough of the rolling window expires.
- It retries the same logical turn without losing unmatched tool responses.
- The provider does not receive a burst of repeated requests during the wait.

### D2. Custom safety margin

Repeat with `safetyMargin` values `0.5`, `0.9`, and `1.0`.

Expected: lower margins trigger earlier waits; `1.0` uses the full configured
capacity. Invalid margins fall back safely to `0.9`.

### D3. Oversized single request

Set TPM below the estimated size of the first request.

Expected: Testronaut does not wait forever before a request when there is no
prior rolling usage. The provider may accept it or return a useful quota/context
error. Capture this result because future DOM budgeting should improve it.

### D4. Rolling-window expiry accuracy

Generate two or more turns separated by known intervals, then cross the cap.

Expected: the wait corresponds to expiry of the oldest usage necessary to get
under the effective cap, rather than always sleeping a full minute.

## E. Real `429` recovery

Use a disposable low-quota provider project or a deliberately constrained quota.
Do not create uncontrolled request loops.

### E1. Exact retry timing

Trigger one `429` that includes `Retry-After` or a structured retry duration.

Expected:

- The CLI uses the provider duration, capped at 60 seconds.
- The same mission turn is retried.
- A supplied token limit is learned from error headers.
- The retry counter still stops the run after the existing maximum.

### E2. No retry metadata

Trigger or simulate a `429` without reset information.

Expected: exponential delays of approximately 2, 4, 8, 16, 32, and at most 60
seconds are used, followed by the existing terminal failure behavior.

### E3. Non-TPM quota

Where practical, trigger an RPM, daily, or spend-based quota rather than TPM.

Expected: the CLI respects retry timing but does not mislabel an absent token
limit as a learned TPM. Record the provider error payload for a future normalized
multi-dimensional limiter; redact identifiers and secrets first.

## F. Regression and mission-integrity checks

Run representative missions containing clicks, forms, downloads, screenshots,
and repeated DOM refreshes under both normal and low TPM settings.

Verify:

- Mission results match the pre-change behavior when no throttling is needed.
- Tool call/result pairs remain valid across a wait and retry.
- Turn numbers are not skipped or duplicated in reports.
- DOM injection still occurs and its token estimate contributes to projected
  request sizing.
- API errors other than `429` retain their existing handling.
- No rate-limit header or error metadata leaks credentials into reports.

## G. Suggested test matrix

| Provider | Models | Config source | Pressure | Required result |
|---|---|---|---|---|
| OpenAI | one flagship, one small model | fallback | normal | successful headers learned |
| OpenAI | selected model | explicit `tpm` | low | config remains authoritative |
| OpenAI | selected model | environment | low | environment remains authoritative |
| Gemini | Pro and Flash | fallback | normal | safe operation without headers |
| Gemini | one model | fallback | real/simulated `429` | structured retry honored |
| Anthropic | Sonnet and Haiku | fallback | normal | model fallback isolated |
| Any | selected model | each source | projected crossing | proactive wait and same-turn retry |

## Exit criteria

The change is ready for broader use when all unit tests pass on Node 20+, every
matrix row has evidence, no mission-integrity regression is found, observed
OpenAI headers affect later turns, exact retry metadata beats exponential
backoff, and low-limit runs neither busy-loop nor wait indefinitely.
