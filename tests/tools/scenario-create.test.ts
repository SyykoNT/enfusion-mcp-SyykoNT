import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { loadConfig } from "../../src/config.js";
import { registerScenarioCreate, parentWorldHas, readParentWorld } from "../../src/tools/scenario-create.js";
import { resolveWorldRef } from "../../src/templates/scenario.js";

// Lets one test fail a late write to check the rollback; every other write goes through.
const failOn = vi.hoisted(() => ({ suffix: "" }));
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: ((p: string, ...rest: unknown[]) => {
      if (failOn.suffix && String(p).endsWith(failOn.suffix)) throw new Error("disk full");
      return (fs.writeFileSync as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync,
  };
});

type Result = { content: { text: string }[]; isError?: boolean };
const root = mkdtempSync(join(tmpdir(), "emcp-sc-"));
const config = { ...loadConfig(), projectPath: join(root, "projects"), addonsDir: undefined, protectedAddons: [] };
let create!: (args: Record<string, unknown>) => Promise<Result>;
let schema!: Record<string, { description?: string }>;
registerScenarioCreate({ registerTool: (_n: string, d: { inputSchema: typeof schema }, h: typeof create) => { create = h; schema = d.inputSchema; } } as unknown as McpServer, config);

function addon(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "addon.gproj"), `GameProject {\n ID "${name}"\n GUID "1234567890ABCDEF"\n}\n`);
  return dir;
}
const args = (projectPath: string) => ({
  scenarioName: "ScnT", worldName: "Arland", projectPath,
  bases: [
    { name: "BaseAlpha", position: "1000 0 2000", faction: "US", type: "MOB" },
    { name: "BaseBravo", position: "2000 0 3000", faction: "USSR", type: "MOB" },
  ],
});

describe("scenario_create_conflict input docs", () => {
  it("describes suppliesIncome as HQ income and names m_iRegularSuppliesIncomeBase for other bases (B-107)", () => {
    const d = schema.suppliesIncome.description!;
    expect(d).toContain("HQs");
    expect(d).toContain("m_iRegularSuppliesIncomeBase");
    expect(d).not.toContain("contested bases");
  });

  it("states when regular bases and the radio extra get income, and that the tool writes no auto regeneration flag (B-108)", () => {
    const d = schema.suppliesIncome.description!;
    expect(d).toContain("HQs and supply hubs");
    expect(d).toMatch(/Regular bases use m_iRegularSuppliesIncomeBase .* only while m_bSuppliesAutoRegenerationEnabled is on/);
    expect(d).toContain("Source bases set their own");
    expect(d).toMatch(/radio extra .* applies only to non-HQ bases with auto regeneration on/);
  });
});

describe("scenario_create_conflict base rules", () => {
  const at = (name: string, type: string) => ({ name, position: "0 0 0", faction: "US", type });

  it("refuses fewer than 2 MOBs with the HQ text and writes no file", async () => {
    const dir = addon("M1");
    for (const [bases, got] of [[[at("A", "MOB"), at("B", "base")], 1], [[at("A", "base")], 0]] as const) {
      const r = await create({ ...args(dir), bases });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(`A Conflict mission needs at least 2 bases of type 'MOB' (HQ candidates); the game picks one HQ per side from them. Got ${got}.`);
      expect(readdirSync(dir)).toEqual(["addon.gproj"]);
    }
  });

  it("refuses before looking for a target addon", async () => {
    const r = await create({ ...args(addon("M2")), projectPath: undefined, bases: [at("A", "MOB")] });
    expect(r.content[0].text).toMatch(/^A Conflict mission needs at least 2 bases/);
  });

  it("rejects the removed types sourceBase and harbor in the schema, and keeps relay", () => {
    const bases = schema.bases as unknown as z.ZodTypeAny;
    for (const type of ["sourceBase", "harbor"]) expect(bases.safeParse([at("A", type)]).success).toBe(false);
    expect(bases.safeParse([at("A", "relay")]).success).toBe(true);
  });

  it("names the 2-MOB minimum in the bases description", () => {
    expect(schema.bases.description).toContain("At least 2 must be type 'MOB'");
  });
});

