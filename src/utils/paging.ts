/** Most characters one page may hold: Claude Code saves results over 50,000 chars to a file instead (code.claude.com/docs/en/mcp). */
export const MAX_PAGE_CHARS = 45_000;

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Lines [offset, offset + limit) of text, cut short at maxChars, with their line endings kept
 * so the pages put together give the text back exactly. Throws when offset is past the end.
 */
export function pageLines(text: string, offset = 0, limit = 400, maxChars = MAX_PAGE_CHARS): { body: string; footer: string; total: number } {
  const lines = text.split(/(?<=\n)/);
  if (lines.length === 1 && lines[0] === "") lines.pop();
  const total = lines.length;
  if (offset > 0 && offset >= total) throw new Error(`offset ${offset} is past the end (${fmt(total)} lines)`);
  let end = offset, size = 0;
  // shortcut: a single line longer than maxChars still comes back whole (no page can start mid-line)
  while (end < total && end - offset < limit && (end === offset || size + lines[end].length <= maxChars)) size += lines[end++].length;
  const range = `lines ${fmt(Math.min(offset + 1, total))}-${fmt(end)} of ${fmt(total)}`;
  return { body: lines.slice(offset, end).join(""), footer: end < total ? `${range}; continue with offset=${end}` : `${range} (end)`, total };
}

/**
 * Up to maxChars of text from offset, ending at a paragraph break in the last quarter of the window,
 * else the last line break, else the last space, else mid-word. Throws when offset is past the end.
 */
export function takePart(text: string, offset = 0, maxChars = 30_000): { body: string; end: number; total: number; partNo: number; partCount: number } {
  const total = text.length;
  if (offset > 0 && offset >= total) throw new Error(`offset ${fmt(offset)} is past the end (${fmt(total)} chars)`);
  let end = Math.min(offset + maxChars, total);
  if (end < total) {
    const win = text.slice(offset, end);
    let blank = -1;
    for (const m of win.matchAll(/\n\r?\n/g)) if (m.index + m[0].length > win.length * 0.75) blank = m.index + m[0].length;
    end = offset + ([blank, win.lastIndexOf("\n") + 1, win.lastIndexOf(" ") + 1].find((i) => i > 0) ?? win.length);
  }
  return { body: text.slice(offset, end), end, total, partNo: Math.floor(offset / maxChars) + 1, partCount: Math.max(1, Math.ceil(total / maxChars)) };
}
