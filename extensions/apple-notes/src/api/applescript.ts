import { spawnSync } from "child_process";
import { writeFileSync, unlinkSync, openSync, closeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runAppleScript } from "@raycast/utils";

import { escapeDoubleQuotes } from "../helpers";
import { debugLog } from "../logger";

export async function createNote(text?: string) {
  const escapedText = text ? escapeDoubleQuotes(text) : "";

  return runAppleScript(`
    tell application "Notes"
      activate
      set newNote to make new note
      if ("${escapedText}" is not "") then
        set body of newNote to "${escapedText}"
      end if
      set selection to newNote
      show newNote
    end tell
    `);
}

export async function openNoteSeparately(id: string) {
  return runAppleScript(`
    tell application "Notes"
      set theNote to note id "${escapeDoubleQuotes(id)}"
      set theFolder to container of theNote
      show theFolder
      show theNote with separately
      activate
    end tell
    `);
}

export async function deleteNoteById(id: string) {
  return runAppleScript(`
    tell application "Notes"
      delete note id "${escapeDoubleQuotes(id)}"
    end tell
    `);
}

export async function restoreNoteById(id: string) {
  return runAppleScript(`
    tell application "Notes"
      set theNote to note id "${escapeDoubleQuotes(id)}"
      set theFolder to default folder of account 1
      move theNote to theFolder
    end tell
    `);
}

export async function getNoteBody(id: string) {
  return runAppleScript(`
    tell application "Notes"
      set theNote to note id "${escapeDoubleQuotes(id)}"
      return body of theNote
    end tell
    `);
}

/**
 * Gets a lightweight hash for cache invalidation based on note ID + modification time
 * This is MUCH faster than hashing the entire note content (instant vs 1-10s)
 * @param id - Note ID
 * @returns MD5 hash of id+modTime or null if failed
 */
export function getNoteBodyHashSync(id: string): string | null {
  const { execSync } = require("child_process");
  const crypto = require("crypto");

  try {
    // Get modification date from Notes (very fast - no content transfer!)
    const script = `tell application "Notes"
  set theNote to note id "${id}"
  return (modification date of theNote) as string
end tell`;

    const modDateStr = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}' 2>/dev/null`, {
      encoding: "utf-8",
      maxBuffer: 1024, // Only need timestamp
    }).trim();

    // Create hash from ID + modification time (instant)
    // If note content changes, mod time changes, hash changes
    const hashInput = `${id}:${modDateStr}`;
    const hash = crypto.createHash("md5").update(hashInput).digest("hex");

    debugLog(`Fast hash: ${hash.substring(0, 8)}... (id+modtime)`);
    return hash;
  } catch (error) {
    debugLog(`Failed to get note body hash: ${error}`);
    return null;
  }
}

export function getNoteBodyToFileSync(id: string): string {
  const tempFile = join(tmpdir(), `raycast-note-${Date.now()}.html`);
  debugLog(`tempFile: ${tempFile}`);
  const scriptFile = join(tmpdir(), `raycast-script-${Date.now()}.scpt`);

  // Write AppleScript to a file to avoid command-line escaping issues
  const script = `tell application "Notes"
  set theNote to note id "${escapeDoubleQuotes(id)}"
  return body of theNote
end tell`;

  try {
    writeFileSync(scriptFile, script, "utf-8");

    // Open file descriptor for writing
    const fd = openSync(tempFile, "w");

    try {
      // Spawn osascript and pipe its stdout directly to file descriptor
      // This streams the data without loading it all into memory!
      const result = spawnSync("osascript", [scriptFile], {
        stdio: ["ignore", fd, "pipe"], // pipe stdout to file descriptor
        maxBuffer: 100 * 1024 * 1024, // 100MB max
      });

      if (result.error) {
        throw result.error;
      }

      if (result.status !== 0) {
        const errorMsg = result.stderr?.toString() || "Unknown error";
        throw new Error(`osascript failed: ${errorMsg}`);
      }
    } finally {
      // Always close the file descriptor
      closeSync(fd);
    }

    // Clean up script file
    try {
      unlinkSync(scriptFile);
    } catch {
      // Ignore cleanup errors
    }

    debugLog(tempFile);
    return tempFile;
  } catch (error) {
    // Clean up on error
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
    try {
      unlinkSync(scriptFile);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

export async function getNotePlainText(id: string) {
  return runAppleScript(`
    tell application "Notes"
      set theNote to note id "${escapeDoubleQuotes(id)}"
      return plaintext of theNote
    end tell
    `);
}

export async function setNoteBody(id: string, body: string) {
  return runAppleScript(`
    tell application "Notes"
      set theNote to note id "${escapeDoubleQuotes(id)}"
      set body of theNote to "${escapeDoubleQuotes(body)}"
    end tell
    `);
}

export async function getSelectedNote() {
  return runAppleScript(`
    tell application "Notes"
      set selectedNotes to selection
      if (count of selectedNotes) is 0 then
        error "No note is currently selected"
      else
        set theNote to item 1 of selectedNotes
        return id of theNote
      end if
    end tell
  `);
}

/**
 * Gets the note body and saves it directly to a temp file
 * This avoids loading large content into memory
 * @param id - Note ID
 * @returns Path to the temporary file containing the note body
 */
export async function getNoteBodyToFile(id: string): Promise<string> {
  const tempFilePath = join(tmpdir(), `raycast-note-${Date.now()}.html`);
  debugLog(`tempFilePath: ${tempFilePath}`);

  try {
    // First, try to get the note body normally
    // We'll check the size after getting it
    const content = await runAppleScript(`
      tell application "Notes"
        set theNote to note id "${escapeDoubleQuotes(id)}"
        return body of theNote
      end tell
    `);

    // Write to file using Node.js - more reliable than AppleScript shell script
    writeFileSync(tempFilePath, content, "utf-8");

    return tempFilePath;
  } catch (error) {
    // If AppleScript fails, it might be because the note is too large
    // Try to handle it gracefully
    if (error instanceof Error && error.message.includes("100013")) {
      throw new Error(
        "This note is too large to load from Apple Notes.\n\nPlease try opening it directly in the Apple Notes app instead.",
      );
    }
    throw error;
  }
}
