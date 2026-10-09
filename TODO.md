# TODO

## Quality-of-Life Follow-Ups

- [ ] Add a versioned report schema shared with Mission Control so future report changes can be validated and migrated explicitly.
- [ ] Add resumable, retryable, and idempotent report uploads so interrupted screenshot transfers do not require starting over or create duplicate reports.
- [ ] Add `testronaut doctor` to check Node.js, browser installation, configuration, authentication, output-directory access, and API connectivity without running a mission.
- [ ] Add optional shell completion for commands, flags, mission files, tags, and local report IDs.
- [ ] Treat `--json` output as a stable automation contract with documented schemas and tests for every supported command.
- [ ] If authentication ever moves outside project config, continue reading existing `sessionToken` values and provide an opt-in migration path before deprecating legacy storage.

## Session and Reporting Follow-Ups

- [ ] Evaluate a true shared browser-context mode for suites that require session storage or in-memory application state; define page reset, crash recovery, and concurrency behavior first.
- [ ] Add optional shared-auth checkpoints/reset controls for suites that intentionally change users or tenants.
- [ ] Refresh short-lived Testronaut API session tokens during long runs once the API and credential-storage contract is defined.
- [ ] Store new CLI authentication outside project config, prefer environment credentials in CI, and migrate legacy project `sessionToken` values without breaking existing projects.
- [ ] Add structured post-run self-critique fields after the versioned report schema is available.
- [ ] Separate mission totals from phase totals and add an explicit `phase` field without losing compatibility with `submissionType`.
- [ ] Design an optional mission scope/side-effect policy that agents can enforce and reports can display.
- [ ] Evaluate semantic DOM diffs/chunks after configurable limits, selector scoping, and table trimming have production data.

## Optimization and Rate-Limit Follow-Ups

- [ ] Run a history-informed model-routing benchmark before expanding cross-provider routing. Give Jev versioned, per-model/per-mission-class reliability, token, latency, and price observations from prior runs; require a configurable reliability floor; compare against the best fixed-model-plus-guardrails control with blocked repetitions; keep selection at the mission boundary; record the evidence and reason for every choice; and define cold-start, stale-data, low-confidence, and provider-failure fallbacks. Do not retry a failed mission on another provider in the benchmark because that would confound routing quality with retry recovery.
- [ ] Add an opt-in CLI/config policy that reroutes an imminent throttled LLM request to a compatible model as an alternative to the default backoff behavior. Keep backoff as the default; use observed TPM/RPM headroom and projected request tokens; constrain failover to explicitly configured provider/model families; preserve tool/history compatibility; prevent routing loops; fall back safely when the alternate model is unavailable; and record the original model, routed model, trigger, token usage, latency, and outcome in reports.

## Automated MFA Follow-Ups

- [ ] Add an integration smoke test against a local or staging API fixture for `get_mfa_code`.
- [ ] Add a staging smoke-test checklist that covers `--dev`, `--vercel-bypass`, paid access, free-user fallback, missing nickname, and expired session token behavior.
- [ ] Consider a dedicated `testronaut mfa list` command to verify session token access and available MFA nicknames before running missions.
- [ ] Consider a lightweight MFA preflight warning when `--dev` is used without `VERCEL_AUTOMATION_BYPASS_SECRET`, `TESTRONAUT_VERCEL_BYPASS`, or `--vercel-bypass`.
- [ ] Consider allowing `testronaut mfa list/get` to accept `--api-base` for quick diagnostics against staging, preview, or local API hosts.
- [ ] Track automated MFA outcomes in reports without storing raw codes.
- [ ] Add explicit report/log redaction assertions for MFA codes, session tokens, and Vercel bypass secrets.
- [ ] Decide how long `missions/mission_reports/api-debug.log` should be retained and whether it should rotate, append per run, or be copied into each run report bundle.
- [ ] Decide whether `-o/--options` should support more structured formats once more run options exist.
- [ ] Revisit whether `request_human_input` should return the code to the model or fill fields through a dedicated browser action.
- [ ] Document a troubleshooting matrix for MFA failures: premium required, feature disabled, invalid session, missing nickname, non-JSON/app-shell response, not found, rate limited, and network error.

## Automatic Email Code Follow-Ups

- [ ] Add per-run message leasing or recipient aliases to prevent concurrent missions sharing one inbox from selecting each other's codes.
- [ ] Add a provider-independent inbound email adapter if a second provider is introduced.
- [ ] Consider opaque secret handles so email codes do not need to enter model context.
