import { promises as fs } from "node:fs";
import path from "node:path";
import {
  formatCorruptedArrayError,
  isPlainObject,
  parseMaybeJsonArray,
  type CorruptedItem,
} from "../utils/arg-validation.js";
import { MCP_CALL_BUDGET_SEC, runShellCommandAsync } from "../utils/exec-utils.js";
import { readTextFile, resolvePath, toPosixPath } from "../utils/fs-utils.js";
import {
  DEFAULT_INLINE_MAX_BYTES,
  formatCompactCommandOutput,
  sliceSafeChars,
  truncateWithByteNotice,
} from "../utils/output-filter.js";

export interface EditHunk {
  target: string;
  replacement: string;
  startLine?: number;
  endLine?: number;
  replaceAll?: boolean;
}

export interface FileEdit {
  path: string;
  hunks?: EditHunk[];
  create?: string;
  overwrite?: boolean;
  delete?: boolean;
  moveTo?: string;
}

export interface VerifySpec {
  command: string;
  cwd?: string;
  timeoutSec?: number;
}

export interface ApplyEditsInput {
  cwd?: string;
  /** A JSON array string of file edits, or the array itself. */
  edits: string | FileEdit[];
  dryRun?: boolean;
  bestEffort?: boolean;
  verify?: string | VerifySpec;
  verifyTimeoutSec?: number;
  maxVerifyChars?: number;
}

interface MatchSpan {
  start: number;
  end: number;
  replacement: string;
  hunkIndex: number;
}

interface PlannedWrite {
  kind: "write" | "delete" | "move";
  absPath: string;
  writeTargetPath: string;
  relPath: string;
  existed: boolean;
  originalBuffer: Buffer | null;
  originalMode: number | null;
  originalSymlinkTarget?: string | null;
  newContent: string | Buffer;
  hunkCount: number;
  lineDelta: number;
  created: boolean;
  destAbsPath?: string;
  destTargetPath?: string;
  destRelPath?: string;
  destExisted?: boolean;
  destOriginalBuffer?: Buffer | null;
  destOriginalMode?: number | null;
  destOriginalSymlinkTarget?: string | null;
  isCaseOnlyRename?: boolean;
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToLine(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= offset) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(1, hi + 1);
}

function getLineWindowOffsets(
  text: string,
  lineStarts: number[],
  startLine?: number,
  endLine?: number,
): { windowStart: number; windowEnd: number } {
  if (
    startLine !== undefined &&
    (typeof startLine !== "number" || !Number.isFinite(startLine) || startLine < 1)
  ) {
    throw new Error(`Invalid startLine: ${String(startLine)} (must be integer >= 1)`);
  }
  if (
    endLine !== undefined &&
    (typeof endLine !== "number" || !Number.isFinite(endLine) || endLine < 1)
  ) {
    throw new Error(`Invalid endLine: ${String(endLine)} (must be integer >= 1)`);
  }

  const totalLines = lineStarts.length;
  const sLine = startLine !== undefined ? Math.trunc(startLine) : 1;
  const eLine =
    endLine !== undefined ? Math.min(totalLines, Math.trunc(endLine)) : totalLines;

  if (sLine > totalLines) {
    return { windowStart: text.length, windowEnd: text.length };
  }
  if (eLine < sLine) {
    throw new Error(`Invalid line range: startLine (${sLine}) > endLine (${eLine})`);
  }

  const windowStart = lineStarts[sLine - 1]!;
  const windowEnd =
    eLine < totalLines ? lineStarts[eLine]! : text.length;
  return { windowStart, windowEnd };
}

const MAX_NEARBY_LINES = 26;

