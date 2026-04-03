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
  constructor({ page, config, stories, logger }) {
    this.page = page;
    this.config = config;
    this.stories = stories;
    this.logger = logger;
    this.visitedUrls = new Set();
    this.actionCount = 0;
    this.maxActions = config.exploration?.max_actions || 50;

    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model || "claude-sonnet-4-20250514";

    // Build the system prompt with context
    this.systemPrompt = this._buildSystemPrompt();
    this.conversationHistory = [];
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
- \`evaluate\`: Report a finding. Use: {"action": "evaluate", "finding": {"description": "...", "severity": "critical|high|medium|low", "expected": "...", "actual": "...", "confidence": 0-100}, "thought": "..."}
- \`done\`: End exploration. Use: {"action": "done", "thought": "..."}

## Rules
1. Always include a "thought" field explaining your reasoning — this powers the observability log.
2. When you see something unexpected (errors, missing content, broken flows), use "evaluate" to report it.
3. Test negative cases: try empty required fields, special characters, invalid inputs.
4. After submitting forms, check if validation works and if the response is correct.
5. Explore breadth-first: visit different sections before going deep into one.
6. Track what you have already tested and move to untested areas.
7. ALWAYS respond with ONLY a valid JSON object. No markdown, no code fences, no explanation text outside the JSON.
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

    return prompt;
  }

  /**
   * Main exploration loop.
   */
  async explore() {
    console.log("\n🔍 Starting exploration...\n");
    console.log(`Strategy: breadth-first | Max actions: ${this.maxActions}\n`);

    while (this.actionCount < this.maxActions) {
      try {
        // 1. Extract current page state
        const pageState = await extractPageState(this.page);
        this.logger.logPerception(pageState);
        this.visitedUrls.add(pageState.url);

        // 2. Format for LLM and get decision
        const pageDescription = formatPageStateForLLM(pageState);
        const explorationStatus = `\n## Exploration Status\nActions taken: ${this.actionCount}/${this.maxActions}\nPages visited: ${this.visitedUrls.size} (${[...this.visitedUrls].slice(-5).join(", ")})\nFindings so far: ${this.logger.findings.length}\n`;

        const userMessage = `${pageDescription}\n${explorationStatus}\n\nWhat should I do next? Respond with a JSON action object.`;

        // Add to conversation history
        this.conversationHistory.push({ role: "user", content: userMessage });

        // Keep conversation history manageable (last 10 exchanges)
        if (this.conversationHistory.length > 20) {
          this.conversationHistory = this.conversationHistory.slice(-16);
        }

        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 1024,
          system: this.systemPrompt,
          messages: this.conversationHistory,
        });

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

        if (action.action === "evaluate") {
          // Take screenshot of the finding
          const screenshotPath = await this.logger.saveScreenshot(
            this.page,
            `finding_${this.logger.findings.length + 1}`
          );
          this.logger.logFinding({
            ...action.finding,
            screenshot: screenshotPath,
            url: this.page.url(),
            step: this.actionCount,
            story_ref: this._matchStory(action.finding?.description),
          });
          this.actionCount++;
          continue;
        }

        await this._executeAction(action);
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
