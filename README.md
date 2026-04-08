# QAAgent — AI-Powered Exploratory Testing Agent

An autonomous testing agent that explores your web application, discovers bugs, and generates structured reports — without writing a single test script.

Comes with a real-time web dashboard for configuring sessions, watching the agent explore live, and browsing findings with full observability.

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
      "username": "test.liaison@example.com",
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

**Web Dashboard (recommended)**
```bash
npm start                    # Opens dashboard at http://localhost:3000
npm run start:headed         # Same, but shows the browser window
```

Open `http://localhost:3000` to access the dashboard where you can configure sessions, start/stop exploration, and watch results in real-time.

**CLI mode**
```bash
npm run cli                            # Default — first profile, 50 actions, headless
npm run cli -- --profile "Liaison"     # Test as specific role
npm run cli -- --headed                # Show the browser
npm run cli -- --max-actions 30        # Limit exploration steps
```

### 4. Review results

Reports are saved to `reports/session_<timestamp>_<role>/`:

- `QAAgent_Report_<role>.xlsx` — Structured Excel report with findings
- `exploration_log.json` — Full observability log (action + perception + reasoning)
- `findings.json` — Just the findings
- `screenshots/` — Screenshots at key moments

## Web Dashboard

The dashboard (`npm start`) provides four views:

**Configure & Run** — Shows your loaded config (target URL, profiles, sprint stories, API key status). Select a profile, set max actions, and launch an exploration.

**Live Monitor** — Real-time observability timeline. Every action, perception, reasoning thought, and finding streams in as it happens. Filterable by entry type. Shows live stats (actions, pages visited, findings, duration) and the latest screenshot.

**Findings** — Severity breakdown (critical/high/medium/low) with a full findings table. Click any finding to expand a detail panel showing the agent's reasoning and perception context at the moment of discovery.

**History** — Browse past sessions. Click any session to load its full timeline and findings.

The dashboard uses Express + WebSocket on the backend to stream events from the exploration engine to the React frontend in real-time.

## Project Structure

```
qaagent/
  server.js             # Web dashboard server (Express + WebSocket)
  qaagent.js            # CLI entry point
  dashboard/
    index.html          # React dashboard (single-file, no build step)
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

The entire loop is logged for full observability — every action, perception, and reasoning step is recorded and streamed to the dashboard in real-time.

## Architecture

```
Browser (Playwright)
    ↕
Exploration Engine (explorer.js)
    ↕                    ↕
Claude API          Streaming Logger
(reasoning)         (WebSocket broadcast)
    ↕                    ↕
DOM Analyzer        Web Dashboard (React)
(perception)        (real-time timeline)
    ↕
Excel Reporter
(structured output)
```

## Environment Variables

You can set passwords via environment variables instead of putting them in config files:

```bash
export QAAGENT_LIAISON_PASSWORD="your-password"
export QAAGENT_BRAND_TEAM_PASSWORD="your-password"
```

The pattern is: `QAAGENT_<ROLE_NAME>_PASSWORD` (role name uppercased, spaces replaced with underscores).

## Tech Stack

- **AI:** Claude (Anthropic) for reasoning and test decision-making
- **Browser Automation:** Playwright (Chromium)
- **Backend:** Express + WebSocket (ws)
- **Frontend:** React (CDN, no build step)
- **Reports:** ExcelJS
