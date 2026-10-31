import { describe, it, expect } from "vitest";
import { workshopNameIssues, workshopTextIssues } from "../../src/release/workshop-rules.js";

describe("workshop rules", () => {
  it("name: 30 characters pass, 31 fail, brackets fail, allowed punctuation passes", () => {
    expect(workshopNameIssues("a".repeat(30))).toEqual([]);
    expect(workshopNameIssues("a".repeat(31))).toEqual(["31/30 characters"]);
    expect(workshopNameIssues("Pistol Lethality (ACE Medical)")).toEqual(["characters not allowed: ( )"]);
    expect(workshopNameIssues("SYK-Sampan v1.2_test")).toEqual([]);
  });

  it("text: dashes with positions, AI names, other non-ASCII, trailing spaces", () => {
    expect(workshopTextIssues("Plain text.\nSecond line.")).toEqual([]);
    expect(workshopTextIssues("a — b")).toEqual(["en or em dash: — at 3"]);
    expect(workshopTextIssues("Made with Claude")).toEqual(["mentions Claude"]);
    expect(workshopTextIssues("café")).toEqual(["non-ASCII: é at 4"]);
    expect(workshopTextIssues("one \nтwo")).toEqual(["non-ASCII: т at 6", "trailing spaces on line 1"]);
    expect(workshopTextIssues("Claudette")).toEqual([]);
  });
});
