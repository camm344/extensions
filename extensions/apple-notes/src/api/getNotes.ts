import { homedir } from "os";
import { resolve } from "path";

import { executeSQL } from "@raycast/utils";

import { getOpenNoteURL } from "../helpers";
import { debugLog } from "../logger";

type Link = {
  id: string;
  text: string | null;
  url: string | null;
  notePk: number;
};

type Backlink = {
  id: string;
  title: string;
  url: string;
};

type Tag = {
  id: string;
  text: string | null;
  notePk: number;
};

type NoteItem = {
  id: string;
  pk: number;
  UUID: string;
  title: string;
  modifiedAt?: Date;
  folder: string;
  snippet: string;
  account: string;
  invitationLink: string | null;
  links: Link[];
  backlinks: Backlink[];
  tags: Tag[];
  locked: boolean;
  pinned: boolean;
  checklist: boolean;
  checklistInProgress: boolean;
};

const NOTES_DB = resolve(homedir(), "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite");

/**
 * Gets the approximate size of a note from the database
 * This helps us avoid trying to load huge notes into memory
 * @param noteId - The x-coredata:// URL of the note
 * @returns Size in bytes, or null if not found
 */
export async function getNoteSize(noteId: string): Promise<number | null> {
  try {
    // Extract the primary key from the note ID
    // Format: x-coredata://UUID/ICNote/pPK
    const pkMatch = noteId.match(/\/p(\d+)$/);
    if (!pkMatch) {
      return null;
    }
    const pk = parseInt(pkMatch[1], 10);

    // Query the note data size from the database
    // The ZNOTEDATA table contains the actual HTML content
    const query = `
      SELECT length(ZDATA) as size
      FROM ZICNOTEDATA
      WHERE ZNOTE = ${pk}
      LIMIT 1
    `;

    const result = await executeSQL<{ size: number }>(NOTES_DB, query);

    if (result && result.length > 0) {
      return result[0].size;
    }

    return null;
  } catch (error) {
    debugLog(`Failed to get note size: ${error}`);
    return null;
  }
}

/**
 * Gets note body with size check, trying direct database read first
 * @param noteId - The x-coredata:// URL of the note
 * @returns HTML content of the note, or throws if too large
 */
export async function getNoteBodyFromDatabase(noteId: string): Promise<string | null> {
  try {
    // Extract the primary key
    const pkMatch = noteId.match(/\/p(\d+)$/);
    if (!pkMatch) {
      return null;
    }
    const pk = parseInt(pkMatch[1], 10);

    // First check the compressed size in database
    const size = await getNoteSize(noteId);

    if (size === null) {
      // Fallback to AppleScript if we can't determine size
      const { getNoteBody } = await import("./applescript");
      return getNoteBody(noteId);
    }

    const sizeMB = size / (1024 * 1024);

    // With osascript subprocess, we can be more generous:
    // - osascript runs in separate process (separate memory space)
    // - We only load into Node after writing to file and checking size
    // - 10MB compressed ≈ 30-40MB uncompressed, but osascript handles it
    if (size > 10 * 1024 * 1024) {
      throw new Error(
        `This note is too large to display in Raycast (${sizeMB.toFixed(1)}MB compressed).\n\nPlease open it directly in the Apple Notes app instead.`,
      );
    }

    // Log size for debugging
    debugLog(`Loading note: ${sizeMB.toFixed(2)}MB compressed`);

    // Try to read from database directly as hex
    const query = `
      SELECT hex(ZDATA) as content
      FROM ZICNOTEDATA
      WHERE ZNOTE = ${pk}
      LIMIT 1
    `;

    const result = await executeSQL<{ content: string }>(NOTES_DB, query);

    if (result && result.length > 0 && result[0].content) {
      // Try to decode the hex string
      const { decodeNotesHexString } = await import("../helpers");
      const decoded = decodeNotesHexString(result[0].content);

      if (decoded && decoded.length > 0) {
        debugLog("Successfully decoded note from database!");
        return decoded;
      }

      // Decoding failed, fall back to AppleScript
      debugLog("Database decode failed, falling back to AppleScript");
    }

    // Fallback to AppleScript via osascript subprocess (doesn't load into Node memory!)
    debugLog("Using osascript subprocess to fetch note content");
    const { getNoteBodyToFileSync } = await import("./applescript");
    const tempFilePath = getNoteBodyToFileSync(noteId);

    // Read the file - now we know the size is OK
    const fs = await import("fs");
    const content = fs.readFileSync(tempFilePath, "utf-8");

    // Clean up temp file
    try {
      fs.unlinkSync(tempFilePath);
    } catch {
      // Ignore cleanup errors
    }

    return content;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    debugLog(`Failed to get note body: ${error}`);
    return null;
  }
}

