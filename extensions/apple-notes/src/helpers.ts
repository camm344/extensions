import { execSync } from "child_process";
import crypto from "crypto";
import fs, { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import os, { tmpdir } from "os";
import path, { join } from "path";
import { environment } from "@raycast/api";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { debugLog } from "./logger";
import { CacheMetadata } from "./interfaces";

const CACHE_META_FILE = ".cache-meta.json";

function readCacheMetadata(): CacheMetadata | null {
  try {
    const metaPath = join(environment.supportPath, CACHE_META_FILE);
    if (!existsSync(metaPath)) {
      return null;
    }
    const data = readFileSync(metaPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function writeCacheMetadata(meta: CacheMetadata): void {
  try {
    const metaPath = join(environment.supportPath, CACHE_META_FILE);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  } catch (error) {
    debugLog(`Failed to write cache metadata: ${error}`);
  }
}

function incrementCacheMetadata(fileSize: number): void {
  const meta = readCacheMetadata() || { totalSize: 0, fileCount: 0, lastUpdated: new Date().toISOString() };
  meta.totalSize += fileSize;
  meta.fileCount += 1;
  meta.lastUpdated = new Date().toISOString();
  writeCacheMetadata(meta);
}

function recalculateCacheMetadata(): CacheMetadata {
  const noteCacheDir = join(environment.supportPath, "note-cache");
  const imageCacheDir = join(environment.supportPath, "image-cache");

  let totalSize = 0;
  let fileCount = 0;

  // Scan note cache
  if (existsSync(noteCacheDir)) {
    const noteFiles = readdirSync(noteCacheDir);
    for (const file of noteFiles) {
      if (!file.endsWith(".html")) continue;
      try {
        const stats = statSync(join(noteCacheDir, file));
        totalSize += stats.size;
        fileCount++;
      } catch {
        // Ignore
      }
    }
  }

  // Scan image cache
  if (existsSync(imageCacheDir)) {
    const imageFiles = readdirSync(imageCacheDir);
    for (const file of imageFiles) {
      if (!file.endsWith(".jpg")) continue;
      try {
        const stats = statSync(join(imageCacheDir, file));
        totalSize += stats.size;
        fileCount++;
      } catch {
        // Ignore
      }
    }
  }

  const meta: CacheMetadata = {
    totalSize,
    fileCount,
    lastUpdated: new Date().toISOString(),
  };

  writeCacheMetadata(meta);
  return meta;
}

export const fileIcon = "/System/Applications/Notes.app";

export function escapeDoubleQuotes(value: string) {
  return value.replace(/"/g, '\\"');
}

/**
 * Decodes hex-encoded protobuf data from Notes database
 * Similar to Messages extension's decodeHexString but adapted for Notes format
 * @param hexString - Hex-encoded binary data from ZDATA column
 * @returns Decoded HTML string or empty string if decoding fails
 */
export function decodeNotesHexString(hexString: string): string {
  try {
    // Convert hex string to byte array
    const bytes = hexString.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || [];

    if (bytes.length === 0) {
      return "";
    }

    // Notes data is usually gzipped protobuf
    // Try to decompress if it starts with gzip magic number (1f 8b)
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      // This is gzipped - we need proper decompression
      // For now, return empty and fall back to AppleScript
      return "";
    }

    // Try direct UTF-8 decode for uncompressed data
    try {
      const result = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
      // If we got readable text, return it
      if (result && result.length > 0 && !result.includes("�")) {
        return result;
      }
    } catch {
      // Decoding failed
    }

    return "";
  } catch (error) {
    debugLog(`Failed to decode hex string: ${error}`);
    return "";
  }
}

export function truncate(str: string, maxLength = 30): string {
  if (str.length <= maxLength) {
    return str;
  }

  return str.substring(0, maxLength) + "…";
}

export function getOpenNoteURL(uuid: string) {
  const isSonomaOrLater = parseInt(os.release().split(".")[0]) >= 23;
  return `${isSonomaOrLater ? "applenotes" : "notes"}://showNote?identifier=${uuid}`;
}

/**
 * Strips all base64-encoded images from HTML content to prevent memory issues
 * All images are replaced with placeholder text showing image type and size
 * @param htmlContent - The HTML content to process
 * @returns HTML with all base64 images replaced with placeholders
 */
export function stripLargeImagesFromHtml(htmlContent: string): string {
  try {
    // CRITICAL: Immediately check if content is processable
    // Raycast has ~256-512MB heap limit, so be very conservative
    if (htmlContent.length > 2 * 1024 * 1024 && htmlContent.includes("data:image")) {
      // Content is > 2MB and has images - too risky to process
      throw new Error("Content too large with embedded images");
    }

    // Use split approach - most memory efficient
    const parts = htmlContent.split("<img");

    if (parts.length === 1) {
      // No images
      return htmlContent;
    }

    const results = [parts[0]];
    const maxImages = 50; // Reduced limit for Raycast

    for (let i = 1; i < Math.min(parts.length, maxImages); i++) {
      const part = parts[i];
      const snippet = part.substring(0, 150).toLowerCase();

      if (snippet.includes("data:image") && snippet.includes("base64")) {
        // Data URL image - replace with placeholder
        let imageType = "IMAGE";
        const typeMatch = snippet.match(/data:image\/(png|jpeg|jpg|gif|webp)/i);
        if (typeMatch) {
          imageType = typeMatch[1].toUpperCase();
        }

        const endTagPos = part.indexOf(">");
        if (endTagPos !== -1) {
          results.push(`<p><em>🖼️ [${imageType} Image]</em></p>`);
          results.push(part.substring(endTagPos + 1));
        } else {
          results.push(part);
        }
      } else {
        // Regular image, keep it
        results.push("<img" + part);
      }
    }

    return results.join("");
  } catch (error) {
    debugLog(`Failed to process images: ${error}`);
    // Emergency: truncate to safe size
    const safeLen = Math.min(htmlContent.length, 100000); // 100KB max in fallback
    return htmlContent.substring(0, safeLen).replace(/<img[^>]*>/gi, "<p><em>🖼️ [Image]</em></p>");
  }
}

/**
 * Extracts base64 images from HTML file, resizes them using sips, and replaces them with smaller versions
 * This processes the file directly to avoid loading large content into memory
 * @param filePath - Path to HTML file
 * @returns Path to processed HTML file with resized images
 */
export function extractAndResizeImagesInFile(filePath: string): string {
  const tempDir = path.join(environment.supportPath, "temp-images");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  try {
    // Read file in chunks to find and extract images
    const content = fs.readFileSync(filePath, "utf-8");

    // Quick check - if no images, return original
    if (!content.includes("data:image")) {
      return filePath;
    }

    let imageCounter = 0;
    const maxImages = 20; // Conservative limit
    const maxImageSize = 800; // Max width/height in pixels

    // Process images using regex but only extract and resize
    const processedContent = content.replace(
      /<img([^>]*)src=["']data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)["']([^>]*)>/gi,
      (match, beforeSrc, imageType, base64Data, afterSrc) => {
        imageCounter++;

        if (imageCounter > maxImages) {
          return `<p><em>🖼️ [Image ${imageCounter} - Too many images]</em></p>`;
        }

        try {
          // Estimate size
          const base64Length = base64Data.length;
          const approximateSizeKB = (base64Length * 0.75) / 1024;

          // Skip very small images (< 50KB) - keep them as-is
          if (approximateSizeKB < 50) {
            return match;
          }

          // Decode base64 to a temp file
          const timestamp = Date.now();
          const tempInputPath = path.join(tempDir, `input-${timestamp}-${imageCounter}.${imageType}`);
          const tempOutputPath = path.join(tempDir, `output-${timestamp}-${imageCounter}.${imageType}`);

          // Write base64 to file
          const imageBuffer = Buffer.from(base64Data, "base64");
          fs.writeFileSync(tempInputPath, new Uint8Array(imageBuffer));

          // Use sips to resize the image
          try {
            execSync(
              `sips -Z ${maxImageSize} "${tempInputPath}" --out "${tempOutputPath}" 2>/dev/null`,
              { timeout: 5000 }, // 5 second timeout per image
            );

            // Read the resized image and convert back to base64
            const resizedBuffer = fs.readFileSync(tempOutputPath);
            const resizedBase64 = resizedBuffer.toString("base64");

            // Clean up temp files
            fs.unlinkSync(tempInputPath);
            fs.unlinkSync(tempOutputPath);

            // Return img tag with smaller base64
            const newSizeKB = ((resizedBase64.length * 0.75) / 1024).toFixed(1);
            debugLog(`Resized image ${imageCounter}: ${approximateSizeKB.toFixed(1)}KB → ${newSizeKB}KB`);

            return `<img${beforeSrc} src="data:image/${imageType};base64,${resizedBase64}"${afterSrc}>`;
          } catch (sipsError) {
            // If sips fails, clean up and use placeholder
            try {
              fs.unlinkSync(tempInputPath);
              if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
            } catch {
              // Ignore cleanup errors
            }

            return `<p><em>🖼️ [${imageType.toUpperCase()} Image - ${approximateSizeKB.toFixed(1)}KB - Could not resize]</em></p>`;
          }
        } catch (error) {
          debugLog(`Failed to process image ${imageCounter}: ${error}`);
          return `<p><em>🖼️ [Image ${imageCounter} - Processing failed]</em></p>`;
        }
      },
    );

    // Write processed content to a new temp file
    const processedFilePath = filePath.replace(".html", "-processed.html");
    fs.writeFileSync(processedFilePath, processedContent, "utf-8");

    return processedFilePath;
  } catch (error) {
    debugLog(`Failed to process images in file: ${error}`);
    // Return original file if processing fails
    return filePath;
  }
}

/**
 * Cleans up old temporary image files to prevent disk space issues
 * Removes images older than 1 hour
 */
export function cleanupTempImages(): void {
  try {
    const tempDir = path.join(environment.supportPath, "temp-images");
    if (!fs.existsSync(tempDir)) {
      return;
    }

    const now = Date.now();
    const maxAge = 1 * 60 * 60 * 1000;

    const files = fs.readdirSync(tempDir);
    files.forEach((file: string) => {
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);
      const age = now - stats.mtimeMs;

      if (age > maxAge) {
        fs.unlinkSync(filePath);
      }
    });
  } catch (error) {
    debugLog(`Failed to cleanup temp images: ${error}`);
  }
}

/**
 * Extracts base64 images from HTML, saves them as files, and replaces with file:// URLs
 * This is more memory-efficient than keeping base64 in markdown
 * @param htmlContent - HTML content with base64 images
 * @returns HTML with file:// image references
 */
export function extractImagesToFiles(htmlContent: string): string {
  const imgRegex = /<img[^>]*src=["']data:image\/(png|jpeg|jpg|gif|webp);base64,([^"']+)["'][^>]*>/gi;
  let match;
  let processedHtml = htmlContent;
  let imageIndex = 0;

  while ((match = imgRegex.exec(htmlContent)) !== null && imageIndex < 50) {
    try {
      const fullMatch = match[0];
      const imageType = match[1];
      const base64Data = match[2];

      // Decode and save to temp file
      const fileName = `raycast-note-img-${Date.now()}-${imageIndex}.${imageType}`;
      const filePath = join(tmpdir(), fileName);
      const buffer = Buffer.from(base64Data, "base64");
      fs.writeFileSync(filePath, new Uint8Array(buffer));

      debugLog(`Saved image ${imageIndex + 1} to: ${filePath} (${(buffer.length / 1024).toFixed(1)}KB)`);

      // Replace with file:// URL
      const newImgTag = `<img src="file://${filePath}" alt="Image ${imageIndex + 1}" />`;
      processedHtml = processedHtml.replace(fullMatch, newImgTag);

      imageIndex++;
    } catch (error) {
      debugLog(`Failed to extract image ${imageIndex}: ${error}`);
    }
  }

  debugLog(`Extracted ${imageIndex} images to disk`);
  return processedHtml;
}

/**
 * Processes HTML with huge base64 images using shell commands (no Node.js memory usage!)
 * Extracts base64 images, resizes with sips, and replaces with file:// URLs
 * @param inputPath - Path to HTML file
 * @param outputPath - Path to write processed HTML
 * @param maxWidth - Maximum width for resized images
 */
export function processImagesWithShellScript(inputPath: string, outputPath: string, maxWidth: number = 600): void {
  const tempDir = tmpdir();
  // Use supportPath for image cache so it persists across reboots
  const cacheDir = join(environment.supportPath, "image-cache");

  // Ensure cache directory exists
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }

  // Compute hash of input HTML file
  const htmlContent = readFileSync(inputPath, "utf-8");
  const htmlHash = crypto.createHash("md5").update(htmlContent).digest("hex");

  // Check if cached images exist for this exact HTML
  const cachePrefix = `${htmlHash}-`;

  if (existsSync(cacheDir)) {
    const cachedFiles = readdirSync(cacheDir).filter((f) => f.startsWith(cachePrefix));
    if (cachedFiles.length > 0) {
      debugLog(
        `Cache hit! Found ${cachedFiles.length} cached images for this note (hash: ${htmlHash.substring(0, 8)}...)`,
      );

      // Build output HTML using cached images
      const script = `#!/bin/bash
INPUT="$1"
OUTPUT="$2"
CACHE_PREFIX="$3"
CACHE_DIR="$4"

IMAGE_COUNT=0

# Process file line by line
while IFS= read -r line; do
  if echo "$line" | grep -q 'src="data:image/'; then
    IMAGE_COUNT=$((IMAGE_COUNT + 1))
    
    # Find cached file for this image index
    CACHED_FILE="$CACHE_DIR/\${CACHE_PREFIX}img\${IMAGE_COUNT}.jpg"
    
    if [ -f "$CACHED_FILE" ]; then
      # Extract everything before the <img tag
      BEFORE_IMG=$(echo "$line" | sed 's/<img.*//')
      # Store just the filename (not full path)
      FILENAME="\${CACHE_PREFIX}img\${IMAGE_COUNT}.jpg"
      echo "\${BEFORE_IMG}<img src=\\"\${FILENAME}\\">" >> "$OUTPUT"
    else
      echo "<!-- Cached image $IMAGE_COUNT not found -->" >> "$OUTPUT"
    fi
  else
    echo "$line" >> "$OUTPUT"
  fi
done < "$INPUT"
`;

      const scriptPath = join(tempDir, `raycast-cache-read-${Date.now()}.sh`);
      fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });

      execSync(`"${scriptPath}" "${inputPath}" "${outputPath}" "${cachePrefix}" "${cacheDir}"`, {
        encoding: "utf-8",
      });

      fs.unlinkSync(scriptPath);
      return; // Done - used cache!
    }
  }

  debugLog(`No cache for this note (hash: ${htmlHash.substring(0, 8)}...), processing images...`);

  const scriptPath = join(tempDir, `raycast-img-process-${Date.now()}.sh`);

  // Create a bash script that processes images line-by-line with PARALLEL processing
  const script = `#!/bin/bash

INPUT="$1"
OUTPUT="$2"
MAX_WIDTH="$3"
TEMP_DIR="$4"
HTML_HASH="$5"
CACHE_DIR="$6"

IMAGE_COUNT=0
QUALITY=20
mkdir -p "$CACHE_DIR"

echo "START: $(date +%H:%M:%S.%N | cut -c1-12)" >&2

# Process file line by line
while IFS= read -r line; do
  # Check if line contains data:image
  if echo "$line" | grep -q 'src="data:image/'; then
    IMAGE_COUNT=$((IMAGE_COUNT + 1))
    LINE_TIME=$(date +%H:%M:%S.%N | cut -c1-12)
    
    # Process each image in parallel (background)
    (
      echo "[$LINE_TIME] Processing image $IMAGE_COUNT..." >&2
      
      START_EXTRACT=$(date +%s.%N)
      # Extract the base64 data and image type
      IMAGE_TYPE=$(echo "$line" | sed -n 's/.*data:image\\/\\([^;]*\\);base64,.*/\\1/p')
      BASE64_DATA=$(echo "$line" | sed -n 's/.*base64,\\([^"]*\\)".*/\\1/p')
      END_EXTRACT=$(date +%s.%N)
      EXTRACT_TIME=$(echo "$END_EXTRACT - $START_EXTRACT" | bc)
      echo "  [$LINE_TIME] Extraction took: \${EXTRACT_TIME}s" >&2
      
      # Cache file based on HTML hash and image index
      TEMP_IN="$TEMP_DIR/raycast-shell-in-$IMAGE_COUNT.$IMAGE_TYPE"
      TEMP_OUT="$CACHE_DIR/\${HTML_HASH}-img\${IMAGE_COUNT}.jpg"
      
      START_DECODE=$(date +%s.%N)
      echo "$BASE64_DATA" | base64 -d > "$TEMP_IN" 2>/dev/null || {
        echo "<!-- Image $IMAGE_COUNT decode failed -->" >> "$OUTPUT.part$IMAGE_COUNT"
        exit 1
      }
      END_DECODE=$(date +%s.%N)
      DECODE_TIME=$(echo "$END_DECODE - $START_DECODE" | bc)
      
      # Get original size
      ORIG_SIZE=$(stat -f%z "$TEMP_IN" 2>/dev/null || echo "0")
      echo "  [$LINE_TIME] Decoded: $((ORIG_SIZE / 1024))KB in \${DECODE_TIME}s" >&2
      
      # Resize with sips and convert to JPEG (20% quality for max speed)
      START_RESIZE=$(date +%s.%N)
      sips -Z "$MAX_WIDTH" -s format jpeg -s formatOptions 20 "$TEMP_IN" --out "$TEMP_OUT" >/dev/null 2>&1 || {
        echo "<!-- Image $IMAGE_COUNT resize failed -->" >> "$OUTPUT.part$IMAGE_COUNT"
        rm -f "$TEMP_IN"
        exit 1
      }
      END_RESIZE=$(date +%s.%N)
      RESIZE_TIME=$(echo "$END_RESIZE - $START_RESIZE" | bc)
      
      # Get resized size
      NEW_SIZE=$(stat -f%z "$TEMP_OUT" 2>/dev/null || echo "0")
      echo "  [$LINE_TIME] Resized: $((ORIG_SIZE / 1024))KB → $((NEW_SIZE / 1024))KB in \${RESIZE_TIME}s" >&2
      
      # Extract the part before src attribute
      BEFORE_SRC=$(echo "$line" | sed 's/\\(.*<img[^>]*\\)src="data:image[^"]*".*/\\1/')
      
      # Store just the filename (not full path) for portability
      FILENAME="\${HTML_HASH}-img\${IMAGE_COUNT}.jpg"
      
      # Write the img tag with just filename to a part file
      echo "\${BEFORE_SRC}src=\\"\${FILENAME}\\">" > "$OUTPUT.part$IMAGE_COUNT"
      
      # Clean up input file only (keep output for viewing)
      rm -f "$TEMP_IN"
      
      TOTAL=$(date +%s.%N)
      TOTAL_TIME=$(echo "$TOTAL - $START_EXTRACT" | bc)
      echo "  [$LINE_TIME] Image $IMAGE_COUNT DONE in \${TOTAL_TIME}s total" >&2
    ) &
    
  else
    # Write non-image lines as-is
    echo "$line" >> "$OUTPUT"
  fi
done < "$INPUT"

BEFORE_WAIT=$(date +%H:%M:%S.%N | cut -c1-12)
echo "[$BEFORE_WAIT] Waiting for $IMAGE_COUNT parallel resize jobs..." >&2
wait
AFTER_WAIT=$(date +%H:%M:%S.%N | cut -c1-12)
echo "[$AFTER_WAIT] All jobs completed" >&2

# Concatenate all part files in order
for ((i=1; i<=IMAGE_COUNT; i++)); do
  if [ -f "$OUTPUT.part$i" ]; then
    cat "$OUTPUT.part$i" >> "$OUTPUT"
    rm -f "$OUTPUT.part$i"
  fi
done

END=$(date +%H:%M:%S.%N | cut -c1-12)
echo "END: $END - Processed $IMAGE_COUNT images in parallel" >&2
`;

  try {
    // Write the script
    fs.writeFileSync(scriptPath, script, { encoding: "utf-8", mode: 0o755 });

    debugLog("Running shell-based image processing...");

    // Execute the script - this runs ENTIRELY in bash, no Node.js memory!
    // Capture both stdout and stderr to see all timing details
    const result = execSync(
      `"${scriptPath}" "${inputPath}" "${outputPath}" "${maxWidth}" "${tempDir}" "${htmlHash}" "${cacheDir}" 2>&1`,
      {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 1024, // 1GB buffer for script output
      },
    );

    // Log the result to debug file (show all timing details)
    if (result) {
      debugLog("Shell script output:\n" + result.toString());
    }

    // Update cache metadata with image files created by shell script
    try {
      const imageCacheDir = join(environment.supportPath, "image-cache");
      if (existsSync(imageCacheDir)) {
        const imageFiles = readdirSync(imageCacheDir);
        const htmlHash = crypto.createHash("md5").update(readFileSync(inputPath, "utf-8")).digest("hex");

        // Find all images created for this HTML hash
        const newImages = imageFiles.filter((file) => file.startsWith(htmlHash) && file.endsWith(".jpg"));

        for (const imageFile of newImages) {
          const imagePath = join(imageCacheDir, imageFile);
          const stats = statSync(imagePath);
          incrementCacheMetadata(stats.size);
          debugLog(`📊 Added image to metadata: ${imageFile} (${(stats.size / 1024).toFixed(1)}KB)`);
        }
      }
    } catch (error) {
      debugLog(`Failed to update image metadata: ${error}`);
    }

    // Clean up script
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Ignore
    }
  } catch (error) {
    // Clean up on error
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Ignore
    }
    throw error;
  }
}