function formatNearbyLines(
  text: string,
  startLine?: number,
  endLine?: number,
): string {
  const lines = text.split("\n");
  if (startLine === undefined && endLine === undefined) return "";
  const from = Math.max(1, (startLine ?? endLine ?? 1) - 2);
  const rawTo = Math.min(lines.length, (endLine ?? startLine ?? 1) + 2);
  const truncated = rawTo - from + 1 > MAX_NEARBY_LINES;
  const to = truncated ? from + MAX_NEARBY_LINES - 1 : rawTo;
  const snippet: string[] = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = lines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`,
    );
  }
  const extra = truncated ? `\n    ... (${rawTo - to} more lines in range omitted)` : "";
  return `\n  Nearby lines (${from}-${to}):\n${snippet.join("\n")}${extra}`;
}

function extractLineTokens(trimmedLine: string): string[] {
  const tokens = trimmedLine.match(/[A-Za-z0-9_$]{3,}|[\u4e00-\u9fff]{2,}/g);
  if (tokens && tokens.length > 0) return tokens;
  return trimmedLine
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * Locate the closest matching region in the file (optionally bounded to a
 * 1-based line window) so the caller can fix a mismatched hunk immediately
 * without dumping an 80-line range or doing an extra read_file round-trip.
 */
function findClosestRegionSnippet(
  normalizedContent: string,
  normTarget: string,
  rangeStartLine?: number,
  rangeEndLine?: number,
): string {
  const fileLines = normalizedContent.split("\n");
  if (fileLines.length === 0) return "";

  const targetLines = normTarget
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (targetLines.length === 0) return "";

  const firstAnchor =
    targetLines.find((l) => l.length >= 6) ?? targetLines[0]!;
  let longestAnchor = targetLines[0]!;
  for (const tl of targetLines) {
    if (tl.length > longestAnchor.length) longestAnchor = tl;
  }
  const anchors = [firstAnchor];
  if (longestAnchor !== firstAnchor) anchors.push(longestAnchor);
  const lastAnchor = targetLines[targetLines.length - 1]!;
  if (lastAnchor.length >= 6 && !anchors.includes(lastAnchor)) {
    anchors.push(lastAnchor);
  }

  const primaryTokens = new Set(extractLineTokens(firstAnchor));
  const longestTokens = new Set(extractLineTokens(longestAnchor));
  const trimmedFileLines = fileLines.map((l) => l.trim());

  let bestIdx = -1;
  let bestScore = 0;

  const scanStart = Math.max(0, (rangeStartLine ?? 1) - 1);
  const scanEnd = Math.min(
    trimmedFileLines.length - 1,
    (rangeEndLine ?? trimmedFileLines.length) - 1,
  );

  for (let i = scanStart; i <= scanEnd; i++) {
    const line = trimmedFileLines[i]!;
    if (!line) continue;

    let score = 0;
    if (line === firstAnchor) {
      score += 10;
    } else if (firstAnchor.length >= 8 && (line.includes(firstAnchor) || firstAnchor.includes(line))) {
      score += 6;
    } else if (primaryTokens.size > 0) {
      const lineTokens = extractLineTokens(line);
      let hits = 0;
      for (const tok of lineTokens) {
        if (primaryTokens.has(tok)) hits += 1;
      }
      if (hits >= 2 || (hits >= 1 && primaryTokens.size <= 2 && hits === primaryTokens.size)) {
        score += 4 * (hits / primaryTokens.size);
      }
    }

    if (longestAnchor !== firstAnchor) {
      if (line === longestAnchor) {
        score += 8;
      } else if (longestAnchor.length >= 10 && line.includes(longestAnchor)) {
        score += 5;
      } else if (longestTokens.size >= 2) {
        const lineTokens = extractLineTokens(line);
        let hits = 0;
        for (const tok of lineTokens) {
          if (longestTokens.has(tok)) hits += 1;
        }
        if (hits >= 2) {
          score += 3 * (hits / longestTokens.size);
        }
      }
    }

    // Bonus when nearby subsequent lines also match subsequent target lines
    if (score >= 2 && targetLines.length > 1) {
      const lookahead = Math.min(targetLines.length, 6);
      for (let k = 1; k < lookahead && i + k < trimmedFileLines.length; k++) {
        const nextLine = trimmedFileLines[i + k]!;
        const tgtLine = targetLines[k]!;
        if (nextLine && tgtLine && (nextLine === tgtLine || (tgtLine.length >= 8 && nextLine.includes(tgtLine)))) {
          score += 3;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < 2.5) return "";

  const span = Math.min(Math.max(targetLines.length, 4), 8);
  const from = Math.max(1, bestIdx + 1 - 2);
  const to = Math.min(fileLines.length, Math.min(from + 13, bestIdx + 1 + span + 2));
  const snippet: string[] = [];
  for (let ln = from; ln <= to; ln++) {
    const lineText = fileLines[ln - 1] ?? "";
    snippet.push(
      `    ${ln}: ${lineText.length > 160 ? `${sliceSafeChars(lineText, 157)}...` : lineText}`,
    );
  }
  return `\n  Closest match near line ${bestIdx + 1} (lines ${from}-${to}):\n${snippet.join("\n")}`;
}

function planHunksForContent(
  normalizedContent: string,
  hunks: EditHunk[],
  displayPath: string,
): { newNormalized: string; appliedMatches: number; errors: string[] } {
  const lineStarts = computeLineStarts(normalizedContent);
  const spans: MatchSpan[] = [];
  const errors: string[] = [];

  for (let idx = 0; idx < hunks.length; idx++) {
    const hunk = hunks[idx];
    if (!isPlainObject(hunk)) {
      errors.push(`${displayPath} hunk #${idx + 1}: must be an object with 'target' and 'replacement'`);
      continue;
    }
    if (typeof hunk.target !== "string" || hunk.target.length === 0) {
      errors.push(`${displayPath} hunk #${idx + 1}: 'target' must be a non-empty string`);
      continue;
    }
    if (typeof hunk.replacement !== "string") {
      errors.push(`${displayPath} hunk #${idx + 1}: 'replacement' must be a string`);
      continue;
    }

    const normTarget = hunk.target.replace(/\r\n/g, "\n");
    const normReplacement = hunk.replacement.replace(/\r\n/g, "\n");

    let windowStart = 0;
    let windowEnd = normalizedContent.length;
    try {
      const win = getLineWindowOffsets(
        normalizedContent,
        lineStarts,
        hunk.startLine,
        hunk.endLine,
      );
      windowStart = win.windowStart;
      windowEnd = win.windowEnd;
    } catch (err) {
      errors.push(
        `${displayPath} hunk #${idx + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const foundOffsets: number[] = [];
    let pos = windowStart;
    while (pos <= windowEnd - normTarget.length) {
      const found = normalizedContent.indexOf(normTarget, pos);
      if (found === -1 || found + normTarget.length > windowEnd) break;
      foundOffsets.push(found);
      pos = found + Math.max(1, normTarget.length);
    }

    if (foundOffsets.length === 0) {
      const hasRange = hunk.startLine !== undefined || hunk.endLine !== undefined;
      const rangeNote = hasRange
        ? ` within lines ${hunk.startLine ?? 1}-${hunk.endLine ?? lineStarts.length}`
        : "";
      let hint = "";
      if (hasRange) {
        // Check if exact target exists outside the provided line window (line drift)
        const globalOffsets: number[] = [];
        let gPos = 0;
        while (
          gPos <= normalizedContent.length - normTarget.length &&
          globalOffsets.length < 5
        ) {
          const found = normalizedContent.indexOf(normTarget, gPos);
          if (found === -1) break;
          globalOffsets.push(found);
          gPos = found + Math.max(1, normTarget.length);
        }
        if (globalOffsets.length > 0) {
          const hitLines = globalOffsets
            .map((o) => `L${offsetToLine(lineStarts, o)}`)
            .join(", ");
          hint = ` Exact match found outside range at ${hitLines} — adjust startLine/endLine or omit them.`;
        } else {
          const effStart = hunk.startLine ?? 1;
          const effEnd = hunk.endLine ?? lineStarts.length;
          if (effEnd - effStart + 1 > MAX_NEARBY_LINES - 4) {
            hint =
              findClosestRegionSnippet(normalizedContent, normTarget, effStart, effEnd) ||
              findClosestRegionSnippet(normalizedContent, normTarget) ||
              formatNearbyLines(normalizedContent, effStart, effEnd);
          } else {
            hint = formatNearbyLines(normalizedContent, hunk.startLine, hunk.endLine);
          }
        }
      } else {
        hint = findClosestRegionSnippet(normalizedContent, normTarget);
      }
      errors.push(
        `${displayPath} hunk #${idx + 1}: target text not found${rangeNote}.${hint}`,
      );
      continue;
    }

    if (foundOffsets.length > 1 && !hunk.replaceAll) {
      const lines = foundOffsets
        .slice(0, 10)
        .map((o) => offsetToLine(lineStarts, o))
        .join(", ");
      errors.push(
        `${displayPath} hunk #${idx + 1}: target matched ${foundOffsets.length} times (lines: ${lines}). Provide startLine/endLine, more surrounding context, or set replaceAll: true.`,
      );
      continue;
    }

    for (const start of foundOffsets) {
      spans.push({
        start,
        end: start + normTarget.length,
        replacement: normReplacement,
        hunkIndex: idx,
      });
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!;
    const curr = spans[i]!;
    if (curr.start < prev.end) {
      const line = offsetToLine(lineStarts, curr.start);
      errors.push(
        `${displayPath}: hunk #${prev.hunkIndex + 1} and hunk #${curr.hunkIndex + 1} overlap near line ${line}.`,
      );
    }
  }

  if (errors.length > 0) {
    return { newNormalized: normalizedContent, appliedMatches: 0, errors };
  }

  const pieces: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    pieces.push(normalizedContent.slice(cursor, span.start));
    pieces.push(span.replacement);
    cursor = span.end;
  }
  pieces.push(normalizedContent.slice(cursor));

  return {
    newNormalized: pieces.join(""),
    appliedMatches: spans.length,
    errors: [],
  };
}

