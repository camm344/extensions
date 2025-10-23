import { Detail, open } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import { formatDistanceToNow } from "date-fns";

import { getNoteBodyAsFile } from "../api/getNotes";
import { truncate, convertHtmlFileToMarkdownSafely } from "../helpers";
import { NoteItem, useNotes } from "../hooks/useNotes";
import { debugLog } from "../logger";

import NoteActions from "./NoteActions";

type NoteDetailProps = {
  note: NoteItem;
  isDeleted?: boolean;
  mutate: ReturnType<typeof useNotes>["mutate"];
};

export default function NoteDetail({ note, isDeleted, mutate }: NoteDetailProps) {
  const { data, isLoading, error } = useCachedPromise(
    async (id) => {
      debugLog(`Loading note body: ${new Date().toISOString()}`);
      // Get note body as file path (streaming, no memory loading)
      const result = await getNoteBodyAsFile(id);

      if (!result) {
        throw new Error("Could not load note content. It may be encrypted or corrupted.");
      }

      const { path: filePath, hash, isCached } = result;

      try {
        let markdown: string;

        if (isCached) {
          // Cached file - could be processed HTML (large files) or original HTML (small files)
          const fs = await import("fs");
          const cachedHtml = fs.readFileSync(filePath, "utf-8");

          // Detect if it's a large file cache by checking for .webp filenames
          // Large file caches have just filenames (hash-img1.webp)
          // Small file caches have original HTML with base64 data:image or no images
          const hasFileUrls = cachedHtml.match(/<img[^>]*src=["']([a-f0-9]+-img\d+\.webp)["']/i);

          if (hasFileUrls) {
            // Large file cache - has filenames, reconstruct full paths
            debugLog("Large file cache detected - reconstructing image paths");
            const { join } = await import("path");
            const { environment } = await import("@raycast/api");
            const imageCacheDir = join(environment.supportPath, "image-cache");

            // Convert filenames to full paths with URL encoding
            const processedHtml = cachedHtml.replace(
              /<img[^>]*src=["']([a-f0-9]+-img\d+\.webp)["'][^>]*>/gi,
              (match, filename) => {
                // Reconstruct full path and URL encode
                const fullPath = join(imageCacheDir, filename);
                const encodedPath = `${encodeURI(fullPath)}?raycast-width=450`;
                return `<img src="${encodedPath}" />`;
              },
            );

            // Now convert to markdown with NodeHtmlMarkdown
            const { NodeHtmlMarkdown } = await import("node-html-markdown");
            const nodeToMarkdown = new NodeHtmlMarkdown({
              keepDataImages: true, // Keep image src attributes
              maxConsecutiveNewlines: 3,
            });
            markdown = nodeToMarkdown.translate(processedHtml);
            markdown += `\n\n---\n\n> Note: Images are scaled for performance. Open in Notes for full quality.`;
          } else {
            // Small file cache - original HTML, use full conversion
            debugLog("Small note (0.00MB), extracting images to files");
            const { convertHtmlToMarkdownSafely } = await import("../helpers");
            markdown = await convertHtmlToMarkdownSafely(cachedHtml);
          }
        } else {
          // Not cached - do full processing
          markdown = await convertHtmlFileToMarkdownSafely(filePath, hash || undefined);
        }

        // Clean up temp file (only if not cached - cached files are persistent)
        if (!isCached) {
          const fs = await import("fs");
          try {
            fs.unlinkSync(filePath);
          } catch {
            // Ignore cleanup errors
          }
        }

        return markdown;
      } catch (error) {
        // Clean up temp file on error (only if not cached)
        if (!isCached) {
          const fs = await import("fs");
          try {
            fs.unlinkSync(filePath);
          } catch {
            // Ignore cleanup errors
          }
        }
        throw error;
      }
    },
    [note.id],
  );

  if (error) {
    return (
      <Detail
        markdown={`# Error Loading Note\n\n${error.message}\n\n**Tip:** Notes with large images may exceed memory limits. Try opening the note directly in the Apple Notes app.`}
        actions={<NoteActions note={note} isDeleted={isDeleted} mutate={mutate} isDetail />}
      />
    );
  }

  return (
    <Detail
      markdown={data}
      metadata={
        <Detail.Metadata>
          {note.account ? <Detail.Metadata.Label title="Account" text={note.account} /> : null}
          {note.folder ? <Detail.Metadata.Label title="Folder" text={note.folder} /> : null}
          {note.modifiedAt ? (
            <Detail.Metadata.Label title="Last Update" text={formatDistanceToNow(note.modifiedAt)} />
          ) : null}
          {note.locked ? <Detail.Metadata.Label title="Locked" text="Password-protected note" /> : null}
          {note.checklist ? (
            <Detail.Metadata.Label title="Checklist" text={note.checklistInProgress ? "In Progress" : "Completed"} />
          ) : null}
          {note.tags.length > 0 ? (
            <Detail.Metadata.TagList title="Tags">
              {note.tags.map((tag) => {
                if (!tag.text) return null;
                return <Detail.Metadata.TagList.Item key={tag.id} text={tag.text} />;
              })}
            </Detail.Metadata.TagList>
          ) : null}
          {note.links.length > 0 ? (
            <Detail.Metadata.TagList title="Links">
              {note.links.map((link) => {
                const url = link.url;
                const text = link.text;
                if (url && text) {
                  return (
                    <Detail.Metadata.TagList.Item key={link.id} text={truncate(text)} onAction={() => open(url)} />
                  );
                }
                return null;
              })}
            </Detail.Metadata.TagList>
          ) : null}
          {note.backlinks.length > 0 ? (
            <Detail.Metadata.TagList title="Backlinks">
              {note.backlinks.map((backlink) => (
                <Detail.Metadata.TagList.Item
                  key={backlink.id}
                  text={truncate(backlink.title)}
                  onAction={() => open(backlink.url)}
                />
              ))}
            </Detail.Metadata.TagList>
          ) : null}
        </Detail.Metadata>
      }
      isLoading={isLoading}
      actions={<NoteActions note={note} isDeleted={isDeleted} mutate={mutate} isDetail />}
    />
  );
}
