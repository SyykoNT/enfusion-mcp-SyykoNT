import { describe, it, expect } from "vitest";
import { parse, getProperty } from "../../src/formats/enfusion-text.js";
import { entityTemplateMeta } from "../../src/formats/config-override.js";

describe("entityTemplateMeta", () => {
  it("parses and has the Name and one block per platform", () => {
    const text = entityTemplateMeta("0123456789ABCDEF", "Prefabs/X.et");
    const node = parse(text);
    expect(node.type).toBe("MetaFileClass");
    expect(getProperty(node, "Name")).toBe("{0123456789ABCDEF}Prefabs/X.et");
    expect(node.children.find((c) => c.type === "Configurations")!.children).toHaveLength(7);
    // the current parser reads "X : PC {" blocks by their parent name, so count the class in the text
    expect(text.match(/^ {2}EntityTemplateResourceClass \w+( : PC)? \{$/gm)).toHaveLength(7);
  });
});