function countLines(text: string): number {
  if (!text) return 0;
  const end = text.endsWith("\n") ? text.length - 1 : text.length;
  if (end === 0) return 1;
  let count = 1;
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

async function writeContentAtomic(
  target: string,
  content: string | Buffer,
  originalMode: number | null,
  originalSymlinkTarget?: string | null,
  onTargetTouched?: () => void,
): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${target}.agy-fast-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (Buffer.isBuffer(content)) {
      await fs.writeFile(tmpPath, content);
    } else {
      await fs.writeFile(tmpPath, content, "utf8");
    }
    if (originalMode !== null && process.platform !== "win32") {
      await fs.chmod(tmpPath, originalMode);
    }
  } catch (tmpErr) {
    await fs.unlink(tmpPath).catch(() => {});
    throw tmpErr;
  }

  onTargetTouched?.();
  try {
    await fs.rename(tmpPath, target);
  } catch {
    // Fallback if rename across filesystems or directory permissions fails
    await fs.unlink(tmpPath).catch(() => {});
    if (originalSymlinkTarget) {
      await fs.unlink(target).catch(() => {});
    }
    if (Buffer.isBuffer(content)) {
      await fs.writeFile(target, content);
    } else {
      await fs.writeFile(target, content, "utf8");
    }
    if (originalMode !== null && process.platform !== "win32") {
      await fs.chmod(target, originalMode).catch(() => {});
    }
  }
}

