# 🧑‍🚀 Testronaut

**Testronaut** is an autonomous testing framework powered by OpenAI function calling and browser automation. It allows you to define mission-based tests in plain English, then runs them through a real browser to validate UI workflows.

---

## 🚀 Features

- Run real-world UI flows using missions written as plain strings or functions
- Execute entire suites with `runMissions`
- Uses GPT-4o + Playwright to reason and interact with your app
- Dynamic DOM injection and retry logic
- Built-in throttling for OpenAI rate limits
- Modular design — define tools and memory handling as you like

---

## 📦 Installation

```
npm install -g testronaut
```
Or use with npx:
```
npx testronaut
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
Click on the login button.
Fill in the username and password fields.
Submit the form.
Wait for the dashboard to appear.
Report SUCCESS if the dashboard is loaded, otherwise report FAILURE.
`;

export async function executeMission() {
  await runMissions({
    mission: loginMission
  });
}
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
If found, report SUCCESS. Otherwise, report FAILURE.`

export async function executeMission() {
  await runMissions({
    preMission: [loginMission, navigateToContactFormMission],
    mission: fillContactFormMission,
    postMission: logoutMission,
  });
}
```

### 🏃 Running Missions
Run all missions in the missions/ directory:

```
testronaut
```
Run a specific file:

```
testronaut missions/login.mission.js
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

🤖 Built with ❤️ by Shane Fast