/**
 * Extracts base64 images from HTML in streaming mode, resizes them with sips, and replaces them
 * This version streams the file to avoid loading large files into memory
 * @param inputPath - Path to HTML file
 * @param outputPath - Path to write processed HTML
 * @param maxWidth - Maximum width for images (default 600px)
 */
export async function resizeImagesInFileStreamingWithSips(
  inputPath: string,
  outputPath: string,
  maxWidth: number = 600,
): Promise<void> {
  const { createReadStream, createWriteStream, writeFileSync, readFileSync, unlinkSync } = fs;

  return new Promise((resolve, reject) => {
    const readStream = createReadStream(inputPath, { encoding: "utf-8", highWaterMark: 128 * 1024 }); // 128KB chunks
    const writeStream = createWriteStream(outputPath, { encoding: "utf-8" });

    let buffer = "";
    let imageCount = 0;
    const maxImages = 15; // Limit for very large files
    let inImage = false;
    let currentImageData = "";
    let currentImageType = "";
    let imageStartPos = 0; // Position of 'src="data:image/'
    let imgTagStartPos = 0; // Position of '<img'
    let base64StartPos = 0; // Position where base64 data actually starts (after "base64,")

    readStream.on("data", (chunk: string) => {
      buffer += chunk;
      let writePos = 0;
      let searchPos = 0;

      while (searchPos < buffer.length && imageCount < maxImages) {
        if (inImage) {
          // We're collecting base64 data, look for the end quote
          // CRITICAL: Search from base64StartPos (where the base64 data starts), not from searchPos!
          const endQuote = buffer.indexOf('"', base64StartPos);
          if (endQuote === -1) {
            // Haven't found end yet
            // SAFETY CHECK: If buffer is getting too large (>2MB), bail out and strip instead
            if (buffer.length > 2 * 1024 * 1024) {
              debugLog(
                `ERROR: Base64 image too large (buffer: ${buffer.length} chars), cannot resize. Falling back to stripping.`,
              );
              throw new Error("Image too large for streaming resize");
            }

            // Collect this chunk from base64StartPos to end
            currentImageData += buffer.substring(base64StartPos);
            // Update base64StartPos for next chunk (relative to new buffer after we trim it)
            base64StartPos = buffer.length;
            searchPos = buffer.length;
            break;
          }

          // Found end of base64 data - collect from base64StartPos to endQuote
          currentImageData += buffer.substring(base64StartPos, endQuote);

          // Find the start of the <img tag (before we process it)
          // We stored imgTagStartPos when we found the image, use that!
          const imgTagStart = imgTagStartPos;

          // Find the end of the img tag
          const afterImg = buffer.indexOf(">", endQuote);
          const imgTagEnd = afterImg !== -1 ? afterImg + 1 : endQuote + 1;

          debugLog(
            `DEBUG: Image ${imageCount + 1} positions - imgTagStart: ${imgTagStart}, imageStartPos: ${imageStartPos}, endQuote: ${endQuote}, imgTagEnd: ${imgTagEnd}, writePos: ${writePos}`,
          );
          debugLog(`DEBUG: Will skip ${imgTagEnd - imgTagStart} chars (entire img tag)`);

          // Now resize the image
          try {
            const tempInputFile = join(tmpdir(), `raycast-stream-in-${Date.now()}-${imageCount}.${currentImageType}`);
            const tempOutputFile = join(tmpdir(), `raycast-stream-out-${Date.now()}-${imageCount}.${currentImageType}`);

            // Decode and write
            const imgBuffer = Buffer.from(currentImageData, "base64");
            debugLog(`Resizing image ${imageCount + 1}: ${(imgBuffer.length / 1024).toFixed(1)}KB`);
            writeFileSync(tempInputFile, new Uint8Array(imgBuffer));

            // Resize with sips
            execSync(`sips -Z ${maxWidth} "${tempInputFile}" --out "${tempOutputFile}" 2>/dev/null`, {
              stdio: "pipe",
            });

            const resizedBuffer = readFileSync(tempOutputFile);

            debugLog(
              `  → ${(resizedBuffer.length / 1024).toFixed(1)}KB (${((resizedBuffer.length / imgBuffer.length) * 100).toFixed(0)}%) saved to ${tempOutputFile}`,
            );

            // Write everything before the img tag, but remove any trailing base64 garbage
            const beforeImg = buffer.substring(writePos, imgTagStart);
            // Remove long base64 sequences from the text before the image
            const cleanedBefore = beforeImg.replace(/[A-Za-z0-9+/]{50,}={0,2}/g, " ").trim();
            if (cleanedBefore.length > 0) {
              debugLog(`Writing ${cleanedBefore.length} chars before image`);
              writeStream.write(cleanedBefore + "\n\n");
            }

            // Use file:// URL instead of base64 - much cleaner!
            const imgTag = `<img src="file://${tempOutputFile}" alt="Image ${imageCount + 1}" />`;
            debugLog(`Writing img tag: ${imgTag}`);
            writeStream.write(imgTag);

            // Clean up input file only (keep output file for viewing)
            try {
              unlinkSync(tempInputFile);
            } catch {
              // Ignore
            }

            imageCount++;
          } catch (error) {
            debugLog(`Failed to resize image ${imageCount}: ${error}`);
            // Write original (skip the broken image)
            writeStream.write(buffer.substring(writePos, imgTagStart));
            writeStream.write(`<!-- Image ${imageCount} failed to resize -->`);
          }

          // CRITICAL: Update both positions to skip the ENTIRE original <img> tag
          // This removes all the base64 data from the output!
          searchPos = imgTagEnd;
          writePos = imgTagEnd;

          // Reset state
          inImage = false;
          currentImageData = "";
          currentImageType = "";
        } else {
          // Look for start of data:image
          const dataImagePos = buffer.indexOf('src="data:image/', searchPos);
          if (dataImagePos === -1) {
            break;
          }

          // Found start of data image
          imageStartPos = dataImagePos;
          imgTagStartPos = buffer.lastIndexOf("<img", imageStartPos); // Find actual <img tag start

          // Extract image type
          const typeStart = dataImagePos + 16; // After 'src="data:image/'
          const semicolon = buffer.indexOf(";", typeStart);
          if (semicolon === -1 || semicolon - typeStart > 10) {
            // Can't find type or too far, skip this one
            searchPos = dataImagePos + 16;
            continue;
          }

          currentImageType = buffer.substring(typeStart, semicolon);

          // Look for base64 start
          const base64Start = buffer.indexOf("base64,", semicolon);
          if (base64Start === -1 || base64Start - semicolon > 20) {
            // Can't find base64, skip
            searchPos = semicolon + 1;
            continue;
          }

          // Start collecting base64 data
          inImage = true;
          searchPos = base64Start + 7; // After "base64," - but we won't use this for searching
          base64StartPos = base64Start + 7; // This is where the actual base64 data starts!
          currentImageData = "";
        }
      }

      // Write any content that wasn't part of an image
      if (!inImage && writePos < buffer.length) {
        const keepSize = 500; // Keep some buffer for potential image tags
        if (buffer.length - writePos > keepSize) {
          const writeEnd = buffer.length - keepSize;
          debugLog(
            `DEBUG: Writing chunk to stream, buffer.length=${buffer.length}, writePos=${writePos}, writeEnd=${writeEnd}`,
          );
          writeStream.write(buffer.substring(writePos, writeEnd));
          // Reset buffer to only keep the unprocessed part
          const oldBufferLength = buffer.length;
          buffer = buffer.substring(writeEnd);
          debugLog(`DEBUG: Buffer reset, old length=${oldBufferLength}, new length=${buffer.length}`);
          // Reset positions relative to new buffer
          searchPos = Math.max(0, searchPos - writeEnd);
          writePos = 0;
          debugLog(`DEBUG: After reset - searchPos=${searchPos}, writePos=${writePos}`);
        }
      } else if (inImage) {
        // We're collecting image data - don't write anything yet
        // Keep buffer as is for next chunk
        debugLog(
          `DEBUG: In image, keeping buffer (${buffer.length} chars), writePos=${writePos}, searchPos=${searchPos}, base64StartPos=${base64StartPos}`,
        );
      } else {
        // writePos >= buffer.length, we've processed everything
        debugLog(`DEBUG: Processed everything, clearing buffer`);
        buffer = "";
        searchPos = 0;
        writePos = 0;
      }
    });

    readStream.on("end", () => {
      // Write any remaining buffer
      if (buffer.length > 0 && !inImage) {
        writeStream.write(buffer);
      }
      writeStream.end();
    });

    writeStream.on("finish", () => {
      debugLog(`Streaming resize complete: processed ${imageCount} images`);
      resolve();
    });

    readStream.on("error", reject);
    writeStream.on("error", reject);
  });
}

