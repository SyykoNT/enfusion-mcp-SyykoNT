import { describe, it, expect, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildStack } from "../../src/pak/stack.js";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import { makeFakeStack, G } from "./fake-stack.js";

const { root, config } = makeFakeStack();
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("buildStack", () => {
  it("orders dependencies before dependents, loose before Workshop, and lists missing ones", () => {
    const s = buildStack(config, "AddonA");
    expect(s.layers.map((l) => [l.id, l.kind, l.index])).toEqual([
      ["ArmaReforger", "vanilla", 0], ["ModB", "workshop", 1], ["ModC", "loose", 2], ["AddonA", "loose", 3],
    ]);
    expect(s.layers[2].root).toBe(join(config.projectPath, "ModC"));
    expect(s.missing).toEqual(["DDDDDDDDDDDDDDDD"]);
  });

  it("finds a target by Workshop folder, GUID, ID or vanilla, and names the known projects otherwise", () => {
    expect(buildStack(config, "ModB_BBBBBBBBBBBBBBBB").layers.map((l) => l.id)).toEqual(["ArmaReforger", "ModB"]);
    expect(buildStack(config, "BBBBBBBBBBBBBBBB").layers.at(-1)!.kind).toBe("workshop");
    expect(buildStack(config, "addona").layers.at(-1)!.id).toBe("AddonA");
    expect(buildStack(config, "vanilla").layers.map((l) => l.id)).toEqual(["ArmaReforger"]);
    expect(() => buildStack(config, "Nope")).toThrow(/known projects: .*AddonA/);
  });

  it("reads files and GUIDs both ways: .meta in loose layers, rdb in packed ones", () => {
    const [vanilla, modB, , addonA] = buildStack(config, "AddonA").layers;
    expect(vanilla.guidOf("Prefabs/Pants_BDU.et")).toBe(G.pantsBdu);
    expect(modB.guidOf(`{${G.character}}Prefabs/Character_Base.et`)).toBe(G.character);
    expect(addonA.guidOf("Prefabs/Pants_Base.et")).toBe(G.shadow);
    expect(modB.read("Prefabs/Character_Base.et")!.toString()).toContain("m_Value 2");
    expect(addonA.read("Prefabs/Character_Base.et")!.toString()).toContain("m_Value 3");
    expect(addonA.exists("Prefabs")).toBe(true);
    expect(addonA.read("Prefabs")).toBeNull();
    expect(addonA.read("../ModC/addon.gproj")).toBeNull();
    expect(vanilla.read("Prefabs/Nope.et")).toBeNull();
  });

  it("indexes no pak while building the stack, only on the first read", () => {
    const fresh = makeFakeStack();
    const spy = vi.spyOn(PakVirtualFS, "forPaks");
    const s = buildStack(fresh.config, "AddonA");
    expect(spy).not.toHaveBeenCalled();
    s.layers[1].exists("Prefabs/Guerilla_Pants.et");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    rmSync(fresh.root, { recursive: true, force: true });
  });
});
