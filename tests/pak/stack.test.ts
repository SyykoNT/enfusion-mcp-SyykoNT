import { describe, it, expect, afterAll, vi } from "vitest";
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { buildStack, closure, installedAddons } from "../../src/pak/stack.js";
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

describe("installedAddons and closure", () => {
  it("names each addon from its BOM'd Workshop files and lists the copies a local project shadows", () => {
    const all = installedAddons(config);
    const b = all.get("BBBBBBBBBBBBBBBB")!;
    expect([b.name, b.version, b.gameVersion, b.source, b.gproj.endsWith("dev.gproj")]).toEqual(["Mod B", "1.2.0", "1.7.0.54", "workshop", true]);
    expect(b.depNames).toEqual({ "58D0FB3206B6F859": "Arma Reforger" });
    const c = all.get("CCCCCCCCCCCCCCCC")!;
    expect([c.source, c.name, c.version]).toEqual(["loose", "ModC", ""]);
    expect(c.shadowed).toEqual([join(config.workshopPath!, "ModC_CCCCCCCCCCCCCCCC")]);
    expect(all.get("58D0FB3206B6F859")!.source).toBe("vanilla");
  });

  it("reports the load order, missing dependencies and cycles, including a self dependency", () => {
    const c = closure(config, "AddonA");
    expect(c.order.map((a) => a.id)).toEqual(["ArmaReforger", "ModB", "ModC", "AddonA"]);
    expect([c.missing, c.cycles]).toEqual([["DDDDDDDDDDDDDDDD"], []]);

    const dir = mkdtempSync(join(tmpdir(), "emcp-cycle-"));
    const proj = (id: string, guid: string, deps: string[]) => {
      mkdirSync(join(dir, id));
      writeFileSync(join(dir, id, "addon.gproj"), `GameProject {\n ID "${id}"\n GUID "${guid}"\n Dependencies {\n  ${deps.map((d) => `"${d}"`).join(" ")}\n }\n}\n`);
    };
    proj("X", "1000000000000001", ["1000000000000002"]);
    proj("Y", "1000000000000002", ["1000000000000001"]);
    proj("Z", "1000000000000003", ["1000000000000003"]);
    const cfg = { gamePath: join(dir, "nogame"), projectPath: dir } as Config;
    const x = closure(cfg, "X");
    expect(x.order.map((a) => a.id)).toEqual(["Y", "X"]);
    expect(x.cycles).toEqual([["1000000000000001", "1000000000000002", "1000000000000001"]]);
    expect(closure(cfg, "Z").cycles).toEqual([["1000000000000003", "1000000000000003"]]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("addons behind links and Workshop downloads in a loose dir", () => {
  it.skipIf(process.platform !== "win32")("finds an addon held as a junction under the project path (B-025)", () => {
    const { root: r, config: c } = makeFakeStack();
    const real = join(r, "elsewhere", "Linked");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "addon.gproj"), 'GameProject {\n ID "Linked"\n GUID "EEEEEEEEEEEEEEEE"\n Dependencies {\n  "58D0FB3206B6F859"\n }\n}\n');
    writeFileSync(join(real, "Linked.txt"), "x\n");
    symlinkSync(real, join(c.projectPath, "Linked"), "junction");
    expect(buildStack(c, "Linked").layers.map((l) => [l.id, l.kind])).toEqual([["ArmaReforger", "vanilla"], ["Linked", "loose"]]);
    expect(buildStack(c, "EEEEEEEEEEEEEEEE").layers.at(-1)!.read("Linked.txt")?.toString()).toBe("x\n");
    expect(installedAddons(c).get("EEEEEEEEEEEEEEEE")?.dir).toBe(join(c.projectPath, "Linked"));
    rmSync(r, { recursive: true, force: true });
  });

  it("reads a Workshop download found in a loose dir from its paks (B-026)", () => {
    const { root: r, config: c } = makeFakeStack();
    // The default projectPath case: the project path is a folder of Workshop downloads
    const asLoose = { ...c, projectPath: c.workshopPath!, workshopPath: undefined } as Config;
    const modB = buildStack(asLoose, "BBBBBBBBBBBBBBBB").layers.at(-1)!;
    expect([modB.id, modB.kind]).toEqual(["ModB", "workshop"]);
    expect(modB.read("Prefabs/Guerilla_Pants.et")?.toString()).toContain("Prefabs/Pants_BDU.et");
    expect(modB.list("Prefabs")).toContain("Prefabs/Guerilla_Pants.et");
    expect(installedAddons(asLoose).get("BBBBBBBBBBBBBBBB")?.source).toBe("workshop");
    // No ServerData.json: a hand-made folder stays loose
    expect(buildStack(asLoose, "ModC_CCCCCCCCCCCCCCCC").layers.at(-1)!.kind).toBe("loose");
    rmSync(r, { recursive: true, force: true });
  });
});
