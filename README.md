# QAAgent — AI-Powered Exploratory Testing Agent

An autonomous testing agent that explores your web application, discovers bugs, and generates structured reports — without writing a single test script.

## Quick Start

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Configure

Edit three config files in `config/`:

**`config/api.json`** — Your Anthropic API key
```json
{
  "anthropic_api_key": "sk-ant-api03-...",
  "model": "claude-sonnet-4-20250514"
}
```

**`config/target.json`** — Target app URL and credentials
```json
{
  "app_url": "https://your-staging-url.com",
  "profiles": [
    {
      "role": "Liaison",
      "username": "test.liaison@indegene.com",
      "password": "your-password"
    }
  ]
}
```

**`config/stories.json`** — Sprint context (paste your user stories)
```json
{
  "sprint": "Sprint 42",
  "stories": [
    {
      "id": "NEXT-1234",
      "title": "Add validation to briefing form",
      "description": "The briefing form should validate all required fields...",
      "acceptance_criteria": ["All required fields must show error if empty"],
      "modules_affected": ["briefing"]
    }
  ]
}
```

### 3. Run

```bash
# Default — uses first profile, 50 actions, headless
node qaagent.js

# Test as specific role
node qaagent.js --profile "Liaison"

# Show the browser (useful for demos)
node qaagent.js --headed

# Limit exploration to 30 actions
node qaagent.js --max-actions 30

# Combine flags
node qaagent.js --profile "Brand Team" --headed --max-actions 20
```

### 4. Review results

Reports are saved to `reports/session_<timestamp>_<role>/`:

- `QAAgent_Report_<role>.xlsx` — Structured Excel report with findings
- `exploration_log.json` — Full observability log (action + perception + reasoning)
- `findings.json` — Just the findings
- `screenshots/` — Screenshots at key moments

## Project Structure

```
qaagent/
  qaagent.js            # CLI entry point
  config/
    api.json            # Anthropic API key
    target.json         # Target app, credentials, exploration settings
    stories.json        # Sprint stories and acceptance criteria
  src/
    explorer.js         # Core exploration engine (Playwright + Claude loop)
    dom-analyzer.js     # DOM extraction and LLM-friendly formatting
    reporter.js         # Excel report generator
    logger.js           # Observability logger (action/perception/reasoning)
  reports/              # Generated reports (one folder per session)
```

## How It Works

1. **Login** — Authenticates as the configured role profile
2. **Extract** — Reads the page DOM, identifies interactive elements, forms, navigation
3. **Reason** — Sends page state to Claude, which decides what to test next
4. **Act** — Executes the action (click, fill, navigate, submit)
5. **Evaluate** — Claude assesses whether the result is expected or anomalous
6. **Report** — Generates Excel report with all findings, screenshots, and reasoning

The entire loop is logged for full observability — every action, perception, and reasoning step is recorded.

## Environment Variables

You can set passwords via environment variables instead of putting them in config files:

```bash
export QAAGENT_LIAISON_PASSWORD="your-password"
export QAAGENT_BRAND_TEAM_PASSWORD="your-password"
```

The pattern is: `QAAGENT_<ROLE_NAME>_PASSWORD` (role name uppercased, spaces replaced with underscores).