describe("scenario_create_conflict world files", () => {
  it("writes the .ent in Workbench's shape and a .ent.meta with a 16-hex GUID and its own path", async () => {
    const dir = addon("A1");
    const r = await create(args(dir));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Worlds/ScnT.ent.meta");
    expect(readFileSync(join(dir, "Worlds", "ScnT.ent"), "utf-8")).toContain("Layer default {");
    const meta = readFileSync(join(dir, "Worlds", "ScnT.ent.meta"), "utf-8");
    expect(meta).toMatch(/^MetaFileClass \{\n Name "\{[0-9A-F]{16}\}Worlds\/ScnT\.ent"\n/);
    expect(meta).toContain("ENTResourceClass HEADLESS : PC");
  });

  it("points the header at the sub-scene, gives the .conf its own .meta and names the header as {GUID}path (B-066)", async () => {
    const dir = addon("A0");
    const r = await create(args(dir));
    const worldGuid = /Name "\{([0-9A-F]{16})\}Worlds\/ScnT\.ent"/.exec(readFileSync(join(dir, "Worlds", "ScnT.ent.meta"), "utf-8"))![1];
    const confMeta = readFileSync(join(dir, "Missions", "ScnT.conf.meta"), "utf-8");
    const headerGuid = /^MetaFileClass \{\n Name "\{([0-9A-F]{16})\}Missions\/ScnT\.conf"\n/.exec(confMeta)![1];
    expect(headerGuid).not.toBe(worldGuid);
    expect(readFileSync(join(dir, "Missions", "ScnT.conf"), "utf-8")).toContain(` World "{${worldGuid}}Worlds/ScnT.ent"`);
    expect(r.content[0].text).toContain(`Mission header: {${headerGuid}}Missions/ScnT.conf`);
    expect(readFileSync(join(dir, "Worlds", "ScnT_Layers", "Bases.layer"), "utf-8")).not.toMatch(/m_fRadioAntennaServiceRange|m_bExcludeFromRandomization|m_RequiredGroupTypes/);
  });

  it("refuses when the .conf.meta already exists and writes nothing else", async () => {
    const dir = addon("A0b");
    mkdirSync(join(dir, "Missions"));
    writeFileSync(join(dir, "Missions", "ScnT.conf.meta"), "keep");
    const r = await create(args(dir));
    expect(r.content[0].text).toMatch(/^Files already exist: Missions\/ScnT\.conf\.meta/);
    expect(readFileSync(join(dir, "Missions", "ScnT.conf.meta"), "utf-8")).toBe("keep");
    expect(existsSync(join(dir, "Missions", "ScnT.conf"))).toBe(false);
  });

  it("prints both metas, carrying the header's World GUID, when it writes nothing (B-105)", async () => {
    const dir = addon("A0c");
    mkdirSync(join(dir, "Worlds"));
    writeFileSync(join(dir, "Worlds", "ScnT.ent.meta"), "keep");
    const refused = (await create(args(dir))).content[0].text;
    const noTarget = (await create({ ...args(dir), projectPath: undefined })).content[0].text;
    expect(noTarget).toContain("No target addon");
    for (const text of [refused, noTarget]) {
      const worldGuid = /World "\{([0-9A-F]{16})\}Worlds\/ScnT\.ent"/.exec(text)![1];
      expect(text).toContain(`**Worlds/ScnT.ent.meta**\n\`\`\`\nMetaFileClass {\n Name "{${worldGuid}}Worlds/ScnT.ent"`);
      expect(text).toMatch(/\*\*Missions\/ScnT\.conf\.meta\*\*\n```\nMetaFileClass \{\n Name "\{[0-9A-F]{16}\}Missions\/ScnT\.conf"/);
    }
  });

  it("refuses when the .ent.meta already exists and writes nothing else", async () => {
    const dir = addon("A2");
    mkdirSync(join(dir, "Worlds"));
    writeFileSync(join(dir, "Worlds", "ScnT.ent.meta"), "keep");
    const r = await create(args(dir));
    expect(r.content[0].text).toMatch(/^Files already exist: Worlds\/ScnT\.ent\.meta/);
    expect(readFileSync(join(dir, "Worlds", "ScnT.ent.meta"), "utf-8")).toBe("keep");
    expect(existsSync(join(dir, "Worlds", "ScnT.ent"))).toBe(false);
    expect(existsSync(join(dir, "Missions", "ScnT.conf"))).toBe(false);
    expect(readdirSync(join(dir, "Worlds", "ScnT_Layers"))).toEqual([]);
  });

  it("rolls the .ent.meta back when a later write fails", async () => {
    const dir = addon("A3");
    failOn.suffix = "Defenders.layer";
    const r = await create(args(dir));
    failOn.suffix = "";
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("disk full");
    expect(existsSync(join(dir, "Worlds", "ScnT.ent.meta"))).toBe(false);
    expect(existsSync(join(dir, "Worlds", "ScnT.ent"))).toBe(false);
    expect(existsSync(join(dir, "Missions", "ScnT.conf.meta"))).toBe(false);
  });

  it("cleans up", () => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("scenario_create_conflict parent world (D-044)", () => {
  const root2 = mkdtempSync(join(tmpdir(), "emcp-sc2-"));
  const addon2 = (name: string, files: Record<string, string>): string => {
    const dir = join(root2, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "addon.gproj"), `GameProject {\n ID "${name}"\n GUID "1234567890ABCDEF"\n}\n`);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    return dir;
  };
  const withParent = (dir: string, ref: string) => ({ ...args(dir), worldName: ref, suppliesIncome: 70 });
  const defaultLayer = (dir: string) => readFileSync(join(dir, "Worlds", "ScnT_Layers", "default.layer"), "utf-8");

  it("writes neither entity when the parent world and its layers hold them, and says which options are ignored", async () => {
    const dir = addon2("P1", {
      "Worlds/Parent.ent": "SubScene {\n}\nSCR_GameModeCampaign GameMode1 {\n}",
      "Worlds/Parent_Layers/default.layer": "SCR_CampaignFactionManager FM1 {\n}\nSCR_AIWorld AIWorld1 {\n}",
    });
    const r = await create(withParent(dir, "{1111111111111111}Worlds/Parent.ent"));
    expect(r.isError).toBeUndefined();
    expect(defaultLayer(dir)).toBe("");
    expect(r.content[0].text).toContain("parent world already has a game mode and a faction manager");
    expect(r.content[0].text).toMatch(/Ignored because the game mode is the parent's: .*suppliesIncome/);
  });

  it("writes both when the parent world has neither", async () => {
    const dir = addon2("P2", { "Worlds/Parent.ent": "SubScene {\n}" });
    const r = await create(withParent(dir, "{1111111111111111}Worlds/Parent.ent"));
    expect(defaultLayer(dir)).toMatch(/SCR_GameModeCampaign[\s\S]*SCR_CampaignFactionManager/);
    expect(r.content[0].text).not.toContain("parent world");
  });

  it("follows the SubScene parent chain: a sub-scene this tool made over a world with the game mode writes neither again (B-041)", async () => {
    const dir = addon2("P4", { "Worlds/Top.ent": "SubScene {\n}\nSCR_GameModeCampaign GameMode1 {\n}\nSCR_CampaignFactionManager FM1 {\n}\nSCR_AIWorld AIWorld1 {\n}" });
    const first = await create({ ...withParent(dir, "{1111111111111111}Worlds/Top.ent"), scenarioName: "Mid" });
    expect(first.isError).toBeUndefined();
    expect(readFileSync(join(dir, "Worlds", "Mid_Layers", "default.layer"), "utf-8")).toBe("");
    const r = await create({ ...withParent(dir, "{1111111111111111}Worlds/Mid.ent"), scenarioName: "Low" });
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(dir, "Worlds", "Low_Layers", "default.layer"), "utf-8")).toBe("");
    expect(r.content[0].text).toContain("parent world already has a game mode and a faction manager");
  });

  describe("AIWorld", () => {
    const aiWorlds = (dir: string) => defaultLayer(dir).match(/^SCR_AIWorld AIWorld1 : "[^"]*"/gm) ?? [];

    it("writes the Eden AIWorld for an Everon parent that has none, in default.layer and no extra file", async () => {
      const dir = addon2("A1", { "worlds/Eden/Eden.ent": "SubScene {\n}" });
      const r = await create({ ...args(dir), worldName: "Everon" });
      expect(r.isError).toBeUndefined();
      expect(aiWorlds(dir)).toEqual(['SCR_AIWorld AIWorld1 : "{70CCCF16487C927F}Prefabs/AI/SCR_AIWorld_Eden.et"']);
      expect(r.content[0].text).toContain("No AIWorld found above this world");
      expect(readdirSync(join(dir, "Missions")).sort()).toEqual(["ScnT.conf", "ScnT.conf.meta"]);
      expect(readdirSync(join(dir, "Worlds")).filter((f) => f.startsWith("ScnT")).sort()).toEqual(["ScnT.ent", "ScnT.ent.meta", "ScnT_Layers"]);
      expect(readdirSync(join(dir, "Worlds", "ScnT_Layers")).sort()).toEqual(["Bases.layer", "Defenders.layer", "default.layer"]);
    });

    it("writes none when the parent world or its layers already hold one", async () => {
      const dir = addon2("A2", { "Worlds/Parent.ent": "SubScene {\n}", "Worlds/Parent_Layers/default.layer": "SCR_AIWorld AIWorld1 : \"{70CCCF16487C927F}Prefabs/AI/SCR_AIWorld_Eden.et\" {\n}" });
      await create(withParent(dir, "{1111111111111111}Worlds/Parent.ent"));
      expect(aiWorlds(dir)).toEqual([]);
    });

    it("writes none and says so when the parent world cannot be read", async () => {
      const dir = addon2("A3", {});
      const r = await create(withParent(dir, "{1111111111111111}Worlds/Missing.ent"));
      expect(aiWorlds(dir)).toEqual([]);
      expect(r.content[0].text).toContain("No AIWorld is written");
    });

    it("writes the default SCR_AIWorld for a custom world with no terrain prefab of its own", async () => {
      const dir = addon2("A4", { "Worlds/Parent.ent": "SubScene {\n}" });
      await create(withParent(dir, "{1111111111111111}Worlds/Parent.ent"));
      expect(aiWorlds(dir)).toEqual(['SCR_AIWorld AIWorld1 : "{E0A05C76552E7F58}Prefabs/AI/SCR_AIWorld.et"']);
    });
  });

  it("stops on a parent chain that loops, and on a link that cannot be read", () => {
    const loop = addon2("P5", {
      "Worlds/A.ent": 'SubScene {\n Parent "{1111111111111111}Worlds/B.ent"\n}',
      "Worlds/B.ent": 'SubScene {\n Parent "{1111111111111111}Worlds/A.ent"\n}',
      "Worlds/C.ent": 'SubScene {\n Parent "{1111111111111111}Worlds/Gone.ent"\n}',
    });
    const read = (n: string) => readParentWorld(config, join(loop, "addon.gproj"), `{1111111111111111}Worlds/${n}.ent`);
    expect(read("A")?.match(/SubScene/g)).toHaveLength(2); // A and B once each, then the walk ends
    expect(parentWorldHas(read("A")!)).toEqual({ gameMode: false, factionManager: false });
    expect(read("C")).toBeNull();
  });

  it("writes both and says why when the parent world cannot be read", async () => {
    const dir = addon2("P3", {});
    const r = await create(withParent(dir, "{1111111111111111}Worlds/Missing.ent"));
    expect(defaultLayer(dir)).toMatch(/SCR_GameModeCampaign[\s\S]*SCR_CampaignFactionManager/);
    expect(r.content[0].text).toContain("Parent world not readable: the game mode and faction manager are written");
  });

  it("matches class names in the bytes of a binary world", () => {
    const bin = Buffer.concat([Buffer.from("EBIN"), Buffer.from([0, 7, 0]), Buffer.from("SCR_GameModeCampaign"), Buffer.from([0]), Buffer.from("SCR_CampaignFactionManager"), Buffer.from([0, 255])]);
    expect(parentWorldHas(bin.toString("latin1"))).toEqual({ gameMode: true, factionManager: true });
    expect(parentWorldHas("EBIN SCR_GameModeCampaignX SCR_CampaignFactionManagers")).toEqual({ gameMode: false, factionManager: false });
  });

  it.skipIf(!existsSync("C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger/addons/data/resourceDatabase.rdb"))(
    "reads the real vanilla worlds: Arland has both, Everon's Eden.ent has neither",
    () => {
      const has = (name: string) => parentWorldHas(readParentWorld(config, "vanilla", resolveWorldRef(name))!);
      expect(has("Arland")).toEqual({ gameMode: true, factionManager: true });
      expect(has("Everon")).toEqual({ gameMode: false, factionManager: false });
    }
  );

  it("cleans up the second root", () => {
    rmSync(root2, { recursive: true, force: true });
  });
});
