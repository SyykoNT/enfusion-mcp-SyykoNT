import { describe, it, expect } from "vitest";
import { AI_BOT_LOGINS, AI_EMAILS, AI_LINES, SED_PROGRAM, aiIdentity, aiLineHits, caseless, stripLines } from "../../src/release/ai-attribution.js";
import { AI_SAMPLES, HUMAN_LINES } from "./ai-samples.js";

describe("the AI attribution list", () => {
  it("every row compiles, follows the pattern rules and holds no quote or percent sign", () => {
    for (const l of AI_LINES) {
      expect(() => new RegExp(l.pattern, "i"), l.id).not.toThrow();
      expect(l.pattern, l.id).not.toMatch(/['%]|\{|\(\?/);
      expect(l.pattern.replace(/\\[.[\]()+?*\\|]/g, ""), l.id).not.toMatch(/\\/); // no \s \d \w \b \t
    }
    expect(SED_PROGRAM).not.toContain("%");
    expect(new Set(AI_LINES.map((l) => l.id)).size).toBe(AI_LINES.length);
    for (const e of [...AI_EMAILS, ...AI_BOT_LOGINS]) expect(e.source).toMatch(/^(verified|observed|account only)$/);
  });

  it("hits every researched AI line, alone and inside a message", () => {
    for (const { line } of AI_SAMPLES) {
      expect(aiLineHits(line), line).toEqual([line]);
      expect(aiLineHits(`Fix it\n\nBody text\n\n${line}\n`), line).toEqual([line]);
    }
  });

  it("lets human lines and prose pass", () => {
    for (const line of HUMAN_LINES) expect(aiLineHits(line), line).toEqual([]);
  });

  it("aiIdentity: AI emails, bot logins and the (aider) name give a reason; humans and unlisted bots none", () => {
    expect(aiIdentity("Jane (aider)", "jane@example.com")).toBeDefined();
    expect(aiIdentity("anyone", "noreply@anthropic.com")).toBeDefined();
    expect(aiIdentity("google-labs-jules[bot]", "x@example.com")).toBeDefined();
    expect(aiIdentity("x", "161369871+google-labs-jules[bot]@users.noreply.github.com")).toBeDefined();
    expect(aiIdentity("Claude Dupont", "claude@example.com")).toBeUndefined();
    expect(aiIdentity("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")).toBeUndefined();
    expect(aiIdentity("Jane", "12345+jane@users.noreply.github.com")).toBeUndefined();
  });

  it("caseless keeps bracket expressions and escapes and turns letters into [xX]", () => {
    expect(caseless(String.raw`^ab[0-9]c\[d\]`)).toBe(String.raw`^[aA][bB][0-9][cC]\[[dD]\]`);
    expect(caseless("made[- ]with")).toBe("[mM][aA][dD][eE][- ][wW][iI][tT][hH]");
  });

  it("SED_PROGRAM has one -e per strip row and none for the subject-line row", () => {
    expect((SED_PROGRAM.match(/-e '/g) ?? []).length).toBe(AI_LINES.filter((l) => l.strip).length);
    expect(AI_LINES.find((l) => l.id === "L10")?.strip).toBe(false);
    expect(SED_PROGRAM).not.toMatch(/\[aA\]\[iI\]\[dD\]\[eE\]\[rR\]: /);
  });

  it("stripLines drops the strip rows and keeps the aider subject and everything else", () => {
    const msg = ["aider: fix", "", "Body", "Co-authored-by: Codex <noreply@openai.com>", "Co-authored-by: Jane Doe <12345+janedoe@users.noreply.github.com>"].join("\n");
    expect(stripLines(msg)).toBe(["aider: fix", "", "Body", "Co-authored-by: Jane Doe <12345+janedoe@users.noreply.github.com>"].join("\n"));
  });
});
