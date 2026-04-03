/**
 * Observability Logger — Captures action, perception, and reasoning logs.
 *
 * Every step in the exploration loop is logged with full context,
 * creating the data needed for the observability timeline.
 */

const fs = require("fs");
const path = require("path");

class ExplorationLogger {
  constructor(sessionDir) {
    this.sessionDir = sessionDir;
    this.screenshotDir = path.join(sessionDir, "screenshots");
    this.entries = [];
    this.findings = [];
    this.startTime = Date.now();

    fs.mkdirSync(this.screenshotDir, { recursive: true });
  }

  logAction(action) {
    const entry = {
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startTime,
      type: "ACTION",
      action: action.type,       // navigate, click, fill, submit, etc.
      target: action.target,     // element description
      selector: action.selector, // CSS selector used
      details: action.details || "",
    };
    this.entries.push(entry);
    this._print(`ACTION  ${action.type} → ${action.target}`);
    return entry;
  }

  logPerception(pageState) {
    const entry = {
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startTime,
      type: "PERCEPTION",
      url: pageState.url,
      title: pageState.title,
      elements_count: pageState.elements.length,
      forms_count: pageState.forms.length,
      errors_detected: pageState.errors,
      headings: pageState.textLandmarks,
    };
    this.entries.push(entry);
    this._print(`PERCEPT ${pageState.url} | ${pageState.elements.length} elements | ${pageState.forms.length} forms${pageState.errors.length > 0 ? ` | ${pageState.errors.length} ERRORS` : ""}`);
    return entry;
  }

  logReasoning(reasoning) {
    const entry = {
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startTime,
      type: "REASONING",
      thought: reasoning.thought,
      plan: reasoning.plan,
      next_action: reasoning.next_action,
    };
    this.entries.push(entry);
    this._print(`REASON  ${reasoning.thought.slice(0, 120)}`);
    return entry;
  }

  logFinding(finding) {
    const entry = {
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startTime,
      type: "FINDING",
      ...finding,
    };
    this.entries.push(entry);
    this.findings.push(entry);
    this._print(`⚠️  FINDING [${finding.severity}] ${finding.description.slice(0, 100)}`);
    return entry;
  }

  logError(error) {
    const entry = {
      timestamp: new Date().toISOString(),
      elapsed_ms: Date.now() - this.startTime,
      type: "ERROR",
      message: error.message || String(error),
    };
    this.entries.push(entry);
    this._print(`ERROR   ${error.message || error}`);
    return entry;
  }

  async saveScreenshot(page, label) {
    const filename = `${String(this.entries.length).padStart(4, "0")}_${label.replace(/[^a-zA-Z0-9]/g, "_")}.png`;
    const filepath = path.join(this.screenshotDir, filename);
    try {
      await page.screenshot({ path: filepath, fullPage: false });
      this._print(`SCREEN  ${filename}`);
      return filepath;
    } catch (e) {
      this._print(`SCREEN  FAILED: ${e.message}`);
      return null;
    }
  }

  save() {
    const logPath = path.join(this.sessionDir, "exploration_log.json");
    const findingsPath = path.join(this.sessionDir, "findings.json");
    fs.writeFileSync(logPath, JSON.stringify(this.entries, null, 2));
    fs.writeFileSync(findingsPath, JSON.stringify(this.findings, null, 2));
    this._print(`\nLogs saved to ${this.sessionDir}`);
    this._print(`Total entries: ${this.entries.length}`);
    this._print(`Findings: ${this.findings.length}`);
  }

  _print(msg) {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    console.log(`[${elapsed}s] ${msg}`);
  }
}

module.exports = { ExplorationLogger };
