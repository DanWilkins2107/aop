/** A line diff for reviewing proposed file changes. */

export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
  /** Line numbers in the old and new file, where the line exists there. */
  oldLine: number | null;
  newLine: number | null;
}

/** Past this many line pairs, the diff gives up on matching and shows a full replacement. */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  // A final newline ends the last line rather than starting another.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Every line of both versions, in order, marked as kept, added or removed. Uses a longest common
 * subsequence, so moved blocks show as a removal and an addition. `before` null is a new file.
 */
export function diffLines(before: string | null, after: string): DiffLine[] {
  const a = splitLines(before ?? "");
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  // Common lines at either end need no table, which keeps typical edits cheap.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n;
  let endB = m;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const middle: DiffLine[] = [];
  const rows = endA - start;
  const cols = endB - start;
  if (rows * cols > MAX_CELLS) {
    for (let i = start; i < endA; i++) middle.push({ kind: "remove", text: a[i]!, oldLine: i + 1, newLine: null });
    for (let j = start; j < endB; j++) middle.push({ kind: "add", text: b[j]!, oldLine: null, newLine: j + 1 });
  } else {
    // lengths[i][j]: the longest common run of a[start+i..] and b[start+j..].
    const width = cols + 1;
    const lengths = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = cols - 1; j >= 0; j--) {
        lengths[i * width + j] =
          a[start + i] === b[start + j]
            ? lengths[(i + 1) * width + j + 1]! + 1
            : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows || j < cols) {
      if (i < rows && j < cols && a[start + i] === b[start + j]) {
        middle.push({ kind: "same", text: a[start + i]!, oldLine: start + i + 1, newLine: start + j + 1 });
        i++;
        j++;
      } else if (i < rows && (j === cols || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) {
        // Removals first, as diffs usually show them.
        middle.push({ kind: "remove", text: a[start + i]!, oldLine: start + i + 1, newLine: null });
        i++;
      } else {
        middle.push({ kind: "add", text: b[start + j]!, oldLine: null, newLine: start + j + 1 });
        j++;
      }
    }
  }

  const same = (i: number, j: number): DiffLine => ({ kind: "same", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
  const head = Array.from({ length: start }, (_, i) => same(i, i));
  const tail = Array.from({ length: n - endA }, (_, k) => same(endA + k, endB + k));
  return [...head, ...middle, ...tail];
}

export type DiffChunk = { kind: "lines"; lines: DiffLine[] } | { kind: "skipped"; count: number };

/** Keeps `context` unchanged lines around each change and folds the rest into skipped runs. */
export function withContext(lines: DiffLine[], context = 3): DiffChunk[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const chunks: DiffChunk[] = [];
  for (let index = 0; index < lines.length; index++) {
    const last = chunks.at(-1);
    if (keep[index]) {
      if (last?.kind === "lines") last.lines.push(lines[index]!);
      else chunks.push({ kind: "lines", lines: [lines[index]!] });
    } else if (last?.kind === "skipped") {
      last.count++;
    } else {
      chunks.push({ kind: "skipped", count: 1 });
    }
  }
  return chunks;
}

/** How many lines were added and removed. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === "add").length,
    removed: lines.filter((line) => line.kind === "remove").length,
  };
}
