/** Workshop publish dialog limits. Name and summary limits were measured in the 1.8 publish dialog; the rest are BI's documented limits. */
export const NAME_MAX = 30;
export const SUMMARY_MAX = 200; // BI's wiki says 1024; the dialog stopped at 200 when measured
export const DESCRIPTION_MAX = 5000;
export const CHANGE_NOTES_MAX = 30000;

/** Problems with a Workshop Project Name: over 30 characters, or characters outside letters, digits, space, dot, dash, underscore. */
export function workshopNameIssues(title: string): string[] {
  const issues: string[] = [];
  const n = [...title].length;
  if (n > NAME_MAX) issues.push(`${n}/${NAME_MAX} characters`);
  const bad = [...new Set(title.match(/[^A-Za-z0-9 ._-]/gu) ?? [])];
  if (bad.length) issues.push(`characters not allowed: ${bad.join(" ")}`);
  return issues;
}

/** The text style rules below are one author's house style: off unless ENFUSION_TEXT_STYLE=strict (release_audit T2 and workshop_info use this). */
export const textStyleStrict = (): boolean => process.env.ENFUSION_TEXT_STYLE === "strict";

/** Workshop text style rules: no en or em dashes, no AI names, ASCII only, no trailing spaces. Positions are 1-based characters. */
export function workshopTextIssues(text: string): string[] {
  const chars = [...text];
  const at = (re: RegExp) => chars.flatMap((c, i) => (re.test(c) ? [`${c} at ${i + 1}`] : [])).slice(0, 10);
  const issues: string[] = [];
  const dashes = at(/[\u2013\u2014]/);
  if (dashes.length) issues.push(`en or em dash: ${dashes.join(", ")}`);
  if (/\b(claude|anthropic)\b/i.test(text)) issues.push(`mentions ${text.match(/\b(claude|anthropic)\b/i)![0]}`);
  const other = at(/[^\x00-\x7F\u2013\u2014]/);
  if (other.length) issues.push(`non-ASCII: ${other.join(", ")}`);
  const trailing = text.split(/\r?\n/).flatMap((l, i) => (/[ \t]$/.test(l) ? [i + 1] : []));
  if (trailing.length) issues.push(`trailing spaces on line ${trailing.join(", ")}`);
  return issues;
}