/**
 * Extracts base64 images from HTML, resizes them with sips, and replaces them
 * @param inputPath - Path to HTML file
 * @param outputPath - Path to write processed HTML
 * @param maxWidth - Maximum width for images (default 800px)
 */
export async function resizeImagesInFileWithSips(
  inputPath: string,
  outputPath: string,
  maxWidth: number = 800,
): Promise<void> {
  const { readFileSync, writeFileSync, unlinkSync } = fs;

  const htmlContent = readFileSync(inputPath, "utf-8");

  // Find all data:image base64 images
  const imgRegex = /<img[^>]*src=["']data:image\/(png|jpeg|jpg|gif|webp);base64,([^"']+)["'][^>]*>/gi;
  let match;
  let processedHtml = htmlContent;
  let imageCount = 0;
  const maxImages = 20; // Limit to prevent too many conversions

  while ((match = imgRegex.exec(htmlContent)) !== null && imageCount < maxImages) {
    try {
      const fullMatch = match[0];
      const imageType = match[1];
      const base64Data = match[2];

      // Decode base64 to temp file
      const tempInputFile = join(tmpdir(), `raycast-img-in-${Date.now()}-${imageCount}.${imageType}`);
      const tempOutputFile = join(tmpdir(), `raycast-img-out-${Date.now()}-${imageCount}.${imageType}`);

      // Write base64 to file
      const buffer = Buffer.from(base64Data, "base64");
      writeFileSync(tempInputFile, new Uint8Array(buffer));

      debugLog(`Resizing image ${imageCount + 1}: ${(buffer.length / 1024).toFixed(1)}KB`);

      // Resize with sips
      execSync(`sips -Z ${maxWidth} "${tempInputFile}" --out "${tempOutputFile}"`, {
        stdio: "pipe",
      });

      // Read resized image back as base64
      const resizedBuffer = readFileSync(tempOutputFile);
      const resizedBase64 = resizedBuffer.toString("base64");

      debugLog(`  Resized: ${(buffer.length / 1024).toFixed(1)}KB → ${(resizedBuffer.length / 1024).toFixed(1)}KB`);

      // Replace in HTML
      const newImgTag = `<img src="data:image/${imageType};base64,${resizedBase64}" />`;
      processedHtml = processedHtml.replace(fullMatch, newImgTag);

      // Clean up temp files
      try {
        unlinkSync(tempInputFile);
        unlinkSync(tempOutputFile);
      } catch {
        // Ignore cleanup errors
      }

      imageCount++;
    } catch (error) {
      debugLog(`Failed to resize image ${imageCount}: ${error}`);
      // Continue with next image
    }
  }

  debugLog(`Resized ${imageCount} images`);

  // Write processed HTML
  writeFileSync(outputPath, processedHtml, "utf-8");
}