async function commitPlannedWrites(plans: PlannedWrite[]): Promise<void> {
  const written: PlannedWrite[] = [];

  try {
    for (const plan of plans) {
      if (plan.kind === "delete") {
        written.push(plan);
        await fs.unlink(plan.writeTargetPath);
        continue;
      }

      if (plan.kind === "move") {
        const dest = plan.destTargetPath!;
        if (plan.isCaseOnlyRename) {
          written.push(plan);
          // Two-step hop via temp name so case-insensitive filesystems (Windows/macOS) update casing cleanly
          const hopPath = `${dest}.agy-fast-hop-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          await fs.rename(plan.writeTargetPath, hopPath);
          try {
            if (plan.hunkCount > 0) {
              if (Buffer.isBuffer(plan.newContent)) {
                await fs.writeFile(hopPath, plan.newContent);
              } else {
                await fs.writeFile(hopPath, plan.newContent, "utf8");
              }
            }
            await fs.rename(hopPath, dest);
          } catch (hopErr) {
            await fs.rename(hopPath, plan.writeTargetPath).catch(() => {});
            throw hopErr;
          }
        } else {
          await writeContentAtomic(
            dest,
            plan.newContent,
            plan.originalMode,
            plan.destOriginalSymlinkTarget,
            () => written.push(plan),
          );
          await fs.unlink(plan.writeTargetPath);
        }
        continue;
      }

      // Standard write (create or hunks)
      await writeContentAtomic(
        plan.writeTargetPath,
        plan.newContent,
        plan.originalMode,
        plan.originalSymlinkTarget,
        () => written.push(plan),
      );
    }
  } catch (err) {
    // Rollback all previously applied operations in reverse order
    for (let i = written.length - 1; i >= 0; i--) {
      const item = written[i]!;
      const target = item.writeTargetPath;
      try {
        if (item.kind === "delete") {
          if (item.originalSymlinkTarget) {
            await fs.unlink(target).catch(() => {});
            await fs.symlink(item.originalSymlinkTarget, target);
          } else if (item.originalBuffer !== null) {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, item.originalBuffer);
            if (item.originalMode !== null && process.platform !== "win32") {
              await fs.chmod(target, item.originalMode);
            }
          }
        } else if (item.kind === "move") {
          const dest = item.destTargetPath!;
          if (item.isCaseOnlyRename) {
            const hopPath = `${target}.agy-fast-rb-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await fs.rename(dest, hopPath).catch(() => {});
            await fs.rename(hopPath, target).catch(() => {});
            if (item.originalBuffer !== null) {
              await fs.writeFile(target, item.originalBuffer);
              if (item.originalMode !== null && process.platform !== "win32") {
                await fs.chmod(target, item.originalMode);
              }
            }
          } else {
            // Restore source
            if (item.originalSymlinkTarget) {
              await fs.unlink(target).catch(() => {});
              await fs.symlink(item.originalSymlinkTarget, target);
            } else if (item.originalBuffer !== null) {
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.writeFile(target, item.originalBuffer);
              if (item.originalMode !== null && process.platform !== "win32") {
                await fs.chmod(target, item.originalMode);
              }
            }
            // Restore or remove destination
            if (item.destOriginalSymlinkTarget) {
              await fs.unlink(dest).catch(() => {});
              await fs.symlink(item.destOriginalSymlinkTarget, dest);
            } else if (item.destExisted && item.destOriginalBuffer !== null && item.destOriginalBuffer !== undefined) {
              await fs.writeFile(dest, item.destOriginalBuffer);
              if (item.destOriginalMode !== null && item.destOriginalMode !== undefined && process.platform !== "win32") {
                await fs.chmod(dest, item.destOriginalMode);
              }
            } else if (!item.destExisted) {
              await fs.unlink(dest).catch(() => {});
            }
          }
        } else {
          if (item.originalSymlinkTarget) {
            await fs.unlink(target).catch(() => {});
            await fs.symlink(item.originalSymlinkTarget, target);
          } else if (item.existed && item.originalBuffer !== null) {
            await fs.writeFile(target, item.originalBuffer);
            if (item.originalMode !== null && process.platform !== "win32") {
              await fs.chmod(target, item.originalMode);
            }
          } else if (!item.existed) {
            await fs.unlink(target).catch(() => {});
          }
        }
      } catch {
        // Best-effort rollback
      }
    }
    throw err;
  }
}

function corruptedEditsError(items: CorruptedItem[]): { text: string; isError: boolean } {
  return {
    text: formatCorruptedArrayError({
      header: "Validation failed (0 files modified)",
      toolName: "apply_edits",
      items,
      fallbackAdvice:
        "immediately fall back to parallel built-in edit_file / write_file calls for these file(s).",
    }),
    isError: true,
  };
}

