#!/usr/bin/env node

/**
 * QAAgent Web Server — Express + WebSocket backend.
 *
 * Serves the React dashboard and streams exploration events
 * to the frontend in real-time via WebSocket.
 *
 * Usage:
 *   node server.js                    # Start on port 3000
 *   node server.js --port 8080        # Custom port
 *   node server.js --headed           # Show browser window during exploration
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { chromium } = require("playwright");
const { ExplorationEngine } = require("./src/explorer");
const { ExplorationLogger } = require("./src/logger");
const { generateReport } = require("./src/reporter");

// ── Parse args ──
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultVal;
  if (typeof defaultVal === "boolean") return true;
  return args[idx + 1] || defaultVal;
}

const PORT = parseInt(getArg("port", "3000"), 10);
const headed = getArg("headed", false);

// ── Express + WS setup ──
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use("/reports", express.static(path.join(__dirname, "reports")));
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

// Serve the main dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "index.html"));
});

// ── State ──
let currentSession = null;
let activeBrowser = null;

// ── API Endpoints ──

// Helper to safely load a config file
function loadConfigFile(filename, defaultVal) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config", filename), "utf-8"));
  } catch {
    return defaultVal;
  }
}

// GET /api/config — Return current config (with sensitive data masked)
app.get("/api/config", (req, res) => {
  try {
    const target = loadConfigFile("target.json", { app_url: "", profiles: [] });
    const stories = loadConfigFile("stories.json", { sprint: "", stories: [] });
    const platform = loadConfigFile("platform_context.json", { blocks: [] });
    const api = loadConfigFile("api.json", {});

    const maskedKey = api.anthropic_api_key
      ? `${api.anthropic_api_key.slice(0, 12)}...${api.anthropic_api_key.slice(-4)}`
      : "NOT SET";

    res.json({
      target: {
        app_url: target.app_url || "",
        profiles: (target.profiles || []).map((p) => ({
          role: p.role,
          username: p.username,
          scope: p.scope || [],
          hasPassword: !!p.password && p.password !== "YOUR_PASSWORD_HERE",
        })),
        exploration: target.exploration || { strategy: "breadth", max_actions: 50 },
      },
      stories,
      platform,
      api: { model: api.model, apiKey: maskedKey, configured: !!(api.anthropic_api_key && api.anthropic_api_key !== "YOUR_ANTHROPIC_API_KEY_HERE") },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/config/stories — Update stories config
app.post("/api/config/stories", (req, res) => {
  try {
    const storiesPath = path.join(__dirname, "config", "stories.json");
    fs.writeFileSync(storiesPath, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/config/target — Update target config
app.post("/api/config/target", (req, res) => {
  try {
    const targetPath = path.join(__dirname, "config", "target.json");
    const existing = loadConfigFile("target.json", {});
    // Merge profiles by role; preserve existing passwords if new payload doesn't include one
    const merged = {
      ...existing,
      app_url: req.body.app_url ?? existing.app_url ?? "",
      exploration: req.body.exploration ?? existing.exploration ?? { strategy: "breadth", max_actions: 50, screenshot_on: ["page_transition", "form_submit", "error_state", "anomaly"] },
      login: existing.login || {
        url: "/login",
        username_selector: "input[name='username'], input[type='email'], #username, #email",
        password_selector: "input[name='password'], input[type='password'], #password",
        submit_selector: "button[type='submit'], input[type='submit'], button:has-text('Log in'), button:has-text('Sign in')",
      },
    };
    if (Array.isArray(req.body.profiles)) {
      const existingByRole = {};
      (existing.profiles || []).forEach((p) => { existingByRole[p.role] = p; });
      merged.profiles = req.body.profiles.map((p) => {
        const prev = existingByRole[p.role] || {};
        return {
          role: p.role || prev.role || "",
          username: p.username || prev.username || "",
          // If password sent and non-empty use it; otherwise keep existing
          password: (p.password && p.password.length > 0) ? p.password : (prev.password || ""),
          scope: p.scope || prev.scope || [],
        };
      });
    }
    fs.writeFileSync(targetPath, JSON.stringify(merged, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/config/platform — Update platform context
app.post("/api/config/platform", (req, res) => {
  try {
    const platformPath = path.join(__dirname, "config", "platform_context.json");
    const blocks = Array.isArray(req.body.blocks) ? req.body.blocks : [];
    fs.writeFileSync(platformPath, JSON.stringify({ blocks }, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/plan — Generate a focused test plan via Claude before execution
app.post("/api/plan", async (req, res) => {
  try {
    const { storyId } = req.body || {};
    const apiConfig = loadConfigFile("api.json", {});
    const storiesConfig = loadConfigFile("stories.json", { stories: [] });
    const platformConfig = loadConfigFile("platform_context.json", { blocks: [] });

    if (!apiConfig.anthropic_api_key || apiConfig.anthropic_api_key === "YOUR_ANTHROPIC_API_KEY_HERE") {
      return res.status(400).json({ error: "API key not configured" });
    }

    // Find the requested story (or use first)
    const story = storyId
      ? storiesConfig.stories.find((s) => s.id === storyId)
      : storiesConfig.stories[0];
    if (!story) return res.status(400).json({ error: "No story available to plan" });

    const platformText = (platformConfig.blocks || [])
      .map((b) => `### ${b.title}\n${b.content}`)
      .join("\n\n") || "No platform context provided.";

    const planPrompt = `You are a senior QA test planner. Given a user story and platform context, generate a FOCUSED test plan that targets only the relevant areas. Avoid testing unrelated modules to save time and tokens.

## User Story
ID: ${story.id}
Title: ${story.title}
Description: ${story.description || ""}
${story.acceptance_criteria?.length ? "Acceptance Criteria:\n" + story.acceptance_criteria.map((ac) => "- " + ac).join("\n") : ""}
${story.modules_affected?.length ? "Modules affected: " + story.modules_affected.join(", ") : ""}

## Platform Context
${platformText}

## Task
Create a focused test plan. Output ONLY valid JSON, no markdown, no code fences:
{
  "summary": "1-sentence description of what you'll test",
  "areas_to_test": [
    { "name": "Area name", "what": "What you'll verify", "priority": "high|medium|low" }
  ],
  "areas_to_skip": [
    { "name": "Area name", "reason": "Why you're skipping this" }
  ],
  "estimated_actions": <number 5-30>,
  "rationale": "1-2 sentence explanation of why this scope is correct given the story and platform context"
}`;

    const Anthropic = require("@anthropic-ai/sdk").default;
    const client = new Anthropic({ apiKey: apiConfig.anthropic_api_key });
    const response = await client.messages.create({
      model: apiConfig.model || "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: planPrompt }],
    });
    const text = response.content[0]?.text || "";
    let plan;
    try {
      plan = JSON.parse(text.trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      plan = match ? JSON.parse(match[0]) : null;
    }
    if (!plan) return res.status(500).json({ error: "Failed to parse plan from LLM" });

    res.json({ ok: true, plan, story });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions — List past sessions
app.get("/api/sessions", (req, res) => {
  try {
    const reportsDir = path.join(__dirname, "reports");
    if (!fs.existsSync(reportsDir)) return res.json([]);
    const sessions = fs.readdirSync(reportsDir)
      .filter((d) => d.startsWith("session_"))
      .map((d) => {
        const sessionDir = path.join(reportsDir, d);
        const logPath = path.join(sessionDir, "exploration_log.json");
        const findingsPath = path.join(sessionDir, "findings.json");
        let findings = [];
        let entries = [];
        try { entries = JSON.parse(fs.readFileSync(logPath, "utf-8")); } catch {}
        try { findings = JSON.parse(fs.readFileSync(findingsPath, "utf-8")); } catch {}
        return {
          id: d,
          date: d.replace("session_", "").split("_").slice(0, 2).join("_"),
          findings: findings.length,
          actions: entries.filter((e) => e.type === "ACTION").length,
          entries: entries.length,
          hasReport: fs.existsSync(path.join(sessionDir, fs.readdirSync(sessionDir).find((f) => f.endsWith(".xlsx")) || "nope")),
        };
      })
      .sort((a, b) => b.id.localeCompare(a.id));
    res.json(sessions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions/:id — Get full session data
app.get("/api/sessions/:id", (req, res) => {
  try {
    const sessionDir = path.join(__dirname, "reports", req.params.id);
    if (!fs.existsSync(sessionDir)) return res.status(404).json({ error: "Session not found" });
    const logPath = path.join(sessionDir, "exploration_log.json");
    const findingsPath = path.join(sessionDir, "findings.json");
    let entries = [];
    let findings = [];
    try { entries = JSON.parse(fs.readFileSync(logPath, "utf-8")); } catch {}
    try { findings = JSON.parse(fs.readFileSync(findingsPath, "utf-8")); } catch {}

    // Find report file
    const files = fs.readdirSync(sessionDir);
    const reportFile = files.find((f) => f.endsWith(".xlsx"));
    const screenshots = files.filter((f) => f === "screenshots" ? false : true);

    res.json({ id: req.params.id, entries, findings, reportFile, screenshots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/open-report-folder — Open the latest (or a specific) session folder in the OS file explorer
app.post("/api/open-report-folder", (req, res) => {
  try {
    const reportsDir = path.join(__dirname, "reports");
    if (!fs.existsSync(reportsDir)) return res.status(404).json({ error: "No reports yet" });

    let sessionId = req.body?.sessionId;
    if (!sessionId) {
      const sessions = fs.readdirSync(reportsDir)
        .filter((d) => d.startsWith("session_"))
        .sort();
      sessionId = sessions[sessions.length - 1];
    }
    if (!sessionId) return res.status(404).json({ error: "No sessions available" });

    const targetDir = path.join(reportsDir, sessionId);
    if (!fs.existsSync(targetDir)) return res.status(404).json({ error: "Session folder not found" });

    const { spawn } = require("child_process");
    const platform = process.platform;
    let cmd, cmdArgs;
    if (platform === "darwin") { cmd = "open"; cmdArgs = [targetDir]; }
    else if (platform === "win32") { cmd = "explorer"; cmdArgs = [targetDir]; }
    else { cmd = "xdg-open"; cmdArgs = [targetDir]; }

    const child = spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" });
    child.on("error", (err) => console.error("Failed to open folder:", err.message));
    child.unref();

    res.json({ ok: true, sessionId, path: targetDir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/sessions/:id/screenshots/:file — Serve screenshot
app.get("/api/sessions/:id/screenshots/:file", (req, res) => {
  const filePath = path.join(__dirname, "reports", req.params.id, "screenshots", req.params.file);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("Not found");
  }
});

// GET /api/status — Current exploration status
app.get("/api/status", (req, res) => {
  res.json({
    running: !!currentSession,
    session: currentSession
      ? {
          id: currentSession.id,
          startedAt: currentSession.startedAt,
          actions: currentSession.actionCount,
          maxActions: currentSession.maxActions,
          findings: currentSession.findingsCount,
          profile: currentSession.profile,
        }
      : null,
  });
});

// POST /api/explore — Start exploration
app.post("/api/explore", async (req, res) => {
  if (currentSession) {
    return res.status(409).json({ error: "Exploration already running. Stop it first." });
  }

  const { profileRole, maxActions = 50, stories, plan } = req.body;

  // Load configs
  const configDir = path.join(__dirname, "config");
  let apiConfig, targetConfig, storiesConfig, platformConfig;
  try {
    apiConfig = JSON.parse(fs.readFileSync(path.join(configDir, "api.json"), "utf-8"));
    targetConfig = JSON.parse(fs.readFileSync(path.join(configDir, "target.json"), "utf-8"));
    storiesConfig = stories || JSON.parse(fs.readFileSync(path.join(configDir, "stories.json"), "utf-8"));
    platformConfig = loadConfigFile("platform_context.json", { blocks: [] });
  } catch (e) {
    return res.status(500).json({ error: `Config error: ${e.message}` });
  }

  if (!apiConfig.anthropic_api_key || apiConfig.anthropic_api_key === "YOUR_ANTHROPIC_API_KEY_HERE") {
    return res.status(400).json({ error: "API key not configured. Set it in config/api.json" });
  }

  // Select profile
  let activeProfile = null;
  if (profileRole) {
    activeProfile = targetConfig.profiles?.find((p) => p.role.toLowerCase() === profileRole.toLowerCase());
    if (!activeProfile) {
      return res.status(400).json({ error: `Profile "${profileRole}" not found` });
    }
  } else if (targetConfig.profiles?.length > 0) {
    activeProfile = targetConfig.profiles[0];
  }

  // Create session
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sessionDir = path.join(__dirname, "reports", `session_${sessionId}_${activeProfile?.role || "default"}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  currentSession = {
    id: `session_${sessionId}_${activeProfile?.role || "default"}`,
    startedAt: new Date().toISOString(),
    actionCount: 0,
    maxActions: maxActions,
    findingsCount: 0,
    profile: activeProfile?.role || "default",
    aborted: false,
    plan: plan || null,
  };

  broadcast({ type: "session_start", session: currentSession });
  res.json({ ok: true, sessionId: currentSession.id });

  // Run exploration in the background
  runExploration(apiConfig, targetConfig, storiesConfig, platformConfig, activeProfile, maxActions, sessionDir, plan);
});

// POST /api/stop — Stop exploration
app.post("/api/stop", (req, res) => {
  if (!currentSession) {
    return res.status(400).json({ error: "No exploration running" });
  }
  currentSession.aborted = true;
  broadcast({ type: "session_stopping" });
  res.json({ ok: true });
});

// ── WebSocket ──
const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  // Send current status
  ws.send(JSON.stringify({
    type: "status",
    running: !!currentSession,
    session: currentSession,
  }));
  ws.on("close", () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}

// ── Exploration Runner ──
async function runExploration(apiConfig, targetConfig, storiesConfig, platformConfig, activeProfile, maxActions, sessionDir, plan) {
  // Create a streaming logger that broadcasts events
  const logger = new StreamingLogger(sessionDir, broadcast);

  let browser;
  try {
    broadcast({ type: "log", entry: { type: "INFO", message: "Launching browser..." } });
    browser = await chromium.launch({
      headless: !headed,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    activeBrowser = browser;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // Console & network listeners
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        logger.logError({ message: `Console error: ${msg.text()}` });
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        logger.logError({ message: `HTTP ${response.status()}: ${response.url()}` });
      }
    });

    // Login
    if (activeProfile) {
      broadcast({ type: "log", entry: { type: "INFO", message: `Logging in as ${activeProfile.role}...` } });
      const loginUrl = targetConfig.app_url + (targetConfig.login?.url || "/login");
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);

      const usernameSelectors = (targetConfig.login?.username_selector || "input[type='email']").split(", ");
      for (const sel of usernameSelectors) {
        try {
          const el = page.locator(sel.trim()).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.fill(activeProfile.username);
            break;
          }
        } catch {}
      }

      const passwordSelectors = (targetConfig.login?.password_selector || "input[type='password']").split(", ");
      for (const sel of passwordSelectors) {
        try {
          const el = page.locator(sel.trim()).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.fill(activeProfile.password);
            break;
          }
        } catch {}
      }

      const submitSelectors = (targetConfig.login?.submit_selector || "button[type='submit']").split(", ");
      for (const sel of submitSelectors) {
        try {
          const el = page.locator(sel.trim()).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.click();
            break;
          }
        } catch {}
      }

      await page.waitForTimeout(3000);
      await logger.saveScreenshot(page, "after_login");
      broadcast({ type: "log", entry: { type: "INFO", message: `Login complete. URL: ${page.url()}` } });
    } else {
      await page.goto(targetConfig.app_url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);
    }

    // Run engine with abort check
    const engine = new ExplorationEngine({
      page,
      config: {
        ...targetConfig,
        apiKey: apiConfig.anthropic_api_key,
        model: apiConfig.model,
        activeProfile,
        exploration: { ...targetConfig.exploration, max_actions: maxActions },
        plan,
        platformContext: platformConfig,
      },
      stories: storiesConfig,
      logger,
      abortCheck: () => currentSession?.aborted === true,
    });

    await engine.explore();

    // Generate report
    broadcast({ type: "log", entry: { type: "INFO", message: "Generating report..." } });
    const reportPath = await generateReport(logger, sessionDir, activeProfile?.role);
    logger.save();

    broadcast({
      type: "session_complete",
      session: {
        ...currentSession,
        findings: logger.findings.length,
        actions: logger.entries.filter((e) => e.type === "ACTION").length,
        reportFile: path.basename(reportPath),
      },
    });
  } catch (error) {
    broadcast({
      type: "session_error",
      error: error.message,
    });
    logger.logError(error);
    logger.save();
  } finally {
    if (browser) await browser.close();
    activeBrowser = null;
    currentSession = null;
  }
}

/**
 * StreamingLogger — Extends ExplorationLogger to broadcast events via WebSocket.
 */