/**
 * Processes HTML file in chunks to strip images without loading entire file into memory
 * @param inputPath - Path to HTML file
 * @param outputPath - Path to write cleaned HTML
 * @returns True if successful
 */
export async function stripImagesFromFileInChunks(inputPath: string, outputPath: string): Promise<void> {
  const { createReadStream, createWriteStream } = fs;

  return new Promise((resolve, reject) => {
    const readStream = createReadStream(inputPath, { encoding: "utf-8", highWaterMark: 64 * 1024 }); // 64KB chunks
    const writeStream = createWriteStream(outputPath, { encoding: "utf-8" });

    let buffer = "";
    let inDataImage = false;
    let skipUntil = "";

    readStream.on("data", (chunk: string) => {
      buffer += chunk;

      let writePos = 0;
      let searchPos = 0;

      while (searchPos < buffer.length) {
        if (inDataImage) {
          // We're inside a data:image, skip until we find the end
          const endPos = buffer.indexOf(skipUntil, searchPos);
          if (endPos === -1) {
            // Haven't found the end yet, skip entire remaining buffer
            searchPos = buffer.length;
            break;
          }

          // Found the end of the image tag
          searchPos = endPos + skipUntil.length;
          inDataImage = false;
          skipUntil = "";
        } else {
          // Look for <img tags with data:image
          const imgStart = buffer.indexOf("<img", searchPos);
          if (imgStart === -1) {
            // No more img tags in buffer
            break;
          }

          // Check if this is a data:image (look ahead a bit)
          const lookAheadEnd = Math.min(imgStart + 200, buffer.length);
          const snippet = buffer.substring(imgStart, lookAheadEnd);

          if (snippet.includes("data:image") && snippet.includes("base64")) {
            // Found a data URL image!
            // Write everything before this img tag
            writeStream.write(buffer.substring(writePos, imgStart));

            // Write placeholder
            writeStream.write("<p><em>🖼️ [Image]</em></p>");

            // Now skip until the end of this img tag
            const endOfTag = buffer.indexOf(">", imgStart);
            if (endOfTag === -1) {
              // Tag doesn't end in this buffer, mark as in data image and skip rest
              inDataImage = true;
              skipUntil = ">";
              searchPos = buffer.length;
              writePos = buffer.length;
            } else {
              // Tag ends in this buffer
              searchPos = endOfTag + 1;
              writePos = searchPos;
            }
          } else {
            // Regular image, keep it
            searchPos = imgStart + 4; // Move past "<img"
          }
        }
      }

      // Write any remaining content that wasn't part of a data:image
      if (!inDataImage && writePos < buffer.length) {
        // Keep the last bit of buffer in case an <img tag is split across chunks
        const keepSize = 300; // Enough to hold a partial <img tag start
        if (buffer.length - writePos > keepSize) {
          const writeEnd = buffer.length - keepSize;
          writeStream.write(buffer.substring(writePos, writeEnd));
          buffer = buffer.substring(writeEnd);
        }
      } else if (inDataImage) {
        // We're in the middle of skipping a data:image, clear the buffer
        buffer = "";
      } else {
        // Keep last bit for next iteration
        buffer = buffer.substring(writePos);
      }
    });

    readStream.on("end", () => {
      // Write any remaining buffer (unless we're still in a data image)
      if (buffer.length > 0 && !inDataImage) {
        writeStream.write(buffer);
      }
      writeStream.end();
    });

    writeStream.on("finish", () => {
      resolve();
    });

    readStream.on("error", reject);
    writeStream.on("error", reject);
  });
}