export async function runApplyEdits(
  input: ApplyEditsInput,
): Promise<{ text: string; isError: boolean }> {
  const parsedEdits = parseMaybeJsonArray(input?.edits);
  if (!parsedEdits.ok) {
    if (
      parsedEdits.kind === "corrupted_literal" ||
      (parsedEdits.kind === "wrong_type" &&
        (typeof input?.edits === "boolean" || input?.edits === null))
    ) {
      return corruptedEditsError([
        {
          label: "edits",
          value: parsedEdits.kind === "corrupted_literal" ? parsedEdits.value : input.edits,
          expected: "an array of edit objects",
        },
      ]);
    }
    if (parsedEdits.kind === "invalid_json") {
      return {
        text: `Error: 'edits' is not a valid JSON array (0 files modified): ${parsedEdits.detail}`,
        isError: true,
      };
    }
    return {
      text: "Error: 'edits' must be a non-empty JSON array string (or array) of file edit objects.",
      isError: true,
    };
  }
  const rawEdits = parsedEdits.value;
  // A model never means to send zero edits; on agy CLI 1.5.x a long native
  // array of edit objects can reach the server as [] with the payload lost.
  if (rawEdits.length === 0) {
    return corruptedEditsError([
      { label: "edits", value: rawEdits, expected: "a non-empty array of edit objects" },
    ]);
  }
  if (rawEdits.length > 50) {
    return {
      text: "Error: 'edits' supports at most 50 file entries per call.",
      isError: true,
    };
  }

  // Detect nested-JSON serialization corruption (e.g. edits: [true], [false, true], [null], or hunks: [true])
  // before regular validation so the caller immediately falls back instead of retrying in a loop.
  const corruptedItems: CorruptedItem[] = [];
  const normalizedEdits: FileEdit[] = [];
  for (let i = 0; i < rawEdits.length; i++) {
    const rawEntry = rawEdits[i];
    if (!isPlainObject(rawEntry)) {
      corruptedItems.push({ label: `edits[${i}]`, value: rawEntry, expected: "an edit object" });
      continue;
    }
    let normalizedHunks: EditHunk[] | undefined;
    if (rawEntry.hunks !== undefined) {
      const parsedHunks = parseMaybeJsonArray(rawEntry.hunks);
      if (!parsedHunks.ok) {
        corruptedItems.push({
          label: `edits[${i}].hunks`,
          value: parsedHunks.kind === "corrupted_literal" ? parsedHunks.value : rawEntry.hunks,
          expected: "an array of hunk objects",
        });
        continue;
      }
      let hunkCorrupted = false;
      for (let j = 0; j < parsedHunks.value.length; j++) {
        if (!isPlainObject(parsedHunks.value[j])) {
          corruptedItems.push({
            label: `edits[${i}].hunks[${j}]`,
            value: parsedHunks.value[j],
            expected: "a hunk object",
          });
          hunkCorrupted = true;
        }
      }
      if (hunkCorrupted) continue;
      normalizedHunks = parsedHunks.value as unknown as EditHunk[];
    }
    normalizedEdits.push({
      path: rawEntry.path as string,
      hunks: normalizedHunks,
      create: rawEntry.create as string | undefined,
      overwrite: rawEntry.overwrite as boolean | undefined,
      delete: rawEntry.delete as boolean | undefined,
      moveTo: rawEntry.moveTo as string | undefined,
    });
  }
  if (corruptedItems.length > 0) {
    return corruptedEditsError(corruptedItems);
  }

  // Validate optional verify spec up front before touching any files on disk
  let validatedVerify: VerifySpec | null = null;
  if (input.verify !== undefined) {
    if (typeof input.verify === "string") {
      if (input.verify.trim()) {
        validatedVerify = { command: input.verify };
      }
    } else if (isPlainObject(input.verify)) {
      const cmd = input.verify.command;
      if (typeof cmd !== "string" || !cmd.trim()) {
        return {
          text: "Validation failed (0 files modified):\n- 'verify.command' must be a non-empty string.",
          isError: true,
        };
      }
      if (input.verify.cwd !== undefined && typeof input.verify.cwd !== "string") {
        return {
          text: "Validation failed (0 files modified):\n- 'verify.cwd' must be a string.",
          isError: true,
        };
      }
      const rawSpecTimeout = input.verify.timeoutSec as unknown;
      const parsedSpecTimeout =
        (typeof rawSpecTimeout === "number" ||
          (typeof rawSpecTimeout === "string" && rawSpecTimeout.trim() !== ""))
          ? Number(rawSpecTimeout)
          : undefined;
      validatedVerify = {
        command: cmd,
        cwd: input.verify.cwd,
        timeoutSec:
          parsedSpecTimeout !== undefined && Number.isFinite(parsedSpecTimeout)
            ? parsedSpecTimeout
            : undefined,
      };
    } else {
      return {
        text: "Validation failed (0 files modified):\n- 'verify' must be a command string or { command, cwd?, timeoutSec? } object.",
        isError: true,
      };
    }
  }

  const baseCwd = resolvePath(input.cwd || process.cwd());
  const isCaseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";
  const pathKey = (p: string) => (isCaseInsensitiveFs ? p.toLowerCase() : p);

  // Merge entries targeting the same resolved file (including symlink aliases and symlinked parent dirs)
  const mergedByPath = new Map<
    string,
    {
      absPath: string;
      writeTargetPath: string;
      relPath: string;
      create?: string;
      overwrite?: boolean;
      delete?: boolean;
      moveTo?: string;
      hunks: EditHunk[];
    }
  >();
  const errors: string[] = [];

  for (let i = 0; i < normalizedEdits.length; i++) {
    const entry = normalizedEdits[i]!;
    if (typeof entry.path !== "string" || !entry.path.trim()) {
      errors.push(`edits[${i}]: 'path' must be a non-empty string`);
      continue;
    }
    if (entry.delete !== undefined && typeof entry.delete !== "boolean") {
      errors.push(`edits[${i}]: 'delete' must be a boolean`);
      continue;
    }
    if (entry.moveTo !== undefined && (typeof entry.moveTo !== "string" || !entry.moveTo.trim())) {
      errors.push(`edits[${i}]: 'moveTo' must be a non-empty string path`);
      continue;
    }

    const absPath = resolvePath(entry.path, baseCwd);
    const hasDelete = entry.delete === true;
    const hasMoveTo = typeof entry.moveTo === "string" && entry.moveTo.trim().length > 0;
    const hasCreate = typeof entry.create === "string";
    const hasHunks = Array.isArray(entry.hunks) && entry.hunks.length > 0;

    let writeTargetPath = absPath;
    let isSourceSymlink = false;
    try {
      const lst = await fs.lstat(absPath);
      isSourceSymlink = lst.isSymbolicLink();
    } catch {
      // ignore
    }
    if (hasDelete && isSourceSymlink) {
      // Delete the symlink itself rather than its target; canonicalize parent dir only
      try {
        const realParent = await fs.realpath(path.dirname(absPath));
        writeTargetPath = path.join(realParent, path.basename(absPath));
      } catch {
        // keep absPath
      }
    } else {
      try {
        // Canonicalize existing paths (including symlinks and symlinked parent dirs like /var -> /private/var)
        writeTargetPath = await fs.realpath(absPath);
      } catch {
        // File does not exist yet or dangling symlink — still canonicalize existing parent dir
        // so `sym_dir/new.ts` and `real_dir/new.ts` deduplicate cleanly.
        try {
          const realParent = await fs.realpath(path.dirname(absPath));
          writeTargetPath = path.join(realParent, path.basename(absPath));
        } catch {
          // Parent directory does not exist yet — keep absPath
        }
      }
    }

    const relPath = toPosixPath(path.relative(baseCwd, absPath)) || path.basename(absPath);

    if (!hasCreate && !hasHunks && !hasDelete && !hasMoveTo) {
      errors.push(`${relPath}: must specify 'hunks', 'create', 'delete: true', or 'moveTo'`);
      continue;
    }
    if (hasDelete && (hasCreate || hasHunks || hasMoveTo)) {
      errors.push(`${relPath}: 'delete' cannot be combined with 'create', 'hunks', or 'moveTo'`);
      continue;
    }
    if (hasCreate && (hasHunks || hasMoveTo)) {
      errors.push(`${relPath}: cannot specify both 'create' and '${hasHunks ? "hunks" : "moveTo"}' on the same entry`);
      continue;
    }

    const existing = mergedByPath.get(writeTargetPath);
    if (!existing) {
      mergedByPath.set(writeTargetPath, {
        absPath,
        writeTargetPath,
        relPath,
        create: hasCreate ? entry.create : undefined,
        overwrite: entry.overwrite,
        delete: hasDelete ? true : undefined,
        moveTo: hasMoveTo ? entry.moveTo!.trim() : undefined,
        hunks: hasHunks ? [...entry.hunks!] : [],
      });
    } else {
      if (hasCreate || existing.create !== undefined || hasDelete || existing.delete) {
        errors.push(`${relPath}: duplicate entries cannot mix 'create' or 'delete' with other edits`);
        continue;
      }
      if (hasMoveTo) {
        if (existing.moveTo && existing.moveTo !== entry.moveTo!.trim()) {
          errors.push(`${relPath}: conflicting 'moveTo' destinations on duplicate entries`);
          continue;
        }
        existing.moveTo = entry.moveTo!.trim();
        if (entry.overwrite !== undefined) existing.overwrite = entry.overwrite;
      }
      if (hasHunks) {
        existing.hunks.push(...entry.hunks!);
      }
    }
  }

  if (errors.length > 0) {
    return {
      text: `Validation failed (0 files modified):\n- ${errors.join("\n- ")}`,
      isError: true,
    };
  }

  // Track claimed move destination paths to catch cross-entry collisions in Phase 1
  const claimedDestinations = new Set<string>();

  // Phase 1: validate and plan every file in memory
  const plans: PlannedWrite[] = [];
  for (const item of mergedByPath.values()) {
    // 1. Delete existing file (or symlink)
    if (item.delete) {
      let originalBuffer: Buffer | null = null;
      let originalMode: number | null = null;
      let originalSymlinkTarget: string | null = null;
      try {
        const lst = await fs.lstat(item.writeTargetPath);
        if (lst.isSymbolicLink()) {
          originalSymlinkTarget = await fs.readlink(item.writeTargetPath);
        } else if (lst.isDirectory()) {
          errors.push(`${item.relPath}: cannot delete a directory`);
          continue;
        } else {
          originalMode = lst.mode & 0o7777;
          originalBuffer = await fs.readFile(item.writeTargetPath);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          errors.push(`${item.relPath}: file does not exist`);
        } else {
          errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }

      plans.push({
        kind: "delete",
        absPath: item.absPath,
        writeTargetPath: item.writeTargetPath,
        relPath: item.relPath,
        existed: true,
        originalBuffer,
        originalMode,
        originalSymlinkTarget,
        newContent: "",
        hunkCount: 0,
        lineDelta: 0,
        created: false,
      });
      continue;
    }

    // 2. Move file (optionally applying hunks atomically during the move)
    if (item.moveTo !== undefined) {
      const destAbsPath = resolvePath(item.moveTo, baseCwd);
      let destTargetPath = destAbsPath;
      try {
        const realDestParent = await fs.realpath(path.dirname(destAbsPath));
        destTargetPath = path.join(realDestParent, path.basename(destAbsPath));
      } catch {
        // Destination parent directory does not exist yet
      }
      const destRelPath = toPosixPath(path.relative(baseCwd, destAbsPath)) || path.basename(destAbsPath);

      if (destTargetPath === item.writeTargetPath) {
        errors.push(`${item.relPath}: 'moveTo' destination is the same as source path`);
        continue;
      }

      const isCaseOnlyRename =
        isCaseInsensitiveFs &&
        path.dirname(item.writeTargetPath).toLowerCase() === path.dirname(destTargetPath).toLowerCase() &&
        path.basename(item.writeTargetPath).toLowerCase() === path.basename(destTargetPath).toLowerCase() &&
        path.basename(item.writeTargetPath) !== path.basename(destTargetPath);

      const destKey = pathKey(destTargetPath);
      if (claimedDestinations.has(destKey)) {
        errors.push(`${item.relPath}: multiple entries target the same destination '${destRelPath}'`);
        continue;
      }
      if (!isCaseOnlyRename) {
        let collidesWithOtherSource = false;
        for (const other of mergedByPath.values()) {
          if (other !== item && pathKey(other.writeTargetPath) === destKey && !other.delete && !other.moveTo) {
            collidesWithOtherSource = true;
            break;
          }
        }
        if (collidesWithOtherSource) {
          errors.push(`${item.relPath}: 'moveTo' destination '${destRelPath}' collides with another edit in the same batch`);
          continue;
        }
      }

      // Inspect destination (skip collision check on case-only rename of the same file)
      let destExisted = false;
      let destOriginalBuffer: Buffer | null = null;
      let destOriginalMode: number | null = null;
      let destOriginalSymlinkTarget: string | null = null;
      if (!isCaseOnlyRename) {
        try {
          const destLst = await fs.lstat(destTargetPath);
          if (destLst.isSymbolicLink()) {
            try {
              const destSt = await fs.stat(destTargetPath);
              if (destSt.isDirectory()) {
                errors.push(`${item.relPath}: destination '${destRelPath}' is a directory`);
                continue;
              }
              destExisted = true;
              if (!item.overwrite) {
                errors.push(
                  `${item.relPath}: destination '${destRelPath}' already exists (set overwrite: true to replace it)`,
                );
                continue;
              }
              destOriginalMode = destSt.mode & 0o7777;
              destOriginalBuffer = await fs.readFile(destTargetPath);
            } catch (statErr) {
              if ((statErr as NodeJS.ErrnoException)?.code === "ENOENT") {
                destExisted = true;
                if (!item.overwrite) {
                  errors.push(
                    `${item.relPath}: destination '${destRelPath}' is a dangling symlink (set overwrite: true to replace it)`,
                  );
                  continue;
                }
                destOriginalSymlinkTarget = await fs.readlink(destTargetPath);
              } else {
                errors.push(`${item.relPath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`);
                continue;
              }
            }
          } else if (destLst.isDirectory()) {
            errors.push(`${item.relPath}: destination '${destRelPath}' is a directory`);
            continue;
          } else {
            destExisted = true;
            if (!item.overwrite) {
              errors.push(
                `${item.relPath}: destination '${destRelPath}' already exists (set overwrite: true to replace it)`,
              );
              continue;
            }
            destOriginalMode = destLst.mode & 0o7777;
            destOriginalBuffer = await fs.readFile(destTargetPath);
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
            errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
      }

      // Read source (text+hunks when hunks provided; raw Buffer for binary-safe pure moves)
      if (item.hunks.length > 0) {
        let fileData;
        try {
          fileData = await readTextFile(item.writeTargetPath);
        } catch (err) {
          errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const normalizedOriginal = fileData.content.replace(/\r\n/g, "\n");
        const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
        if (planned.errors.length > 0) {
          errors.push(...planned.errors);
          continue;
        }
        const finalContent =
          fileData.eol === "\r\n"
            ? planned.newNormalized.replace(/\n/g, "\r\n")
            : planned.newNormalized;
        const lineDelta = countLines(planned.newNormalized) - countLines(normalizedOriginal);
        claimedDestinations.add(destKey);
        plans.push({
          kind: "move",
          absPath: item.absPath,
          writeTargetPath: item.writeTargetPath,
          relPath: item.relPath,
          existed: true,
          originalBuffer: fileData.rawBuffer,
          originalMode: fileData.mode,
          newContent: finalContent,
          hunkCount: planned.appliedMatches,
          lineDelta,
          created: false,
          destAbsPath,
          destTargetPath,
          destRelPath,
          destExisted,
          destOriginalBuffer,
          destOriginalMode,
          destOriginalSymlinkTarget,
          isCaseOnlyRename,
        });
      } else {
        let originalBuffer: Buffer;
        let originalMode: number | null = null;
        try {
          const st = await fs.stat(item.writeTargetPath);
          if (st.isDirectory()) {
            errors.push(`${item.relPath}: cannot move a directory`);
            continue;
          }
          originalMode = st.mode & 0o7777;
          originalBuffer = await fs.readFile(item.writeTargetPath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            errors.push(`${item.relPath}: file does not exist`);
          } else {
            errors.push(`${item.relPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
          continue;
        }
        claimedDestinations.add(destKey);
        plans.push({
          kind: "move",
          absPath: item.absPath,
          writeTargetPath: item.writeTargetPath,
          relPath: item.relPath,
          existed: true,
          originalBuffer,
          originalMode,
          newContent: originalBuffer,
          hunkCount: 0,
          lineDelta: 0,
          created: false,
          destAbsPath,
          destTargetPath,
          destRelPath,
          destExisted,
          destOriginalBuffer,
          destOriginalMode,
          destOriginalSymlinkTarget,
          isCaseOnlyRename,
        });
      }
      continue;
    }

    // 3. Create / overwrite file
    if (item.create !== undefined) {
      let exists = false;
      let originalBuffer: Buffer | null = null;
      let originalMode: number | null = null;
      let originalSymlinkTarget: string | null = null;
      try {
        const lst = await fs.lstat(item.writeTargetPath);
        if (lst.isSymbolicLink()) {
          try {
            const st = await fs.stat(item.writeTargetPath);
            if (st.isDirectory()) {
              errors.push(`${item.relPath}: target path is a directory`);
              continue;
            }
            exists = true;
            if (!item.overwrite) {
              errors.push(
                `${item.relPath}: file already exists (set overwrite: true to replace it)`,
              );
              continue;
            }
            originalMode = st.mode & 0o7777;
            originalBuffer = await fs.readFile(item.writeTargetPath);
          } catch (statErr) {
            if ((statErr as NodeJS.ErrnoException)?.code === "ENOENT") {
              // Dangling symlink: never clobber without overwrite: true, and preserve target for rollback
              exists = true;
              if (!item.overwrite) {
                errors.push(
                  `${item.relPath}: dangling symlink already exists (set overwrite: true to replace it)`,
                );
                continue;
              }
              originalSymlinkTarget = await fs.readlink(item.writeTargetPath);
            } else {
              errors.push(
                `${item.relPath}: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
              );
              continue;
            }
          }
        } else {
          const st = await fs.stat(item.writeTargetPath);
          if (st.isDirectory()) {
            errors.push(`${item.relPath}: target path is a directory`);
            continue;
          }
          exists = true;
          if (!item.overwrite) {
            errors.push(
              `${item.relPath}: file already exists (set overwrite: true to replace it)`,
            );
            continue;
          }
          originalMode = st.mode & 0o7777;
          originalBuffer = await fs.readFile(item.writeTargetPath);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          exists = false;
          originalBuffer = null;
          originalMode = null;
        } else {
          errors.push(
            `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
      }

      const oldLines = originalBuffer ? countLines(originalBuffer.toString("utf8")) : 0;
      const newLines = countLines(item.create);
      plans.push({
        kind: "write",
        absPath: item.absPath,
        writeTargetPath: item.writeTargetPath,
        relPath: item.relPath,
        existed: exists,
        originalBuffer,
        originalMode,
        originalSymlinkTarget,
        newContent: item.create,
        hunkCount: 1,
        lineDelta: newLines - oldLines,
        created: !exists,
      });
      continue;
    }

    // 4. Existing file hunks
    let fileData;
    try {
      fileData = await readTextFile(item.writeTargetPath);
    } catch (err) {
      errors.push(
        `${item.relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const normalizedOriginal = fileData.content.replace(/\r\n/g, "\n");
    const planned = planHunksForContent(normalizedOriginal, item.hunks, item.relPath);
    if (planned.errors.length > 0) {
      errors.push(...planned.errors);
      continue;
    }

    const finalContent =
      fileData.eol === "\r\n"
        ? planned.newNormalized.replace(/\n/g, "\r\n")
        : planned.newNormalized;

    const lineDelta =
      countLines(planned.newNormalized) - countLines(normalizedOriginal);

    plans.push({
      kind: "write",
      absPath: item.absPath,
      writeTargetPath: item.writeTargetPath,
      relPath: item.relPath,
      existed: true,
      originalBuffer: fileData.rawBuffer,
      originalMode: fileData.mode,
      newContent: finalContent,
      hunkCount: planned.appliedMatches,
      lineDelta,
      created: false,
    });
  }

  const bestEffort = Boolean(input.bestEffort);

  if (errors.length > 0 && (!bestEffort || plans.length === 0)) {
    const prefix = bestEffort
      ? "Edit aborted (0 files modified):"
      : "Atomic edit aborted (0 files modified):";
    return {
      text: truncateWithByteNotice(
        `${prefix}\n- ${errors.join("\n- ")}`,
        DEFAULT_INLINE_MAX_BYTES,
      ),
      isError: true,
    };
  }

  // Phase 2: write valid planned files (unless dryRun)
  if (!input.dryRun) {
    try {
      await commitPlannedWrites(plans);
    } catch (err) {
      return {
        text: `Write failed (changes rolled back): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }

  const summaryLines = plans.map((p) => {
    if (p.kind === "delete") {
      return `- ${p.relPath}: deleted`;
    }
    if (p.kind === "move") {
      if (p.hunkCount > 0) {
        const deltaStr = p.lineDelta >= 0 ? `+${p.lineDelta}` : `${p.lineDelta}`;
        return `- ${p.relPath} -> ${p.destRelPath}: moved & updated (${p.hunkCount} match${p.hunkCount === 1 ? "" : "es"}), lines ${deltaStr}`;
      }
      return `- ${p.relPath} -> ${p.destRelPath}: moved`;
    }
    const deltaStr = p.lineDelta >= 0 ? `+${p.lineDelta}` : `${p.lineDelta}`;
    const action = p.created
      ? "created"
      : `updated (${p.hunkCount} match${p.hunkCount === 1 ? "" : "es"})`;
    return `- ${p.relPath}: ${action}, lines ${deltaStr}`;
  });

  if (bestEffort && errors.length > 0) {
    const totalFiles = mergedByPath.size;
    const failedFileCount = Math.max(1, totalFiles - plans.length);
    const partialHeader = input.dryRun
      ? `Partial dry-run (${plans.length}/${totalFiles} file(s) valid; ${failedFileCount} file(s) failed):`
      : `Partial edit applied (${plans.length}/${totalFiles} file(s) written; ${failedFileCount} file(s) failed — do NOT re-send applied files):`;
    const partialParts = [
      partialHeader,
      `Applied:\n${summaryLines.join("\n")}`,
      `Failed (fix only these):\n- ${errors.join("\n- ")}`,
    ];
    if (!input.dryRun && input.verify) {
      partialParts.push(
        "Verify skipped because failed file(s) remain; fix only the failed file(s) and re-run verify.",
      );
    }
    return {
      text: truncateWithByteNotice(
        partialParts.join("\n\n"),
        DEFAULT_INLINE_MAX_BYTES,
      ),
      isError: true,
    };
  }

  const header = input.dryRun
    ? `Dry run validated ${plans.length} file(s) (0 files modified):`
    : `Applied edits to ${plans.length} file(s):`;
  const parts = [`${header}\n${summaryLines.join("\n")}`];

  // Phase 3: optional inline verify
  if (!input.dryRun && validatedVerify) {
    const verifySpec = validatedVerify;
    const verifyCwd = verifySpec.cwd ? resolvePath(verifySpec.cwd, baseCwd) : baseCwd;
    const timeoutCandidate: unknown = verifySpec.timeoutSec ?? input.verifyTimeoutSec;
    const rawTimeoutSec =
      (typeof timeoutCandidate === "number" ||
        (typeof timeoutCandidate === "string" && timeoutCandidate.trim() !== ""))
        ? Number(timeoutCandidate)
        : 60;
    const timeoutMs =
      (Number.isFinite(rawTimeoutSec)
        ? Math.max(1, Math.min(MCP_CALL_BUDGET_SEC, Math.trunc(rawTimeoutSec)))
        : 60) * 1000;
    const rawMaxVerifyChars = Number(input.maxVerifyChars ?? 4000);
    const maxVerifyChars = Number.isFinite(rawMaxVerifyChars)
      ? Math.max(300, Math.min(7_500, Math.trunc(rawMaxVerifyChars)))
      : 4000;

    const res = await runShellCommandAsync(verifySpec.command, {
      cwd: verifyCwd,
      timeoutMs,
    });

    const status = res.timedOut
      ? "TIMEOUT"
      : res.exitCode === 0
        ? "PASS"
        : `FAIL (exit ${res.exitCode ?? "err"})`;
    const formatted = formatCompactCommandOutput({
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      error: res.error,
      maxChars: maxVerifyChars,
    });

    parts.push(
      `\nVerify [${status} in ${res.durationMs}ms] \`${verifySpec.command}\`:\n${formatted}`,
    );
  }

  const outText = parts.join("\n");
  const finalText = truncateWithByteNotice(outText, DEFAULT_INLINE_MAX_BYTES);
  return { text: finalText, isError: false };
}
