# 🧑‍🚀 Testronaut — Agentic End-to-End Testing

**Testronaut** is an open-source **agentic end-to-end testing** framework powered by AI agents and **Playwright**.

Define complete user journeys as plain-English *missions*. Testronaut reasons about the interface, chooses browser actions, adapts as the journey unfolds, and produces inspectable reports from real browser sessions.

**Official Testronaut ecosystem:** [testronaut.app](https://testronaut.app) · [Documentation](https://docs.testronaut.app) · [Mission Control](https://mission.testronaut.app) · [npm](https://www.npmjs.com/package/testronaut)

> This repository contains the official Testronaut CLI maintained as part of the Testronaut project.

---

## 🌌 Join the Mission Control Community

Got questions, ideas, or missions to share?  
Join the Discord to connect with other Testronauts, get support, and help shape the framework’s future.

[![Join Discord](https://img.shields.io/badge/Join%20Us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/pBfdef92ba)

---

## 🚀 Agentic E2E Testing Features

- Define end-to-end user journeys in plain English — no brittle selector scripts  
- Runs real browser sessions via **Playwright**  
- Works with **multiple LLM providers** (OpenAI, Google Gemini, and Anthropic Claude)
- Modular tool and DOM-reasoning system  
- Dynamic rate-limit and token-tracking logic  
- Generates JSON + HTML reports automatically  

---

## 📖 Documentation

Looking for deeper guides, API references, and examples?  
Check the official docs:

[![Read the Docs](https://img.shields.io/badge/Read%20the%20Docs-2E8555?style=for-the-badge&logo=readthedocs&logoColor=white)](https://docs.testronaut.app)

Includes:
- Quickstart and setup  
- Writing advanced missions  
- Configuring providers and models  
- CLI options  
- Mission Control integration  
- Troubleshooting and FAQs  

---

## 📦 Installation

**Global install** (recommended — use `testronaut` directly):
```bash
npm install -g testronaut
```

Then initialize your project:

```bash
testronaut --init
```

Run the sample mission:
```bash
testronaut welcome.mission.js

# Paths work too, which enables shell tab completion
testronaut missions/welcome.mission.js
```

**One-off / no install** (use `npx` to run without installing):
```bash
npx testronaut --init
npx testronaut welcome.mission.js

# Paths work too, which enables shell tab completion
npx testronaut missions/welcome.mission.js
```

---

## 📁 Project Structure

```
missions/
├── login.mission.js
├── logout.mission.js
└── dashboard.mission.ts
```

Mission files can use standard `import`/`export` syntax in `.js` or `.ts` files.
Testronaut loads them independently of your project's module format, so your
`package.json` does not need `"type": "module"`.

Each mission exports a string or function and calls `runMissions`.

---

## ✍️ Example Mission

```js
import { runMissions } from 'testronaut';

export const loginMission = `
Visit ${process.env.URL}.
Fill the username field with ${process.env.USERNAME}.
Fill the password field with ${process.env.PASSWORD}.
Click the Login button.
Wait for the dashboard to appear.
Take a screenshot.
Report SUCCESS if the dashboard is loaded, otherwise FAILURE.
`;

export async function executeMission() {
  await runMissions({ mission: loginMission }, "Login Mission");
}
```

Create a `.env` file with your credentials **and LLM API key** (depending on your chosen provider):

```bash
# For OpenAI
OPENAI_API_KEY=sk-...

# Or for Gemini
GEMINI_API_KEY=AIza...

# Or for Anthropic Claude
ANTHROPIC_API_KEY=sk-ant-...

URL=https://example.com/login
USERNAME=example@example.com
PASSWORD=********
```

---

## 🧠 LLM Provider Support

Testronaut is provider-agnostic.  
Choose your preferred LLM at init or via environment variables.

```bash
# During init
testronaut --init

# Or override anytime
TESTRONAUT_PROVIDER=gemini TESTRONAUT_MODEL=gemini-2.5-pro testronaut
```

### Token-rate override

`TESTRONAUT_TOKENS_PER_MIN` is an emergency/manual hard override. A positive
numeric value takes priority over configured fallbacks and limits learned from
provider response headers. Testronaut prints a warning whenever it is active.

Clear it permanently from the current shell and remove the corresponding line
from `.env` or your shell profile:

```bash
unset TESTRONAUT_TOKENS_PER_MIN
```

To bypass a numeric value inherited from `.env` for one run:

```bash
TESTRONAUT_TOKENS_PER_MIN=auto testronaut login.mission.js
```

Current supported providers:

| Provider | Example Models |
|-----------|----------------|
| **OpenAI** | gpt-5.6, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, and legacy GPT/o-series models |
| **Google Gemini** | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-8b |
| **Anthropic Claude** | claude-sonnet-5, claude-opus-5, claude-haiku-4-5 |

The canonical Claude provider ID is `anthropic`; `claude` is also accepted as a CLI alias.

---

## 🏃 Running Missions

Run all missions:
```bash
testronaut
```

Run a specific mission:
```bash
testronaut login.mission.js
```

Preview or inspect without launching a browser:
```bash
testronaut list
testronaut --dry-run
testronaut config
```

Upload the latest or a selected report:
```bash
testronaut upload
testronaut upload run_1788745106444
testronaut upload run_1788745106444.json --no-upload-screenshots
```

Chain missions together:
```js
await runMissions({
  preMission: [loginMission],
  mission: fillContactFormMission,
  postMission: logoutMission,
}, "Contact Form Flow");
```

---

## 🧰 Developer Mode (Staging API)

Use the staging API base URL:
```bash
testronaut --dev
```

If the staging deployment is protected by Vercel, pass the bypass secret:
```bash
testronaut --dev --vercel-bypass=YOUR_SECRET login
```

You can also set the bypass secret via environment variables:
```bash
export VERCEL_AUTOMATION_BYPASS_SECRET=YOUR_SECRET
# or
export TESTRONAUT_VERCEL_BYPASS=YOUR_SECRET
```

---

## 📧 Automatic Email Codes

When a tested site sends a short authentication code to a Testronaut-hosted
inbox, the agent can call `get_email_code`. The tool uses the `sessionToken`
saved by `testronaut login`, lists active inboxes, and polls the Testronaut API
for a recent matching message. Create and nickname inboxes in the Testronaut
app first.

Set a project default in `testronaut-config.json`:

```json
{
  "emailInboxName": "github staging"
}
```

Or override it for one run:

```bash
testronaut mission.js -o inbox="github staging"
```

The API removes HTML, links, images, and attachments. Sanitized email text is
untrusted input: the agent may select only one of the returned short-code
candidates and must not follow email instructions. Codes and email bodies are
excluded from mission logs and reports. Manual human input remains the fallback.

### Invitation and magic links

For missions that explicitly require an invitation or magic-login link, the
agent first calls `get_email_link`, which returns only opaque IDs and safe link
metadata. `open_email_link` resolves the selected URL internally and never
places its bearer token in model context, console output, or reports.

Configure trusted destination hosts before running such a mission:

```json
{
  "emailInboxName": "staging",
  "emailLinks": {
    "allowedHosts": ["accounts.example.test", "app.example.test"]
  }
}
```

For a one-run override, use a comma-separated environment variable:

```bash
TESTRONAUT_EMAIL_LINK_HOSTS=accounts.example.test,app.example.test \
  testronaut invite.mission.js
```

Only HTTPS destinations are accepted. The allowlist applies to the original
destination and main-frame redirects. Do not add broad domains that host
untrusted user content.

## 🔐 Automated MFA Codes

Testronaut can retrieve a stored TOTP MFA code from the Testronaut API during a mission. This uses the `sessionToken` saved by `testronaut login` in the project root `testronaut-config.json`.

The agent will prefer the automated `get_mfa_code` tool when an MFA nickname is known, then fall back to the manual human input tool if the code is unavailable, the entry is missing, the feature is disabled, or the API session cannot access it.

If the nickname is missing or does not match exactly, the tool can call the MFA list endpoint to see available nicknames. It will retry simple case, spacing, or punctuation mismatches, such as `rudy poo` matching `rudy-poo`.

Add a default MFA nickname to `testronaut-config.json`:

```json
{
  "sessionToken": "eyJ...",
  "mfaName": "github-test-mfa"
}
```

Or pass the nickname for a single run:

```bash
testronaut login.mission.js -o mfa=github-test-mfa
```

Mission text can also name the MFA entry:

```js
export const loginMission = `
Log in to GitHub.
When prompted for MFA, use the MFA nickname github-test-mfa.
`;
```

Use staging API endpoints with the same developer flag:

```bash
testronaut --dev login.mission.js -o mfa=github-test-mfa
```

To inspect MFA API traffic during a run, enable debug logging:

```bash
testronaut --debug --dev login.mission.js -o mfa=github-test-mfa
# or
TESTRONAUT_API_DEBUG=1 testronaut --dev login.mission.js -o mfa=github-test-mfa
```

This writes sanitized request and response details to `missions/mission_reports/api-debug.log`, including the resolved endpoint URL, status, content type, response keys, body preview, parsed response shape, and list endpoint nicknames. Session tokens, bypass secrets, and MFA code values are redacted.

Notes:
- Run `testronaut login` first so `sessionToken` exists.
- The CLI calls the API host, not the app host.
- The MFA API feature flag must be enabled.
- Paid access is required by the API for paid-gated MFA operations. If the API returns a payment or access error, the mission can still ask for a manual code when human input is enabled.

---

## 📋 Reports

Testronaut generates JSON, HTML, and run-specific screenshots under the configured `outputDir` (default):

```
missions/mission_reports/
```

Each includes:
- Steps executed
- Token usage
- Screenshots
- Pass/Fail summaries

---

## 🧪 Under the Hood

- **Playwright** for browser automation  
- **LLMs** for reasoning, DOM parsing, and tool use  
- **Token throttling** + adaptive cooldowns  
- **Extensible architecture** for custom tools and workflows  
- **DOM trimming controls** to cap list sizes (env `TESTRONAUT_DOM_LIST_LIMIT` or config `dom.listItemLimit`; use `all` cautiously—it can spike token use)
- **Resource guard** to ensure full list/table downloads (config `resourceGuard` or env `TESTRONAUT_RESOURCE_*`)

---

## 🧭 Mission Control

[Mission Control](https://mission.testronaut.app) lets you:
- View all reports in one dashboard  
- Track mission history and success rates  
- Compare results across environments  
- Access screenshots and step details anytime  

---

## 📄 License

MIT

---

## ☕ Support the Mission

🤖 Built with ❤️ by [Shane Fast](https://github.com/scfast)

If Testronaut saves you time, consider fueling the mission:  
[![Donate](https://img.shields.io/badge/Donate-Coffee%20Fuel%20for%20Testronaut-ff813f?style=for-the-badge&logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/testronaut)