/**
 * Converts HTML file to Markdown with streaming to handle large files
 * Automatically chooses best strategy based on file size
 * @param filePath - Path to HTML file
 * @param contentHash - Optional MD5 hash of content for caching
 * @returns Markdown string
 */
export async function convertHtmlFileToMarkdownSafely(filePath: string, contentHash?: string): Promise<string> {
  const { statSync, readFileSync, unlinkSync, existsSync, readdirSync } = fs;

  try {
    // Check file size first
    const stats = statSync(filePath);
    const fileSizeInMB = stats.size / (1024 * 1024);

    debugLog(`Processing note file: ${fileSizeInMB.toFixed(2)}MB`);

    // FLOW 1: Large files (>5MB) - use shell script processing (no Node.js memory!)
    if (fileSizeInMB > 5 && fileSizeInMB <= 500) {
      debugLog("Large file - processing with shell script (no Node.js memory)...");

      const tempProcessedFile = join(tmpdir(), `raycast-processed-${Date.now()}.html`);

      try {
        // Use shell script - completely bypasses Node.js memory limits!
        // 450px JPEG 20% for speed and small files
        await processImagesWithShellScript(filePath, tempProcessedFile, 450);

        // Check processed file size
        const processedStats = statSync(tempProcessedFile);
        const processedSizeInMB = processedStats.size / (1024 * 1024);

        // Calculate actual image cache size
        let imageCacheSize = 0;
        let imageFileCount = 0;
        const imageCacheDir = join(environment.supportPath, "image-cache");
        if (existsSync(imageCacheDir)) {
          const imageFiles = readdirSync(imageCacheDir);
          imageFileCount = imageFiles.length;
          imageCacheSize = imageFiles.reduce((sum, file) => {
            const filePath = join(imageCacheDir, file);
            return sum + statSync(filePath).size;
          }, 0);
        }

        debugLog(
          `After processing: ${fileSizeInMB.toFixed(2)}MB original → ${(processedStats.size / 1024).toFixed(1)}KB cached HTML + ${(imageCacheSize / 1024).toFixed(0)}KB images (${imageFileCount} files)`,
        );

        if (processedSizeInMB > 5) {
          unlinkSync(tempProcessedFile);
          throw new Error(
            `This note is still too large after processing (${processedSizeInMB.toFixed(1)}MB).\n\nPlease open it in the Apple Notes app.`,
          );
        }

        // Now safe to load into memory (should be small now)
        const processedHtml = readFileSync(tempProcessedFile, "utf-8");

        // Convert to markdown with simple conversion (keep file:// URLs)
        let markdown = processedHtml
          // Convert div tags to newlines for proper spacing
          .replace(/<div>/gi, "\n")
          .replace(/<\/div>/gi, "\n")
          .replace(/<br\s*\/?>/gi, "\n")
          // Convert img tags to markdown (each on its own line)
          .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (match, srcUrl) => {
            const hasQuery = srcUrl.includes("?");
            const hinted = `${srcUrl}${hasQuery ? "&" : "?"}raycast-width=450`;
            return `\n![Image](${hinted})\n`;
          })
          // Convert headings
          .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "\n# $1\n")
          .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n## $1\n")
          .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n### $1\n")
          // Remove remaining HTML tags
          .replace(/<[^>]+>/g, "")
          // Clean up excessive whitespace
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        // Add footnote about scaled images
        const footnote = `\n\n---\n\n> Note: Images are scaled for performance. Open in Notes for full quality.`;

        // Save processed HTML to cache if hash provided (BEFORE deleting the file!)
        if (contentHash) {
          await saveToHashCache(contentHash, tempProcessedFile);
        }

        // Now we can safely delete the temp file
        unlinkSync(tempProcessedFile);

        return markdown + footnote;
      } catch (error) {
        // Clean up temp file on error
        try {
          unlinkSync(tempProcessedFile);
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    }

    // FLOW 2: Extremely large files (>500MB) - strip images, text only
    if (fileSizeInMB > 500) {
      debugLog("Extremely large file (>500MB), stripping images...");

      const tempCleanedFile = join(tmpdir(), `raycast-cleaned-${Date.now()}.html`);

      try {
        await stripImagesFromFileInChunks(filePath, tempCleanedFile);

        const cleanedStats = statSync(tempCleanedFile);
        const cleanedSizeInMB = cleanedStats.size / (1024 * 1024);

        if (cleanedSizeInMB > 5) {
          unlinkSync(tempCleanedFile);
          throw new Error(
            `This note is still too large after removing images (${cleanedSizeInMB.toFixed(1)}MB).\n\nPlease open it in the Apple Notes app.`,
          );
        }

        const cleanedHtml = readFileSync(tempCleanedFile, "utf-8");
        unlinkSync(tempCleanedFile);

        const nodeToMarkdown = new NodeHtmlMarkdown({
          keepDataImages: false,
          maxConsecutiveNewlines: 3,
        });

        return nodeToMarkdown.translate(cleanedHtml);
      } catch (error) {
        try {
          unlinkSync(tempCleanedFile);
        } catch {
          // Ignore cleanup errors
        }
        throw error;
      }
    }

    // FLOW 3: Small files (≤5MB) - in-memory processing
    const htmlContent = readFileSync(filePath, "utf-8");
    const markdown = await convertHtmlToMarkdownSafely(htmlContent);

    // Save original HTML to cache if hash provided (small files are fine as-is)
    if (contentHash) {
      await saveToHashCache(contentHash, filePath);
    }

    return markdown;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes("heap out of memory")) {
        throw new Error("This note exceeds Raycast's memory limits.\n\nPlease open it in the Apple Notes app instead.");
      }
      throw err;
    }
    throw new Error("Failed to process note content. Please open it in the Apple Notes app.");
  }
}

