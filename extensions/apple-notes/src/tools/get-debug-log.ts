import { existsSync, readFileSync, statSync } from "fs";

import { getPreferenceValues } from "@raycast/api";

import { getLogFilePath } from "../logger";

/**
 * AI Tool: Get the latest debug log entries
 *
 * Returns the last 100 lines of the debug log to help the AI
 * troubleshoot issues with note loading, caching, or image processing.
 */
export default async function GetDebugLog() {
  const preferences = getPreferenceValues<Preferences>();
  const logFilePath = getLogFilePath();

  // Check if logging is enabled
  if (!preferences.enableDebugLogging) {
    return JSON.stringify({
      status: "disabled",
      message:
        "Debug logging is currently disabled. To enable it:\n1. Open Raycast Settings\n2. Go to Extensions → Apple Notes → Preferences\n3. Check 'Enable debug logging'\n4. Use the extension and return here to view logs",
    });
  }

  // Check if log file exists
  if (!existsSync(logFilePath)) {
    return JSON.stringify({
      status: "empty",
      message: "No debug log found yet. The log will be created when you use the extension with debug logging enabled.",
      logPath: logFilePath,
    });
  }

  try {
    // Get file stats
    const stats = statSync(logFilePath);
    const fileSizeKB = (stats.size / 1024).toFixed(1);

    // Read the log file
    const content = readFileSync(logFilePath, "utf-8");

    if (content.trim().length === 0) {
      return JSON.stringify({
        status: "empty",
        message: "Debug log exists but is empty. Start using the extension to generate logs.",
        logPath: logFilePath,
        fileSize: `${fileSizeKB} KB`,
      });
    }

    // Get last 100 lines (should be enough for debugging recent issues)
    const lines = content.split("\n");
    const lastLines = lines.slice(-100);
    const logContent = lastLines.join("\n");

    return JSON.stringify({
      status: "success",
      message: `Found debug log with ${lines.length} total lines. Showing last 100 lines:`,
      logPath: logFilePath,
      fileSize: `${fileSizeKB} KB`,
      totalLines: lines.length,
      log: logContent,
    });
  } catch (error) {
    return JSON.stringify({
      status: "error",
      message: `Failed to read debug log: ${error instanceof Error ? error.message : String(error)}`,
      logPath: logFilePath,
    });
  }
}
