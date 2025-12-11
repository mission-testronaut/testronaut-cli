# 🧑‍🚀 Testronaut

**Testronaut** is an autonomous testing framework powered by **LLMs and Playwright**.  
It lets you define *mission-based tests* in plain English, then runs them through a real browser to validate UI workflows — all while generating human-readable reports.

---

## 🌌 Join the Mission Control Community

Got questions, ideas, or missions to share?  
Join the Discord to connect with other Testronauts, get support, and help shape the framework’s future.

[![Join Discord](https://img.shields.io/badge/Join%20Us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/pBfdef92ba)

---

## 🚀 Features

- Write tests in plain English — no brittle selectors  
- Runs real browser sessions via **Playwright**  
- Works with **multiple LLM providers** (OpenAI, Google Gemini, and more coming)  
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

```bash
npm install -g testronaut
```

Then initialize your project:

```bash
npx testronaut --init
```

Run the sample mission:
```bash
npx testronaut welcome.mission.js
```

---

## 📁 Project Structure

```
missions/
├── login.mission.js
├── logout.mission.js
└── dashboard.mission.js
```

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
npx testronaut --init

# Or override anytime
TESTRONAUT_PROVIDER=gemini TESTRONAUT_MODEL=gemini-2.5-pro npx testronaut
```

Current supported providers:

| Provider | Example Models |
|-----------|----------------|
| **OpenAI** | gpt-4o, gpt-4.1, o3, gpt-5, gpt-5.1, etc. |
| **Google Gemini** | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-8b |

More providers coming soon (Anthropic, Mistral, etc.).

---

## 🏃 Running Missions

Run all missions:
```bash
npx testronaut
```

Run a specific mission:
```bash
npx testronaut login.mission.js
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

## 📋 Reports

Testronaut generates both JSON and HTML reports automatically under:

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
