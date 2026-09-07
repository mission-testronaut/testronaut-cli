# TODO

## Quality-of-Life Follow-Ups

- [ ] Add a versioned report schema shared with Mission Control so future report changes can be validated and migrated explicitly.
- [ ] Add resumable, retryable, and idempotent report uploads so interrupted screenshot transfers do not require starting over or create duplicate reports.
- [ ] Add `testronaut doctor` to check Node.js, browser installation, configuration, authentication, output-directory access, and API connectivity without running a mission.
- [ ] Add optional shell completion for commands, flags, mission files, tags, and local report IDs.
- [ ] Treat `--json` output as a stable automation contract with documented schemas and tests for every supported command.
- [ ] If authentication ever moves outside project config, continue reading existing `sessionToken` values and provide an opt-in migration path before deprecating legacy storage.

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
