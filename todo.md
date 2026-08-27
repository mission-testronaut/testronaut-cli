# Testronaut CLI TODO

## OpenAI provider follow-ups

- Migrate the OpenAI adapter from Chat Completions to the Responses API in a
  dedicated change. Preserve Testronaut's provider-neutral message and tool-call
  contract, add response-ID/reasoning-state handling, normalize usage and raw
  headers, and cover multi-turn tool continuation with unit and API smoke tests.
  Once migrated, remove the GPT-5.6 Chat Completions compatibility override that
  sets `reasoning_effort` to `none` for function-tool requests.
- Add active context budgeting after its behavior is designed and tested. Use
  model context/output metadata to reserve response and reasoning capacity, then
  apply explicit history compaction or summarization rules. Do not silently
  truncate mission instructions, current DOM state, or unmatched tool calls.
- Learn effective OpenAI TPM/RPM limits from successful response headers and
  rate-limit errors. Prefer observed project/model limits over inferring a named
  account tier; retain the environment override and conservative startup values.
