# Contributing to 🧑‍🚀 Testronaut

Thanks for your interest in contributing to 🧑‍🚀 **Testronaut**! 🚀  
This document outlines how to set up your environment, run tests, and write code and documentation that align with the project’s standards.

---

## 🧭 Project Overview

🧑‍🚀 **Testronaut** is an open-source CLI for autonomous end-to-end testing.  
It provides mission-driven testing flows, LLM provider integrations (OpenAI, Gemini, etc.), and a growing ecosystem of helpers and automation tools.

This guide applies to all contributions — whether you're fixing a bug, improving documentation, or adding new features.

---

## 🧩 Local Development Setup

1. **Clone the repository**
    ```bash
    git clone https://github.com/<your-org-or-user>/testronaut.git
    cd testronaut
    ```
    Install dependencies
    ```bash
    npm install
    ```
    Run the CLI locally

    ```bash
    node ./bin/testronaut.js init
    ```
    Run tests
    ```bash
    npm test
    # or watch mode
    npm run test:watch
    ```


## 🧪 Testing Guidelines
  We use [Vitest](https://vitest.dev/) for unit testing.

### Test Structure
- Unit tests → tests/initHelpersTests/ and similar subfolders
  - Pure, no side effects
  - Target helpers and utilities directly
  - Fast and deterministic



### Commands
  ```bash
  # Run all tests
  npm test

  # Watch mode
  npm run test:watch

  # Coverage report
  npx vitest run --coverage
  ```

### Principles
- Each helper or core module should have at least one test file.
- Tests should verify behavior, not implementation details.
- Prefer fixtures over mocks when possible.

## 💬 Comment & Documentation Standards
Testronaut uses structured, meaningful comments to make the codebase self-documenting.

### 1. File Headers
Every source file should start with a doc header that summarizes:

- Purpose: What the file is responsible for
- Responsibilities: Major actions or logic areas
- Side effects: I/O or network operations
- Related tests: Folder or suite where its tests live
- Used by: Other modules that import it

Example:
```js

/**
 * ExampleModule.js
 * ----------------
 * Purpose:
 *   Handles mission parsing and validation for CLI runs.
 *
 * Design goals:
 *   - Pure functions where possible
 *   - Unit-tested via Vitest
 *
 * Related tests:
 *   Located in `tests/exampleModuleTests/`
 *
 * Used by:
 *   ./cli/runMission.js
 */
```

### 2. Inline Comments
- Focus on why rather than what the code is doing.
- Use NOTE: or TODO: prefixes to highlight rationale or future work.
- Avoid restating code syntax (“// read file”).

Example:
```js
// NOTE: We skip writing .env if it already exists to avoid overwriting secrets.
```

### 3. Section Headers
Use clear dividers for major logical steps in longer scripts (e.g., CLI commands):
```js
// ─────────────────────────────
// STEP 3: Merge defaults safely
// ─────────────────────────────
```

### 4. Function Documentation (JSDoc)
Add JSDoc blocks for all exported functions and for internal ones with nontrivial logic:
```js
/**
 * Generates default configuration for new projects.
 *
 * @param {string} rootBasename - The current directory name.
 * @returns {{initialized: boolean, outputDir: string}}
 */
export function defaultConfig(rootBasename) { ... }
```
These comments improve IDE autocompletion and make code self-descriptive.

### 5. Test References
If a file has full coverage:
- Add one Related tests: line at the top (e.g., tests/initHelpersTests/).
- Don’t link to individual test files unless the logic is unusually complex.

## 🧱 Code Style
- Language: Modern JavaScript (ES Modules only)
- Linting: Use ESLint + Prettier (follow repo config)
- Imports: Order as → Node built-ins → Third-party → Local
- Async: Prefer async/await over callbacks
- File Names: Use camelCase for utilities, PascalCase for React components (if applicable)

## 🧰 Folder Conventions
| Folder | Purpose |
|---|---|
/bin/	| CLI logic, utilities, helpers
/core/ | central functionality, turn loop, and agent management
/tests/	| All Vitest unit tests
/runner/	| Mission runner and suite management
/openAI/ |	OpenAI specific helper functions

## ⚙️ Submitting Changes
1. Create a new branch
```bash
git checkout -b feat/new-provider
```

2. Make your changes
- Keep commits focused and descriptive
- Follow documentation and testing standards

3. Run 
```bash
npm test
```

4. Open a Pull Request
- Reference related issues if applicable
- Summarize what was added, fixed, or refactored

## 🧑‍💻 Example of a “Good” PR Description
> ### Summary
> Adds Gemini provider support to the CLI init flow.
> Includes unit tests for new helper functions in initHelpers.js.
>
> ### Details
> - Added new prompt for selecting Gemini model
> - Updated .env scaffold to include GEMINI_API_KEY
> - Added tests in tests/initHelpersTests/makeEnvTemplate.test.js
>
> ### Checklist
> - Unit tests pass (npm test)
> - Comments and headers added
> - No regressions in CLI behavior

## 🤝 Code of Conduct
We expect all contributors to follow the Code of Conduct.
Be respectful, collaborative, and kind — we’re all here to build something great together.

## 🧡 Thank You
Your contributions make 🧑‍🚀 Testronaut better for everyone — from developers automating their first mission to teams running autonomous test fleets.
We deeply appreciate your time, effort, and ideas.