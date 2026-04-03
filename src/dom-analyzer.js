/**
 * DOM Analyzer — Extracts a structured, LLM-friendly representation of a web page.
 *
 * Instead of sending raw HTML (too large, too noisy), we extract only what matters:
 * interactive elements, their states, visible text landmarks, and page structure.
 */

async function extractPageState(page) {
  return await page.evaluate(() => {
    const state = {
      url: window.location.href,
      title: document.title,
      elements: [],
      forms: [],
      navigation: [],
      errors: [],
      textLandmarks: [],
    };

    // ── Interactive elements ──
    const interactiveSelectors = [
      "a[href]", "button", "input", "select", "textarea",
      "[role='button']", "[role='link']", "[role='tab']",
      "[role='menuitem']", "[onclick]", "[tabindex]"
    ];

    const seen = new Set();
    document.querySelectorAll(interactiveSelectors.join(", ")).forEach((el, idx) => {
      if (idx > 100) return; // Cap to avoid overwhelming the LLM
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return; // Hidden

      const id = el.id || el.getAttribute("data-testid") || el.getAttribute("name") || "";
      const text = (el.textContent || "").trim().slice(0, 100);
      const key = `${el.tagName}-${id}-${text}`;
      if (seen.has(key)) return;
      seen.add(key);

      state.elements.push({
        index: state.elements.length,
        tag: el.tagName.toLowerCase(),
        type: el.type || el.getAttribute("role") || "",
        id: id,
        text: text,
        placeholder: el.placeholder || "",
        value: el.value || "",
        disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
        required: el.required || el.getAttribute("aria-required") === "true",
        visible: rect.width > 0 && rect.height > 0,
        ariaLabel: el.getAttribute("aria-label") || "",
        href: el.href || "",
        selector: buildSelector(el),
      });
    });

    // ── Forms ──
    document.querySelectorAll("form").forEach((form) => {
      const fields = [];
      form.querySelectorAll("input, select, textarea").forEach((field) => {
        fields.push({
          tag: field.tagName.toLowerCase(),
          type: field.type || "",
          name: field.name || field.id || "",
          required: field.required,
          value: field.value || "",
          placeholder: field.placeholder || "",
        });
      });
      state.forms.push({
        id: form.id || form.action || "",
        method: form.method || "get",
        fields: fields,
      });
    });

    // ── Navigation links ──
    document.querySelectorAll("nav a, [role='navigation'] a, .sidebar a, .menu a, header a").forEach((a) => {
      const text = (a.textContent || "").trim().slice(0, 60);
      if (text && a.href) {
        state.navigation.push({ text, href: a.href, active: a.classList.contains("active") || a.getAttribute("aria-current") === "page" });
      }
    });

    // ── Error indicators ──
    document.querySelectorAll("[class*='error'], [class*='alert'], [role='alert'], .toast, .notification").forEach((el) => {
      const text = (el.textContent || "").trim().slice(0, 200);
      if (text) state.errors.push(text);
    });

    // ── Key text landmarks (headings, prominent text) ──
    document.querySelectorAll("h1, h2, h3, [role='heading']").forEach((el) => {
      const text = (el.textContent || "").trim().slice(0, 100);
      if (text) state.textLandmarks.push(text);
    });

    function buildSelector(el) {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
      if (el.getAttribute("aria-label")) return `[aria-label="${el.getAttribute("aria-label")}"]`;
      // Fallback: tag + text content
      const text = (el.textContent || "").trim().slice(0, 30);
      if (text) return `${el.tagName.toLowerCase()}:has-text("${text}")`;
      return `${el.tagName.toLowerCase()}:nth-of-type(${Array.from(el.parentNode?.children || []).indexOf(el) + 1})`;
    }

    return state;
  });
}

/**
 * Format page state as a concise string for the LLM prompt.
 */
function formatPageStateForLLM(pageState) {
  let output = `## Current Page\n`;
  output += `URL: ${pageState.url}\n`;
  output += `Title: ${pageState.title}\n\n`;

  if (pageState.textLandmarks.length > 0) {
    output += `## Headings\n${pageState.textLandmarks.map(t => `- ${t}`).join("\n")}\n\n`;
  }

  if (pageState.errors.length > 0) {
    output += `## Visible Errors/Alerts\n${pageState.errors.map(e => `- ${e}`).join("\n")}\n\n`;
  }

  if (pageState.navigation.length > 0) {
    output += `## Navigation Links\n`;
    pageState.navigation.slice(0, 20).forEach(n => {
      output += `- ${n.text}${n.active ? " (ACTIVE)" : ""} → ${n.href}\n`;
    });
    output += "\n";
  }

  if (pageState.forms.length > 0) {
    output += `## Forms\n`;
    pageState.forms.forEach((form, i) => {
      output += `Form ${i}: ${form.id || "(unnamed)"} [${form.method}]\n`;
      form.fields.forEach(f => {
        output += `  - ${f.name || f.type}: ${f.tag}[${f.type}]${f.required ? " (REQUIRED)" : ""}${f.value ? ` = "${f.value}"` : ""}${f.placeholder ? ` placeholder="${f.placeholder}"` : ""}\n`;
      });
    });
    output += "\n";
  }

  output += `## Interactive Elements (${pageState.elements.length} found)\n`;
  pageState.elements.slice(0, 50).forEach(el => {
    let desc = `[${el.index}] <${el.tag}`;
    if (el.type) desc += ` type="${el.type}"`;
    desc += `>`;
    if (el.text) desc += ` "${el.text}"`;
    if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
    if (el.disabled) desc += ` [DISABLED]`;
    if (el.required) desc += ` [REQUIRED]`;
    if (el.ariaLabel) desc += ` aria-label="${el.ariaLabel}"`;
    desc += ` → selector: ${el.selector}`;
    output += desc + "\n";
  });

  return output;
}

module.exports = { extractPageState, formatPageStateForLLM };
