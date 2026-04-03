/**
 * Report Generator — Creates structured Excel reports from exploration findings.
 *
 * Output format matches what QA teams expect:
 * Test Case ID | Module | Description | Steps | Expected | Actual | Result | Severity | Screenshot | Story Ref | Confidence
 */

const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

async function generateReport(logger, sessionDir, profileRole) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "QAAgent";
  workbook.created = new Date();

  // ── Findings Sheet ──
  const findingsSheet = workbook.addWorksheet("Test Findings", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  findingsSheet.columns = [
    { header: "Test Case ID", key: "id", width: 14 },
    { header: "Module", key: "module", width: 16 },
    { header: "Test Case Description", key: "description", width: 40 },
    { header: "Steps to Reproduce", key: "steps", width: 35 },
    { header: "Expected Behavior", key: "expected", width: 30 },
    { header: "Actual Behavior / Observation", key: "actual", width: 30 },
    { header: "Result", key: "result", width: 10 },
    { header: "Severity", key: "severity", width: 12 },
    { header: "Screenshot", key: "screenshot", width: 20 },
    { header: "Jira Story Ref", key: "story_ref", width: 14 },
    { header: "Confidence", key: "confidence", width: 12 },
    { header: "Role Tested", key: "role", width: 14 },
    { header: "URL", key: "url", width: 35 },
  ];

  // Style header row
  const headerRow = findingsSheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11, name: "Arial" };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF065A82" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  headerRow.height = 30;

  // Add findings
  const findings = logger.findings;
  findings.forEach((finding, idx) => {
    const row = findingsSheet.addRow({
      id: `EXP-${String(idx + 1).padStart(3, "0")}`,
      module: _extractModule(finding.url || ""),
      description: finding.description || "",
      steps: _buildStepsFromLog(logger.entries, finding.step),
      expected: finding.expected || "",
      actual: finding.actual || "",
      result: finding.severity === "critical" || finding.severity === "high" ? "Fail" : "Warning",
      severity: (finding.severity || "medium").charAt(0).toUpperCase() + (finding.severity || "medium").slice(1),
      screenshot: finding.screenshot ? path.basename(finding.screenshot) : "",
      story_ref: finding.story_ref || "",
      confidence: finding.confidence ? `${finding.confidence}%` : "",
      role: profileRole || "",
      url: finding.url || "",
    });

    // Conditional formatting for severity
    const severityCell = row.getCell("severity");
    const severityColors = { Critical: "FFEF4444", High: "FFF59E0B", Medium: "FF3B82F6", Low: "FF10B981" };
    severityCell.fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: severityColors[severityCell.value] || "FFE2E8F0" },
    };
    severityCell.font = { color: { argb: "FFFFFFFF" }, bold: true, size: 10 };

    // Style data rows
    row.alignment = { vertical: "top", wrapText: true };
    row.font = { size: 10, name: "Arial" };
  });

  // Auto-filter
  findingsSheet.autoFilter = { from: "A1", to: `M${findings.length + 1}` };

  // ── Summary Sheet ──
  const summarySheet = workbook.addWorksheet("Exploration Summary");

  const summaryData = [
    ["QAAgent Exploration Report", ""],
    ["", ""],
    ["Session Details", ""],
    ["Date", new Date().toISOString().split("T")[0]],
    ["Role Tested", profileRole || "N/A"],
    ["Total Actions", logger.entries.filter((e) => e.type === "ACTION").length],
    ["Pages Visited", new Set(logger.entries.filter((e) => e.type === "PERCEPTION").map((e) => e.url)).size],
    ["Total Findings", findings.length],
    ["Duration", `${((logger.entries.slice(-1)[0]?.elapsed_ms || 0) / 1000).toFixed(0)}s`],
    ["", ""],
    ["Findings by Severity", ""],
    ["Critical", findings.filter((f) => f.severity === "critical").length],
    ["High", findings.filter((f) => f.severity === "high").length],
    ["Medium", findings.filter((f) => f.severity === "medium").length],
    ["Low", findings.filter((f) => f.severity === "low").length],
  ];

  summaryData.forEach((row, idx) => {
    const excelRow = summarySheet.addRow(row);
    if (idx === 0) {
      excelRow.font = { bold: true, size: 16, color: { argb: "FF065A82" } };
    } else if (idx === 2 || idx === 10) {
      excelRow.font = { bold: true, size: 12 };
    }
  });

  summarySheet.getColumn(1).width = 20;
  summarySheet.getColumn(2).width = 30;

  // ── Exploration Log Sheet ──
  const logSheet = workbook.addWorksheet("Exploration Log");
  logSheet.columns = [
    { header: "Timestamp", key: "timestamp", width: 22 },
    { header: "Elapsed", key: "elapsed", width: 10 },
    { header: "Type", key: "type", width: 12 },
    { header: "Details", key: "details", width: 80 },
  ];

  const logHeader = logSheet.getRow(1);
  logHeader.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10, name: "Arial" };
  logHeader.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };

  logger.entries.forEach((entry) => {
    let details = "";
    switch (entry.type) {
      case "ACTION":
        details = `${entry.action}: ${entry.target}${entry.details ? ` (${entry.details})` : ""}`;
        break;
      case "PERCEPTION":
        details = `${entry.url} | ${entry.elements_count} elements | ${entry.forms_count} forms${entry.errors_detected?.length > 0 ? ` | ERRORS: ${entry.errors_detected.join("; ")}` : ""}`;
        break;
      case "REASONING":
        details = entry.thought;
        break;
      case "FINDING":
        details = `[${entry.severity}] ${entry.description}`;
        break;
      case "ERROR":
        details = entry.message;
        break;
    }

    const row = logSheet.addRow({
      timestamp: entry.timestamp,
      elapsed: `${(entry.elapsed_ms / 1000).toFixed(1)}s`,
      type: entry.type,
      details: details,
    });
    row.font = { size: 9, name: "Consolas" };
    row.alignment = { wrapText: true };

    // Color-code by type
    const typeColors = {
      ACTION: "FFE8F4FD", PERCEPTION: "FFF0F4F8", REASONING: "FFFFF8E1",
      FINDING: "FFFDE8E8", ERROR: "FFFDE8E8",
    };
    row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: typeColors[entry.type] || "FFFFFFFF" } };
  });

  // Save
  const reportPath = path.join(sessionDir, `QAAgent_Report_${profileRole || "default"}.xlsx`);
  await workbook.xlsx.writeFile(reportPath);
  console.log(`\n📋 Report saved: ${reportPath}`);
  return reportPath;
}

function _extractModule(url) {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);
    return parts[0] || "root";
  } catch {
    return "unknown";
  }
}

function _buildStepsFromLog(entries, findingStep) {
  // Get the last few actions before this finding
  const actions = entries.filter((e) => e.type === "ACTION");
  const relevantActions = actions.slice(Math.max(0, findingStep - 5), findingStep + 1);
  return relevantActions
    .map((a, i) => `${i + 1}. ${a.action}: ${a.target}${a.details ? ` (${a.details})` : ""}`)
    .join("\n");
}

module.exports = { generateReport };
