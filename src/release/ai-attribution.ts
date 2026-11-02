// The one list of AI coding tool identities (D-052). G5 (git.ts) blocks what it matches; the commit-msg hook carries a sed copy of the strip rows.
// Sources and status per entry: tests/records/2026-11-02_AI-ATTR_research.md (in the MCP project folder). Match by email and bot login, never by a bare name:
// claude-code-action and OpenCode write a human co-author line, and people are named Claude, Devin, Jules or Cursor.

type Source = "verified" | "observed" | "account only";

/** Exact addresses a human cannot hold. */
export const AI_EMAILS: { email: string; tool: string; source: Source }[] = [
  { email: "noreply@anthropic.com", tool: "Claude Code", source: "verified" },
  { email: "noreply@openai.com", tool: "Codex CLI", source: "verified" },
  { email: "copilot@github.com", tool: "VS Code Copilot", source: "verified" },
  { email: "aider@aider.chat", tool: "Aider", source: "verified" },
  { email: "noreply@continue.dev", tool: "Continue", source: "verified" },
  { email: "cursoragent@cursor.com", tool: "Cursor", source: "observed" },
];

/** GitHub App bots of AI tools: `<login>[bot]@users.noreply.github.com` (optional `<digits>+` prefix) or the name `<login>[bot]`. */
export const AI_BOT_LOGINS: { login: string; tool: string; source: Source }[] = [
  { login: "claude", tool: "Claude Code Action", source: "verified" },
  { login: "opencode-agent", tool: "OpenCode", source: "verified" },
  { login: "kiloconnect", tool: "Kilo Code", source: "verified" },
  { login: "google-labs-jules", tool: "Jules", source: "observed" },
  { login: "devin-ai-integration", tool: "Devin", source: "observed" },
  { login: "copilot-swe-agent", tool: "Copilot agent", source: "account only" },
  { login: "cursor", tool: "Cursor", source: "account only" },
  { login: "gemini-cli", tool: "Gemini CLI", source: "account only" },
  { login: "gemini-code-assist", tool: "Gemini Code Assist", source: "account only" },
  { login: "chatgpt-codex-connector", tool: "Codex", source: "account only" },
  { login: "amazon-q-developer", tool: "Amazon Q", source: "account only" },
  { login: "factory-droid", tool: "Factory Droid", source: "account only" },
  { login: "cline", tool: "Cline", source: "account only" },
  { login: "roomote", tool: "Roo Code", source: "account only" },
  { login: "coderabbitai", tool: "CodeRabbit", source: "account only" },
  { login: "augmentcode", tool: "Augment", source: "account only" },
  { login: "continue", tool: "Continue", source: "account only" },
];

const esc = (s: string) => s.replace(/[.[\]()+?*\\|]/g, "\\$&");
const botEmail = String.raw`([0-9]+\+)?(${AI_BOT_LOGINS.map((b) => esc(b.login)).join("|")})\[bot\]@users\.noreply\.github\.com`;
const aiEmail = AI_EMAILS.map((e) => esc(e.email)).join("|");

/**
 * Message lines, one pattern each, case-insensitive, matched per line. Patterns use only what JS and POSIX ERE share (see the lint in the test):
 * literals, . * + ? | ( ) ^ $, bracket expressions of literals and ranges, and backslash escapes of . [ ] ( ) + ? * \ |.
 * strip: the hook deletes the line. A subject line (L10) is only blocked: deleting it would leave no subject.
 */
export const AI_LINES: { id: string; pattern: string; strip: boolean; tool: string; source: Source }[] = [
  { id: "L1", pattern: String.raw`^ *co-authored-by:.*<(${aiEmail}|${botEmail})> *$`, strip: true, tool: "all trailer forms", source: "verified" },
  { id: "L2", pattern: String.raw`^ *claude-session:`, strip: true, tool: "Claude Code sessions", source: "verified" },
  { id: "L3", pattern: String.raw`^ *agent-logs-url:`, strip: true, tool: "Copilot agent", source: "verified" },
  { id: "L4", pattern: String.raw`generated with \[?claude code`, strip: true, tool: "Claude Code", source: "verified" },
  { id: "L5", pattern: String.raw`generated with \[codex\]\(https://openai\.com/codex`, strip: true, tool: "Codex CLI", source: "verified" },
  { id: "L6", pattern: String.raw`generated with \[continue\]\(https://continue\.dev`, strip: true, tool: "Continue", source: "verified" },
  { id: "L7", pattern: String.raw`powered by \[kilo\]\(https://kilo\.ai`, strip: true, tool: "Kilo Code", source: "verified" },
  { id: "L8", pattern: String.raw`\[(opencode|kilo) session\]\(`, strip: true, tool: "OpenCode, Kilo Code", source: "verified" },
  { id: "L9", pattern: String.raw`^ *made[- ]with:? *cursor *$`, strip: true, tool: "Cursor", source: "observed" },
  { id: "L10", pattern: String.raw`^aider: `, strip: false, tool: "Aider", source: "verified" },
];

const lineRes = AI_LINES.map((l) => ({ ...l, re: new RegExp(l.pattern, "i") }));
const botNameRe = new RegExp(String.raw`^(${AI_BOT_LOGINS.map((b) => esc(b.login)).join("|")})\[bot\]$`, "i");
const botEmailRe = new RegExp(`^${botEmail}$`, "i");

/** The lines of a commit message that match any row. */
export function aiLineHits(message: string): string[] {
  return message.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => lineRes.some((r) => r.re.test(l)));
}

/** The message without the `strip` rows: what the hook leaves. */
export function stripLines(message: string): string {
  return message.split("\n").filter((l) => !lineRes.some((r) => r.strip && r.re.test(l))).join("\n");
}

/** Why an author or committer is an AI tool (the matched identity), else undefined. */
export function aiIdentity(name: string, email: string): string | undefined {
  const mail = email.trim().toLowerCase();
  if (AI_EMAILS.some((e) => e.email === mail) || botEmailRe.test(mail)) return mail;
  if (botNameRe.test(name.trim())) return name.trim();
  if (/ \(aider\)$/i.test(name.trim())) return name.trim();
  return undefined;
}

/** Turns each ASCII letter outside a bracket expression and not after a backslash into [xX], so sed needs no I flag (GitHub Desktop's embedded Git is not assumed to have it). */
export function caseless(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") out += c + (pattern[++i] ?? "");
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2); // the first character after [ may be a literal ]
      out += pattern.slice(i, end + 1);
      i = end;
    } else out += /[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c;
  }
  return out;
}

/** The hook's sed arguments: one delete per strip row. Single-quoted, so no row may hold a quote. */
export const SED_PROGRAM = AI_LINES.filter((l) => l.strip).map((l) => `-e '/${caseless(l.pattern).replace(/\//g, "\\/")}/d'`).join(" ");
