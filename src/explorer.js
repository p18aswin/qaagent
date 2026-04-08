/**
 * Exploration Engine — The core AI loop.
 *
 * Loop: Extract DOM → Send to Claude → Execute action → Evaluate → Repeat
 *
 * Claude acts as the "brain" — it sees the page state, knows the context
 * (user stories, platform knowledge), and decides what to do next.
 */

const Anthropic = require("@anthropic-ai/sdk").default;
const { extractPageState, formatPageStateForLLM } = require("./dom-analyzer");

class ExplorationEngine {
  constructor({ page, config, stories, logger, abortCheck }) {
    this.page = page;
    this.config = config;
    this.stories = stories;
    this.logger = logger;
    this.abortCheck = abortCheck || (() => false);
    this.visitedUrls = new Set();
    this.actionCount = 0;
    this.maxActions = config.exploration?.max_actions || 50;

    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model || "claude-sonnet-4-20250514";

    // Build the system prompt with context
    this.systemPrompt = this._buildSystemPrompt();
    this.conversationHistory = [];

    // Stale-perception guard — counts perceptions since last navigation/click
    this._perceptionsSinceLastNav = 0;
    this._failRetryGiven = false;
  }

  _buildSystemPrompt() {
    let prompt = `You are QAAgent, an AI-powered exploratory testing agent. You are autonomously exploring a web application to find bugs, anomalies, and issues.

## Your Role
You navigate the application, interact with elements, and evaluate whether the application behaves correctly. You think like a senior QA engineer — testing happy paths, negative cases, edge cases, and boundary conditions.

## How You Work
At each step, you receive the current page state (DOM analysis) and you decide what action to take next. You MUST respond with a valid JSON object.

## Available Actions
- \`navigate\`: Go to a URL. Use: {"action": "navigate", "url": "...", "thought": "..."}
- \`click\`: Click an element. Use: {"action": "click", "selector": "...", "thought": "..."}
- \`fill\`: Type into an input. Use: {"action": "fill", "selector": "...", "value": "...", "thought": "..."}
- \`select\`: Choose from dropdown. Use: {"action": "select", "selector": "...", "value": "...", "thought": "..."}
- \`submit\`: Submit a form. Use: {"action": "submit", "selector": "...", "thought": "..."}
- \`verify_pass\`: Record a confirmed PASS for an acceptance criterion. Use ONLY when you have actually exercised the AC and it works. Use: {"action": "verify_pass", "result": {"description": "what was verified", "expected": "what should happen", "actual": "what you observed", "story_ref": "STORY-ID", "ac_ref": "AC1 / AC2 / etc", "confidence": 0-100}, "thought": "..."}
- \`report_fail\`: Record a confirmed FAIL — something is actually broken. Use: {"action": "report_fail", "result": {"description": "what is broken", "expected": "...", "actual": "...", "severity": "critical|high|medium|low", "story_ref": "STORY-ID or empty", "ac_ref": "AC ref or empty", "confidence": 0-100}, "thought": "..."}
- \`done\`: End exploration. Use: {"action": "done", "thought": "..."}

## CRITICAL Rules — Pass / Fail Discipline
1. Every test outcome is binary: **Pass** or **Fail**. There is no "warning". If you cannot confidently say something is broken, do NOT call \`report_fail\`.
2. Use \`verify_pass\` to record positive confirmations of acceptance criteria. This is how you tell the user "AC1 works." Do NOT smuggle passes into report_fail with low severity.
3. Use \`report_fail\` ONLY for genuine defects you have reproduced. Confidence must be >= 70.
4. If a perception looks "empty" or an element is missing right after a navigation/click, the page may still be loading. Do NOT call report_fail on the first observation — wait one more cycle and re-perceive. The system will allow you to retry.
5. Always include "thought" explaining your reasoning — this powers the observability log.
6. Test negative cases too: empty required fields, special characters, invalid inputs. Failed validation that the app catches correctly is a Pass for that AC, not a Fail.
7. Tie every Pass and Fail back to a story_ref and ac_ref when possible.
8. ALWAYS respond with ONLY a valid JSON object. No markdown, no code fences, no explanation text outside the JSON.
`;

    // Add story context if available
    if (this.stories?.stories?.length > 0) {
      prompt += `\n## Sprint Context (${this.stories.sprint || "Current Sprint"})\nThese are the user stories in the current sprint. Prioritize testing areas related to these changes:\n\n`;
      this.stories.stories.forEach((story) => {
        prompt += `### ${story.id}: ${story.title}\n`;
        prompt += `${story.description}\n`;
        if (story.acceptance_criteria?.length > 0) {
          prompt += `Acceptance Criteria:\n`;
          story.acceptance_criteria.forEach((ac) => (prompt += `- ${ac}\n`));
        }
        if (story.modules_affected?.length > 0) {
          prompt += `Affected modules: ${story.modules_affected.join(", ")}\n`;
        }
        prompt += "\n";
      });
    }

    // Add role context
    if (this.config.activeProfile) {
      prompt += `\n## Active Role Profile\nYou are testing as: ${this.config.activeProfile.role}\nExpected access: ${this.config.activeProfile.scope?.join(", ") || "all modules"}\nFlag any content or features that should NOT be visible to this role.\n`;
    }

    // Platform context (the "brain")
    if (this.config.platformContext?.blocks?.length > 0) {
      prompt += `\n## Platform Context\nThe following knowledge describes the application. Use it to decide what is relevant to test and what to skip.\n\n`;
      this.config.platformContext.blocks.forEach((b) => {
        prompt += `### ${b.title}\n${b.content}\n\n`;
      });
    }

    // Approved test plan — hard constraint
    if (this.config.plan) {
      const p = this.config.plan;
      prompt += `\n## Approved Test Plan (HARD CONSTRAINT)\nYou MUST stay within the scope of this user-approved plan. Do not test areas outside it.\n\nSummary: ${p.summary || ""}\n`;
      if (Array.isArray(p.areas_to_test)) {
        prompt += `\nAreas to test:\n`;
        p.areas_to_test.forEach((a) => {
          prompt += `- ${a.name} [${a.priority || "medium"}]: ${a.what || ""}\n`;
        });
      }
      if (Array.isArray(p.areas_to_skip)) {
        prompt += `\nAreas to SKIP (do not test):\n`;
        p.areas_to_skip.forEach((a) => {
          prompt += `- ${a.name}: ${a.reason || ""}\n`;
        });
      }
      if (p.estimated_actions) {
        prompt += `\nTarget action budget: ~${p.estimated_actions} actions. Call "done" once the planned areas are covered.\n`;
      }
    }

    return prompt;
  }