/**
 * Gets note body and returns it as a file path for streaming processing
 * This avoids loading large content into Node.js memory
 * Uses hash-based caching to skip AppleScript export if content unchanged
 */
export async function getNoteBodyAsFile(
  noteId: string,
): Promise<{ path: string; hash: string | null; isCached: boolean } | null> {
  try {
    const pkMatch = noteId.match(/\/p(\d+)$/);
    if (!pkMatch) {
      return null;
    }
    const size = await getNoteSize(noteId);

    if (size === null) {
      // Check hash-based cache first
      const cacheResult = await checkHashCache(noteId);
      if (cacheResult) {
        debugLog(`Loading note from cache`);
        return { path: cacheResult.path, hash: cacheResult.hash, isCached: true };
      }

      // Use osascript to write to file
      debugLog(`Exporting note content...`);
      const { getNoteBodyToFileSync, getNoteBodyHashSync } = await import("./applescript");
      const hash = getNoteBodyHashSync(noteId);
      const path = getNoteBodyToFileSync(noteId);
      return { path, hash, isCached: false };
    }

    const sizeMB = size / (1024 * 1024);

    // With streaming processing, allow up to 50MB compressed
    if (size > 50 * 1024 * 1024) {
      throw new Error(
        `This note is too large to display in Raycast (${sizeMB.toFixed(1)}MB compressed).\n\nPlease open it directly in the Apple Notes app instead.`,
      );
    }

    debugLog(`Loading note as file: ${sizeMB.toFixed(2)}MB compressed`);

    // Check hash-based cache first (much faster!)
    const cacheResult = await checkHashCache(noteId);
    if (cacheResult) {
      return { path: cacheResult.path, hash: cacheResult.hash, isCached: true };
    }

    // Cache miss - do full export
    const { getNoteBodyToFileSync, getNoteBodyHashSync } = await import("./applescript");
    const hash = getNoteBodyHashSync(noteId);
    const path = getNoteBodyToFileSync(noteId);
    return { path, hash, isCached: false };
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    debugLog(`Failed to get note body as file: ${error}`);
    return null;
  }
}

/**
 * Checks if we have a cached processed HTML file for this note based on content hash
 * Returns cached file path and hash if valid, null otherwise
 */
async function checkHashCache(noteId: string): Promise<{ path: string; hash: string } | null> {
  try {
    const { getNoteBodyHashSync } = await import("./applescript");
    const { environment } = await import("@raycast/api");
    const { join } = await import("path");
    const { existsSync, statSync, mkdirSync, utimesSync } = await import("fs");

    debugLog("Getting note content hash...");
    const startHash = Date.now();
    const contentHash = getNoteBodyHashSync(noteId);
    debugLog(`Hash computed in ${Date.now() - startHash}ms: ${contentHash?.substring(0, 8)}...`);

    if (!contentHash) {
      return null;
    }

    // Check if cached processed HTML exists
    const cacheDir = join(environment.supportPath, "note-cache");
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    const cachedHtmlPath = join(cacheDir, `${contentHash}.html`);

    if (existsSync(cachedHtmlPath)) {
      const stats = statSync(cachedHtmlPath);
      debugLog(`✅ Cache HIT! Using cached file (${(stats.size / 1024).toFixed(1)}KB)`);

      // Touch file to update mtime for LRU (true Least Recently Used)
      const now = new Date();
      try {
        utimesSync(cachedHtmlPath, now, now);
      } catch {
        // Ignore touch errors
      }

      return { path: cachedHtmlPath, hash: contentHash };
    }

    debugLog("Cache MISS - will export and process");
    return null;
  } catch (error) {
    debugLog(`Hash cache check failed: ${error}`);
    return null;
  }
}

