#!/usr/bin/env node

/**
 * QAAgent — AI-Powered Exploratory Testing Agent
 *
 * Usage:
 *   node qaagent.js                        # Run with default config
 *   node qaagent.js --profile "Liaison"    # Test as specific role
 *   node qaagent.js --max-actions 30       # Limit exploration steps
 *   node qaagent.js --headed               # Show browser (not headless)
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { ExplorationEngine } = require("./src/explorer");
const { ExplorationLogger } = require("./src/logger");
const { generateReport } = require("./src/reporter");

// ── Parse CLI args ──
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultVal;
  if (typeof defaultVal === "boolean") return true;
  return args[idx + 1] || defaultVal;
}

const profileName = getArg("profile", null);
const maxActions = parseInt(getArg("max-actions", "50"), 10);
const headed = getArg("headed", false);

// ── Load configs ──
function loadJSON(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch (e) {
    console.error(`Failed to load ${filepath}: ${e.message}`);
    process.exit(1);
  }
}

const configDir = path.join(__dirname, "config");
const apiConfig = loadJSON(path.join(configDir, "api.json"));
const targetConfig = loadJSON(path.join(configDir, "target.json"));
const storiesConfig = loadJSON(path.join(configDir, "stories.json"));

// Validate API key
if (!apiConfig.anthropic_api_key || apiConfig.anthropic_api_key === "YOUR_ANTHROPIC_API_KEY_HERE") {
  console.error("\n❌ Please set your Anthropic API key in config/api.json\n");
  process.exit(1);
}

// Validate target URL
if (!targetConfig.app_url || targetConfig.app_url.includes("example.com")) {
  console.error("\n❌ Please set your application URL in config/target.json\n");
  process.exit(1);
}

// Select profile
let activeProfile = null;
if (profileName) {
  activeProfile = targetConfig.profiles?.find(
    (p) => p.role.toLowerCase() === profileName.toLowerCase()
  );
  if (!activeProfile) {
    console.error(`\n❌ Profile "${profileName}" not found. Available: ${targetConfig.profiles?.map((p) => p.role).join(", ")}\n`);
    process.exit(1);
  }
} else if (targetConfig.profiles?.length > 0) {
  activeProfile = targetConfig.profiles[0];
}

if (activeProfile && (activeProfile.password === "YOUR_PASSWORD_HERE" || !activeProfile.password)) {
  // Check env vars
  const envKey = `QAAGENT_${activeProfile.role.toUpperCase().replace(/\s+/g, "_")}_PASSWORD`;
  if (process.env[envKey]) {
    activeProfile.password = process.env[envKey];
  } else {
    console.error(`\n❌ Please set password for "${activeProfile.role}" in config/target.json or set env var ${envKey}\n`);
    process.exit(1);
  }
}

// ── Main ──
async function main() {
  console.log(`
╔══════════════════════════════════════════════╗
║         QAAgent v1.0 — Exploratory Testing   ║
╚══════════════════════════════════════════════╝
`);
  console.log(`Target:     ${targetConfig.app_url}`);
  console.log(`Profile:    ${activeProfile?.role || "No profile"}`);
  console.log(`Strategy:   Breadth-first`);
  console.log(`Max actions: ${maxActions}`);
  console.log(`Sprint:     ${storiesConfig.sprint || "No sprint context"}`);
  console.log(`Stories:    ${storiesConfig.stories?.length || 0}`);
  console.log(`Browser:    ${headed ? "Headed (visible)" : "Headless"}`);
  console.log("");

  // Create session directory
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const sessionDir = path.join(__dirname, "reports", `session_${sessionId}_${activeProfile?.role || "default"}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Initialize logger
  const logger = new ExplorationLogger(sessionDir);

  // Launch browser
  console.log("🚀 Launching browser...\n");
  const browser = await chromium.launch({
    headless: !headed,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Listen for console errors and network failures
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

  try {
    // ── Login ──
    if (activeProfile) {
      console.log(`🔐 Logging in as ${activeProfile.role} (${activeProfile.username})...\n`);
      const loginUrl = targetConfig.app_url + (targetConfig.login?.url || "/login");
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);

      // Try each selector for username
      const usernameSelectors = (targetConfig.login?.username_selector || "input[type='email']").split(", ");
      let filled = false;
      for (const sel of usernameSelectors) {
        try {
          const el = page.locator(sel.trim()).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.fill(activeProfile.username);
            filled = true;
            break;
          }
        } catch {}
      }
      if (!filled) {
        console.error("❌ Could not find username field. Check login selectors in config/target.json");
      }

      // Password
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

      // Submit
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
      console.log(`✅ Login complete. Current URL: ${page.url()}\n`);
    } else {
      // No profile — just navigate to the app
      await page.goto(targetConfig.app_url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);
    }

    // ── Explore ──
    const engine = new ExplorationEngine({
      page,
      config: {
        ...targetConfig,
        apiKey: apiConfig.anthropic_api_key,
        model: apiConfig.model,
        activeProfile,
        exploration: { ...targetConfig.exploration, max_actions: maxActions },
      },
      stories: storiesConfig,
      logger,
    });

    await engine.explore();

    // ── Generate Report ──
    console.log("\n📝 Generating report...");
    const reportPath = await generateReport(logger, sessionDir, activeProfile?.role);

    // Save logs
    logger.save();

    console.log(`\n════════════════════════════════════════════`);
    console.log(`  Session complete!`);
    console.log(`  Findings: ${logger.findings.length}`);
    console.log(`  Report:   ${reportPath}`);
    console.log(`  Logs:     ${sessionDir}`);
    console.log(`════════════════════════════════════════════\n`);

  } catch (error) {
    console.error("\n❌ Fatal error:", error.message);
    logger.logError(error);
    logger.save();
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
