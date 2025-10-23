import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";

import { environment, getPreferenceValues } from "@raycast/api";

const logFile = join(environment.supportPath, "debug.log");
const MAX_LOG_SIZE_MB = 2;
const MAX_LOG_LINES = 1000;

// Initialize log file on first load if logging is enabled
let logInitialized = false;

function initLog() {
  if (logInitialized) return;

  try {
    const preferences = getPreferenceValues<Preferences>();
    if (preferences.enableDebugLogging) {
      mkdirSync(dirname(logFile), { recursive: true });

      // Check if log needs rotation (too large or too old)
      let shouldRotate = false;

      if (existsSync(logFile)) {
        const stats = statSync(logFile);
        const sizeInMB = stats.size / (1024 * 1024);
        const ageInHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

        // Rotate if >2MB or >24 hours old
        if (sizeInMB > MAX_LOG_SIZE_MB || ageInHours > 24) {
          shouldRotate = true;
        }
      }

      if (shouldRotate || !existsSync(logFile)) {
        // Start fresh log
        const header = `=== Apple Notes Debug Log ===\n${new Date().toISOString()}\nSession started\n\n`;
        writeFileSync(logFile, header);
      } else {
        // Append session separator to existing log
        const separator = `\n--- New Session: ${new Date().toISOString()} ---\n\n`;
        writeFileSync(logFile, separator, { flag: "a" });
      }
    }
    logInitialized = true;
  } catch (error) {
    console.error("Failed to initialize log file:", error);
  }
}

/**
 * Rotate log if it gets too large (keep last N lines)
 */
function rotateLogIfNeeded() {
  try {
    if (!existsSync(logFile)) return;

    const stats = statSync(logFile);
    const sizeInMB = stats.size / (1024 * 1024);

    // Only rotate if over limit
    if (sizeInMB <= MAX_LOG_SIZE_MB) return;

    // Read file and keep last N lines
    const content = readFileSync(logFile, "utf-8");
    const lines = content.split("\n");

    if (lines.length > MAX_LOG_LINES) {
      const keepLines = lines.slice(-MAX_LOG_LINES);
      const rotatedContent = `=== Log Rotated: ${new Date().toISOString()} ===\n(Kept last ${MAX_LOG_LINES} lines)\n\n${keepLines.join("\n")}`;
      writeFileSync(logFile, rotatedContent);
    }
  } catch (error) {
    // Use console.error to avoid recursion if debugLog fails
    console.error(`Failed to rotate log: ${error}`);
  }
}

/**
 * Log a message to the debug file if logging is enabled
 */
export function debugLog(message: string) {
  try {
    const preferences = getPreferenceValues<Preferences>();
    if (!preferences.enableDebugLogging) {
      return;
    }

    if (!logInitialized) {
      initLog();
    }

    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}\n`;

    writeFileSync(logFile, logMessage, { flag: "a" });

    if (Math.random() < 0.1) {
      rotateLogIfNeeded();
    }
  } catch (error) {
    // Use console.error to avoid recursion if debugLog fails
    console.error(`Failed to log message: ${error}`);
  }
}

/**
 * Get the log file path
 */
export function getLogFilePath(): string {
  return logFile;
}