  /**
   * Main exploration loop.
   */
  async explore() {
    console.log("\n🔍 Starting exploration...\n");
    console.log(`Strategy: breadth-first | Max actions: ${this.maxActions}\n`);

    while (this.actionCount < this.maxActions && !this.abortCheck()) {
      try {
        // 1. Extract current page state
        const pageState = await extractPageState(this.page);
        this.logger.logPerception(pageState);
        this.visitedUrls.add(pageState.url);
        this._perceptionsSinceLastNav += 1;

        // 2. Format for LLM and get decision
        const pageDescription = formatPageStateForLLM(pageState);
        const passes = this.logger.findings.filter(f => f.result === "Pass").length;
        const fails = this.logger.findings.filter(f => f.result === "Fail").length;
        const explorationStatus = `\n## Exploration Status\nActions taken: ${this.actionCount}/${this.maxActions}\nPages visited: ${this.visitedUrls.size} (${[...this.visitedUrls].slice(-5).join(", ")})\nResults so far: ${passes} Pass | ${fails} Fail\n`;

        const userMessage = `${pageDescription}\n${explorationStatus}\n\nWhat should I do next? Respond with a JSON action object.`;

        // Add to conversation history
        this.conversationHistory.push({ role: "user", content: userMessage });

        // Keep conversation history manageable
        if (this.conversationHistory.length > 20) {
          this.conversationHistory = this.conversationHistory.slice(-16);
        }

        // Signal "thinking" state to UI
        if (this.logger.signalThinking) this.logger.signalThinking(true);
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 1024,
          system: this.systemPrompt,
          messages: this.conversationHistory,
        });
        if (this.logger.signalThinking) this.logger.signalThinking(false);

        const responseText = response.content[0]?.text || "";
        this.conversationHistory.push({ role: "assistant", content: responseText });

        // 3. Parse the action
        const action = this._parseAction(responseText);
        if (!action) {
          this.logger.logError({ message: "Failed to parse Claude response: " + responseText.slice(0, 200) });
          this.actionCount++;
          continue;
        }

        // Log reasoning
        this.logger.logReasoning({
          thought: action.thought || "No reasoning provided",
          plan: action.plan || "",
          next_action: action.action,
        });

        // 4. Execute the action
        if (action.action === "done") {
          console.log("\n✅ Agent decided to end exploration.\n");
          break;
        }

        // ── Pass/Fail recording ──
        if (action.action === "verify_pass" || action.action === "evaluate" && action.finding && (action.finding.severity === "low")) {
          // (legacy `evaluate` low-severity is treated as pass for backward compat)
          const r = action.result || action.finding || {};
          const screenshotPath = await this.logger.saveScreenshot(
            this.page,
            `pass_${this.logger.findings.length + 1}`
          );
          this.logger.logFinding({
            result: "Pass",
            description: r.description || "",
            expected: r.expected || "",
            actual: r.actual || "",
            severity: "",
            story_ref: r.story_ref || this._matchStory(r.description),
            ac_ref: r.ac_ref || "",
            confidence: r.confidence || 90,
            screenshot: screenshotPath,
            url: this.page.url(),
            step: this.actionCount,
          });
          this.actionCount++;
          continue;
        }

        if (action.action === "report_fail" || action.action === "evaluate") {
          const r = action.result || action.finding || {};

          // Stale-perception guard: if we just navigated/clicked and this is the
          // first perception since, force a settle + retry instead of logging the fail.
          if (this._perceptionsSinceLastNav < 2 && !this._failRetryGiven) {
            this._failRetryGiven = true;
            this.logger.logReasoning({
              thought: "[GUARD] Page may not have settled yet. Waiting 2.5s and re-perceiving before allowing this Fail to be recorded.",
              next_action: "wait_and_reperceive",
            });
            await this.page.waitForTimeout(2500);
            // Force a retry — pop the last assistant message so Claude reconsiders
            this.conversationHistory.push({
              role: "user",
              content: "WAIT — the page may not have fully loaded when you saw it. I've waited 2.5 seconds. Please re-examine the current state before deciding to report a fail. Only call report_fail if the issue is still present. Otherwise continue testing or call verify_pass.",
            });
            this.actionCount++;
            continue;
          }

          // Confidence floor — refuse low-confidence fails
          if ((r.confidence || 0) < 70) {
            this.logger.logReasoning({
              thought: `[GUARD] Refusing to record Fail with confidence ${r.confidence || 0}% (<70). Try to reproduce or escalate.`,
              next_action: "skip_low_confidence_fail",
            });
            this.actionCount++;
            continue;
          }

          this._failRetryGiven = false;
          const screenshotPath = await this.logger.saveScreenshot(
            this.page,
            `fail_${this.logger.findings.length + 1}`
          );
          this.logger.logFinding({
            result: "Fail",
            description: r.description || "",
            expected: r.expected || "",
            actual: r.actual || "",
            severity: r.severity || "medium",
            story_ref: r.story_ref || this._matchStory(r.description),
            ac_ref: r.ac_ref || "",
            confidence: r.confidence || 0,
            screenshot: screenshotPath,
            url: this.page.url(),
            step: this.actionCount,
          });
          this.actionCount++;
          continue;
        }

        await this._executeAction(action);
        // Reset perception counter on any navigating action
        if (["navigate", "click", "submit"].includes(action.action)) {
          this._perceptionsSinceLastNav = 0;
        }
        this.actionCount++;

        // Small delay to let page settle
        await this.page.waitForTimeout(1000);

      } catch (error) {
        this.logger.logError(error);
        this.actionCount++;
        // Try to recover by going back
        try { await this.page.goBack(); } catch (_) {}
        await this.page.waitForTimeout(1000);
      }
    }

    console.log(`\n📊 Exploration complete. ${this.actionCount} actions, ${this.logger.findings.length} findings.\n`);
    return this.logger.findings;
  }

  /**
   * Execute a single action on the page.
   */
  async _executeAction(action) {
    switch (action.action) {
      case "navigate":
        this.logger.logAction({ type: "navigate", target: action.url, selector: "", details: "" });
        await this.page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 15000 });
        await this.logger.saveScreenshot(this.page, "navigate");
        break;

      case "click":
        this.logger.logAction({ type: "click", target: action.selector, selector: action.selector });
        try {
          await this.page.locator(action.selector).first().click({ timeout: 5000 });
        } catch (e) {
          // Try text-based fallback
          if (action.text) {
            await this.page.getByText(action.text, { exact: false }).first().click({ timeout: 5000 });
          } else throw e;
        }
        await this.page.waitForTimeout(500);
        await this.logger.saveScreenshot(this.page, "click");
        break;

      case "fill":
        this.logger.logAction({ type: "fill", target: action.selector, selector: action.selector, details: `value="${action.value}"` });
        await this.page.locator(action.selector).first().fill(action.value, { timeout: 5000 });
        break;

      case "select":
        this.logger.logAction({ type: "select", target: action.selector, selector: action.selector, details: `value="${action.value}"` });
        await this.page.locator(action.selector).first().selectOption(action.value, { timeout: 5000 });
        break;

      case "submit":
        this.logger.logAction({ type: "submit", target: action.selector, selector: action.selector });
        await this.page.locator(action.selector).first().click({ timeout: 5000 });
        await this.page.waitForTimeout(2000);
        await this.logger.saveScreenshot(this.page, "submit");
        break;

      default:
        this.logger.logError({ message: `Unknown action: ${action.action}` });
    }
  }

  /**
   * Parse Claude's response into a structured action.
   */
  _parseAction(text) {
    try {
      // Try direct JSON parse first
      return JSON.parse(text.trim());
    } catch {
      // Try extracting JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch { return null; }
      }
      return null;
    }
  }

  /**
   * Try to match a finding description to a sprint story.
   */
  _matchStory(description) {
    if (!description || !this.stories?.stories) return null;
    const descLower = (description || "").toLowerCase();
    for (const story of this.stories.stories) {
      const modules = story.modules_affected || [];
      if (modules.some((m) => descLower.includes(m.toLowerCase()))) {
        return story.id;
      }
      if (descLower.includes(story.id.toLowerCase())) {
        return story.id;
      }
    }
    return null;
  }
}

module.exports = { ExplorationEngine };