export async function getNotes(maxQueryResults: number, filterByTags: string[] = []) {
  const query = `
    SELECT
        'x-coredata://' || zmd.z_uuid || '/ICNote/p' || note.z_pk AS id,
        note.z_pk AS pk,
        note.ztitle1 AS title,
        folder.ztitle2 AS folder,
        datetime(note.zmodificationdate1 + 978307200, 'unixepoch') AS modifiedAt,
        note.zsnippet AS snippet,
        acc.zname AS account,
        note.zidentifier AS UUID,
        (note.zispasswordprotected = 1) as locked,
        (note.zispinned = 1) as pinned,
        (note.zhaschecklist = 1) as checklist,
        (note.zhaschecklistinprogress = 1) as checklistInProgress
    FROM 
        ziccloudsyncingobject AS note
    INNER JOIN ziccloudsyncingobject AS folder 
        ON note.zfolder = folder.z_pk
    LEFT JOIN ziccloudsyncingobject AS acc 
        ON note.zaccount4 = acc.z_pk
    LEFT JOIN z_metadata AS zmd ON 1=1
    WHERE
        note.ztitle1 IS NOT NULL AND
        note.zmodificationdate1 IS NOT NULL AND
        note.z_pk IS NOT NULL AND
        note.zmarkedfordeletion != 1 AND
        folder.zmarkedfordeletion != 1
    ORDER BY
        note.zmodificationdate1 DESC
    LIMIT ${maxQueryResults}
  `;

  const data = await executeSQL<NoteItem>(NOTES_DB, query);

  if (!data || data.length === 0) {
    return { pinnedNotes: [], unpinnedNotes: [], deletedNotes: [], allNotes: [] };
  }

  let invitations: { invitationLink: string | null; noteId: string }[] = [];
  try {
    invitations = await executeSQL(
      NOTES_DB,
      `
      SELECT
          inv.zshareurl AS invitationLink,
          'x-coredata://' || zmd.z_uuid || '/ICNote/p' || note.z_pk AS noteId
      FROM
          ziccloudsyncingobject AS note
      LEFT JOIN zicinvitation AS inv 
          ON note.zinvitation = inv.z_pk
      LEFT JOIN z_metadata AS zmd ON 1=1
      WHERE
          note.zmarkedfordeletion != 1
    `,
    );
  } catch {
    // Silently fail if the table doesn't exist
  }

  const links = await executeSQL<Link>(
    NOTES_DB,
    `
    SELECT
      note.z_pk AS notePk,
      link.zidentifier AS id,
      link.ZALTTEXT as text,
      link.ZTOKENCONTENTIDENTIFIER as url
    FROM
      ziccloudsyncingobject AS note
    JOIN ziccloudsyncingobject AS link ON note.z_pk = link.ZNOTE1
    WHERE
      link.ZTYPEUTI1 = 'com.apple.notes.inlinetextattachment.link'
  `,
  );

  // Get tags
  const tags = await executeSQL<Tag>(
    NOTES_DB,
    `
    SELECT
      note.z_pk AS notePk,
      link.zidentifier AS id,
      link.ZALTTEXT as text
    FROM
      ziccloudsyncingobject AS note
    JOIN ziccloudsyncingobject AS link ON note.z_pk = link.ZNOTE1
    WHERE
      link.ZTYPEUTI1 = 'com.apple.notes.inlinetextattachment.hashtag'
  `,
  );

  const alreadyFound: { [key: string]: boolean } = {};
  const notes = data
    .filter((x) => {
      const found = alreadyFound[x.id];
      if (!found) alreadyFound[x.id] = true;
      return !found;
    })
    .sort((a, b) => (a.modifiedAt && b.modifiedAt && a.modifiedAt < b.modifiedAt ? 1 : -1));

  let notesWithAdditionalFields = notes.map((note) => {
    const noteInvitation = invitations?.find((inv) => inv.noteId === note.id);
    const noteLinks = links?.filter((link) => link.notePk == note.pk);

    const noteBacklinks: Backlink[] = [];
    links?.forEach((link) => {
      if (link.url?.includes(note.UUID.toLowerCase())) {
        const originalNote = notes.find((n) => n.pk === link.notePk);
        if (!originalNote) return;

        noteBacklinks.push({
          id: link.id,
          title: originalNote.title,
          url: getOpenNoteURL(originalNote.UUID),
        });
      }
    });

    const noteTags = tags?.filter((tag) => tag.notePk == note.pk);

    return {
      ...note,
      url: getOpenNoteURL(note.UUID),
      invitationLink: noteInvitation?.invitationLink ?? null,
      links: noteLinks ?? [],
      backlinks: noteBacklinks ?? [],
      tags: noteTags ?? [],
    };
  });

  if (filterByTags.length) {
    notesWithAdditionalFields = notesWithAdditionalFields.filter((note) => {
      const noteTags = note.tags.map((t) => t.text);
      return filterByTags.every((tag) => noteTags.includes(`#${tag.replace("#", "")}`));
    });
  }

  return notesWithAdditionalFields;
}
