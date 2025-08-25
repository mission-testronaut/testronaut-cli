# 🧑‍🚀 Testronaut

**Testronaut** is an autonomous testing framework powered by OpenAI function calling and browser automation. It allows you to define mission-based tests in plain English, then runs them through a real browser to validate UI workflows.

---

## 🌌 Join the Mission Control Community

Got questions, ideas, or want to share your missions?  
Join our Discord to connect with other Testronauts, get support, and help shape the framework’s future.  

[![Join Discord](https://img.shields.io/badge/Join%20Us%20on%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/pBfdef92ba)

---

## 🚀 Features

- Run real-world UI flows using missions written as plain strings or functions
- Execute entire suites with `runMissions`
- Uses GPT-4o + Playwright to reason and interact with your app
- Dynamic DOM injection and retry logic
- Built-in throttling for OpenAI rate limits
- Modular design — define tools and memory handling as you like

---

## 📖 Documentation

Looking for deeper guides, API references, and examples?  
Head over to the official Testronaut Docs:

[![Read the Docs](https://img.shields.io/badge/Read%20the%20Docs-2E8555?style=for-the-badge&logo=readthedocs&logoColor=white)](https://docs.testronaut.app)

The docs cover:
- Getting started step-by-step
- Writing advanced missions
- CLI options and configuration
- Integrating with Mission Control
- Troubleshooting & FAQs

---

## 📦 Installation

```
npm install -g testronaut
```
Then initialize with npx, following the instructions:
```
npx testronaut --init
```
run the welcome mission:
```
npx testronaut welcome.mission.js
```
📁 Directory Structure
Your project should include a missions/ folder with mission files like:

```
missions/
├── login.mission.js
├── logout.mission.js
└── dashboard.mission.js
```
Each file exports a mission string or function and invokes runMissions.

### ✍️ Writing a Mission File
Create a file in your missions/ directory, e.g. missions/login.mission.js:

```
import { runMissions } from 'testronaut';

export const loginMission = `
Visit ${process.env.URL}.
Fill the username field with ${process.env.USERNAME}. 
Fill the password field with ${process.env.PASSWORD}.
Take a screenshot.
Submit the form.
Wait for the dashboard to appear.
Take another screenshot.
Report SUCCESS if the dashboard is loaded, otherwise report FAILURE.
`;

export async function executeMission() {
  await runMissions({
    mission: loginMission
  }, "Login Mission");
}
```

Pass in credentials using an .env file. The .env file should also include your Open AI API key (permissions to the completions endpoint required):

```
OPENAI_API_KEY=sk-proj-############
URL=https://example.com/login
USERNAME=example@example.com
PASSWORD=********
```

You can chain multiple phases:

```
import { runMissions } from 'testronaut';
import { loginMission } from './login.mission.js';
import { logoutMission } from './logout.mission.js';
import { navigateToContactFormMission } from './navigateToContactForm.mission.js';

export const fillContactFormMission = 
`Input the text "example@example.com" in the email field.
Input the phone number (555)555-5555 into the phone number field.
Click the submit button.
Upon submission success there should be a toast notification indicating the form information was saved successfully.
Take a screenshot.
If found, report SUCCESS. Otherwise, report FAILURE.`

export async function executeMission() {
  await runMissions({
    preMission: [loginMission, navigateToContactFormMission],
    mission: fillContactFormMission,
    postMission: logoutMission,
  }, "Fill Contact Form Mission");
}
```

### 🏃 Running Missions
Run all missions in the missions/ directory:

```
npx testronaut
```
Run a specific file:

```
npx testronaut login.mission.js
```

🧰 Available Helpers

```
runMissions({ preMission, mission, postMission }) 
```
– Runs test phases

```
mission(name, fn) and objective(desc, workflow) 
```
– Optional suite syntax

```
runSuite(objectives)
```
– Executes all registered test objectives

### 📋 Reports
HTML and JSON reports automatically created in the ```missions/mission_reports/``` directory for each testronaut run

### 🧪 Under the Hood
Uses Playwright for browser automation

Interacts with OpenAI’s GPT-4o via Function Calling

Supports modular tool definitions via CHROME_TOOL_MAP

🔧 Developing Locally
Clone and install locally:

```
npm install
npm link
```
Now you can use testronaut in any local project.

### 📄 License
MIT

--

### 📊 Track Your Missions Over Time
Want to see your test results evolve, spot trends, and keep all your reports in one place?  
Sign up for **Mission Control** — your personal dashboard for Testronaut.

With Mission Control you can:
- 📈 Track your mission reports historically
- 🔍 Drill into past runs with full step-by-step details
- 🛠️ Compare results between different builds or environments
- ☁️ Access reports from anywhere, without digging through local files

Getting started is simple:
1. [![Sign up for Mission Control](https://img.shields.io/badge/Sign%20Up%20for%20Mission%20Control-0A84FF?style=for-the-badge&logo=rocket&logoColor=white)](https://mission.testronaut.app)
2. Link your account to Testronaut CLI
3. Watch your mission history grow!

---

## ☕ Support the Mission
🤖 Built with ❤️ by [Shane Fast](https://github.com/scfast)

If Testronaut has helped you save time or improve your testing, consider fueling the mission!  
Your support helps cover hosting, development time, and the occasional coffee needed to debug at 2am.

[![Donate](https://img.shields.io/badge/Donate-Coffee%20Fuel%20for%20Testronaut-ff813f?style=for-the-badge&logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/testronaut)

---