class StreamingLogger extends ExplorationLogger {
  constructor(sessionDir, broadcastFn) {
    super(sessionDir);
    this.broadcast = broadcastFn;
  }

  logAction(action) {
    const entry = super.logAction(action);
    this.broadcast({ type: "entry", entry });
    if (currentSession) currentSession.actionCount++;
    return entry;
  }

  logPerception(pageState) {
    const entry = super.logPerception(pageState);
    this.broadcast({ type: "entry", entry });
    return entry;
  }

  logReasoning(reasoning) {
    const entry = super.logReasoning(reasoning);
    this.broadcast({ type: "entry", entry });
    return entry;
  }

  logFinding(finding) {
    const entry = super.logFinding(finding);
    this.broadcast({ type: "entry", entry });
    if (currentSession) {
      if (entry.result === "Pass") currentSession.passCount = (currentSession.passCount || 0) + 1;
      else currentSession.failCount = (currentSession.failCount || 0) + 1;
      currentSession.findingsCount = (currentSession.findingsCount || 0) + 1;
    }
    return entry;
  }

  logError(error) {
    const entry = super.logError(error);
    this.broadcast({ type: "entry", entry });
    return entry;
  }

  async saveScreenshot(page, label) {
    const filepath = await super.saveScreenshot(page, label);
    if (filepath) {
      this.broadcast({
        type: "screenshot",
        filename: path.basename(filepath),
        sessionId: currentSession?.id,
      });
    }
    return filepath;
  }

  signalThinking(on) {
    this.broadcast({ type: "thinking", on: !!on });
  }
}

// ── Start ──
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║      QAAgent Dashboard — http://localhost:${PORT}  ║
╚══════════════════════════════════════════════╝
`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  API:       http://localhost:${PORT}/api`);
  console.log(`  WebSocket: ws://localhost:${PORT}`);
  console.log(`  Browser:   ${headed ? "Headed (visible)" : "Headless"}`);
  console.log("");
});