/**
 * Converts HTML content to Markdown with memory-safe settings
 * For small content, keeps images. For larger content, strips them.
 * @param htmlContent - The HTML content to convert
 * @returns Markdown string
 */
export async function convertHtmlToMarkdownSafely(htmlContent: string): Promise<string> {
  try {
    // Size check
    const contentSizeInMB = htmlContent.length / (1024 * 1024);

    if (contentSizeInMB > 15) {
      throw new Error(
        `This note is too large to process (${contentSizeInMB.toFixed(1)}MB).\n\nPlease open it directly in the Apple Notes app instead.`,
      );
    }

    cleanupTempImages();

    // For small notes (<3MB), extract images to files
    if (contentSizeInMB < 3) {
      debugLog(`Small note (${contentSizeInMB.toFixed(2)}MB), extracting images to files`);

      // Extract base64 images to temp files and replace with file:// URLs
      const htmlWithFileUrls = extractImagesToFiles(htmlContent);

      const nodeToMarkdown = new NodeHtmlMarkdown({
        keepDataImages: false, // No need, we're using file URLs
        maxConsecutiveNewlines: 3,
      });

      const markdown = nodeToMarkdown.translate(htmlWithFileUrls);

      // Clean up any text artifacts
      return markdown
        .replace(/IMAGEImage/gi, "")
        .replace(/PNGImage/gi, "")
        .replace(/JPEGImage/gi, "");
    }

    // For larger notes, strip images to prevent memory issues
    debugLog(`Larger note (${contentSizeInMB.toFixed(2)}MB), stripping images`);

    const cleanedHtml = stripLargeImagesFromHtml(htmlContent);

    const cleanedSizeInMB = cleanedHtml.length / (1024 * 1024);
    if (cleanedSizeInMB > 2) {
      throw new Error(
        `This note is still too large after removing images (${cleanedSizeInMB.toFixed(1)}MB).\n\nPlease open it in the Apple Notes app.`,
      );
    }

    const nodeToMarkdown = new NodeHtmlMarkdown({
      keepDataImages: false,
      maxConsecutiveNewlines: 3,
    });

    const markdown = nodeToMarkdown.translate(cleanedHtml);

    // Post-process to remove any remaining base64 strings that slipped through
    const cleanedMarkdown = markdown.replace(/[A-Za-z0-9+/]{100,}={0,2}/g, "*[Image data]*");

    return cleanedMarkdown;
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes("heap out of memory")) {
        throw new Error("This note exceeds Raycast's memory limits.\n\nPlease open it in the Apple Notes app instead.");
      }
      // Re-throw our custom errors
      throw err;
    }
    throw new Error("Failed to process note content. Please open it in the Apple Notes app.");
  }
}

