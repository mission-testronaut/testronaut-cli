# TODO

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