/**
 * Saves processed HTML file to persistent cache
 * @param contentHash - MD5 hash of original content
 * @param processedHtmlPath - Path to processed HTML file with file:// URLs
 */
async function saveToHashCache(contentHash: string, processedHtmlPath: string): Promise<void> {
  try {
    const cacheDir = join(environment.supportPath, "note-cache");
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    const cachedHtmlPath = join(cacheDir, `${contentHash}.html`);
    copyFileSync(processedHtmlPath, cachedHtmlPath);

    // Update cache metadata with new file size
    const stats = statSync(cachedHtmlPath);
    incrementCacheMetadata(stats.size);

    debugLog(`💾 Saved processed HTML to cache: ${contentHash.substring(0, 8)}...`);

    // Cleanup old cache entries if needed (non-blocking)
    cleanupCacheIfNeeded().catch((err) => debugLog(`Cache cleanup failed: ${err}`));
  } catch (error) {
    debugLog(`Failed to save to hash cache: ${error}`);
    // Non-fatal - just log and continue
  }
}

/**
 * Cleans up old cache entries using LRU (Least Recently Used) strategy
 * Keeps total cache size under 75MB by deleting oldest files first
 */
async function cleanupCacheIfNeeded(): Promise<void> {
  try {
    const CACHE_LIMIT_MB = 75;
    const CACHE_LIMIT_BYTES = CACHE_LIMIT_MB * 1024 * 1024;

    // Quick check using metadata (instant!)
    let meta = readCacheMetadata();

    // If no metadata or very outdated (>7 days), recalculate
    if (!meta || new Date().getTime() - new Date(meta.lastUpdated).getTime() > 7 * 24 * 60 * 60 * 1000) {
      debugLog("📊 Recalculating cache metadata...");
      meta = recalculateCacheMetadata();
    }

    const totalSizeMB = meta.totalSize / (1024 * 1024);
    const totalSizeKB = meta.totalSize / 1024;
    const sizeDisplay = totalSizeMB < 1 ? `${totalSizeKB.toFixed(0)}KB` : `${totalSizeMB.toFixed(1)}MB`;

    debugLog(`📊 Cache size: ${sizeDisplay} (${meta.fileCount} files, limit: ${CACHE_LIMIT_MB}MB)`);

    if (meta.totalSize <= CACHE_LIMIT_BYTES) {
      return; // Under limit, no cleanup needed
    }

    debugLog(`🧹 Cache over limit, starting cleanup...`);

    const noteCacheDir = join(environment.supportPath, "note-cache");
    const imageCacheDir = join(environment.supportPath, "image-cache");

    if (!existsSync(noteCacheDir) && !existsSync(imageCacheDir)) {
      return;
    }

    // Collect all cache files with their metadata
    const cacheFiles: Array<{ path: string; size: number; mtime: Date; isImage: boolean }> = [];

    // Scan note cache
    if (existsSync(noteCacheDir)) {
      const noteFiles = readdirSync(noteCacheDir);
      for (const file of noteFiles) {
        if (!file.endsWith(".html")) continue;
        const filePath = join(noteCacheDir, file);
        try {
          const stats = statSync(filePath);
          cacheFiles.push({
            path: filePath,
            size: stats.size,
            mtime: stats.mtime,
            isImage: false,
          });
        } catch {
          // File might have been deleted, skip
        }
      }
    }

    // Scan image cache
    if (existsSync(imageCacheDir)) {
      const imageFiles = readdirSync(imageCacheDir);
      for (const file of imageFiles) {
        if (!file.endsWith(".jpg")) continue;
        const filePath = join(imageCacheDir, file);
        try {
          const stats = statSync(filePath);
          cacheFiles.push({
            path: filePath,
            size: stats.size,
            mtime: stats.mtime,
            isImage: true,
          });
        } catch {
          // File might have been deleted, skip
        }
      }
    }

    // Sort by modification time (oldest first)
    cacheFiles.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    // Delete oldest files until under limit
    let deletedSize = 0;
    let deletedCount = 0;
    const htmlHashesToDelete = new Set<string>();

    for (const file of cacheFiles) {
      if (meta.totalSize - deletedSize <= CACHE_LIMIT_BYTES) {
        break; // Reached target size
      }

      try {
        unlinkSync(file.path);
        deletedSize += file.size;
        deletedCount++;

        // If we deleted an HTML file, track its hash to delete orphaned images
        if (!file.isImage) {
          const fileName = file.path.split("/").pop() || "";
          const hash = fileName.replace(".html", "");
          htmlHashesToDelete.add(hash);
        }

        debugLog(`🗑️  Deleted old cache: ${file.path.split("/").pop()} (${(file.size / 1024).toFixed(1)}KB)`);
      } catch (err) {
        debugLog(`Failed to delete ${file.path}: ${err}`);
      }
    }

    // Delete orphaned images (images whose HTML was deleted)
    if (htmlHashesToDelete.size > 0 && existsSync(imageCacheDir)) {
      const allImages = readdirSync(imageCacheDir);
      for (const imageFile of allImages) {
        // Image files are named like: {hash}-img1.jpg, {hash}-img2.jpg
        const imageHash = imageFile.split("-")[0];
        if (htmlHashesToDelete.has(imageHash)) {
          try {
            const imagePath = join(imageCacheDir, imageFile);
            const stats = statSync(imagePath);
            unlinkSync(imagePath);
            deletedSize += stats.size;
            deletedCount++;
            debugLog(`🗑️  Deleted orphaned image: ${imageFile}`);
          } catch {
            // Ignore errors
          }
        }
      }
    }

    debugLog(
      `✨ Cache cleanup complete: deleted ${deletedCount} files, freed ${(deletedSize / (1024 * 1024)).toFixed(1)}MB`,
    );

    // Update metadata after cleanup
    meta.totalSize -= deletedSize;
    meta.fileCount -= deletedCount;
    meta.lastUpdated = new Date().toISOString();
    writeCacheMetadata(meta);
  } catch (error) {
    debugLog(`Cache cleanup error: ${error}`);
    // Non-fatal
  }
}
