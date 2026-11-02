import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { releaseAudit, registerReleaseAudit, type AuditJson } from "../../src/tools/release-audit.js";
import { buildRdb, buildTestPak } from "../pak/test-pak.js";

const root = mkdtempSync(join(tmpdir(), "emcp-audit-"));
const put = (base: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text);
  }
};
const gproj = (id: string, guid: string, deps: string[]) =>
  `GameProject {\n ID "${id}"\n GUID "${guid}"\n TITLE "${id}"\n Dependencies {\n${deps.map((d) => `  "${d}"\n`).join("")} }\n Configurations {\n${["PC", "XBOX_ONE", "XBOX_SERIES", "PS4", "PS5", "HEADLESS"].map((c) => `  GameProjectConfig ${c} {\n  }\n`).join("")} }\n}\n`;
const meta = (guid: string, path: string) => `MetaFileClass {\n Name "{${guid}}${path}"\n}\n`;

// Base game and one packed Workshop dependency, each with an rdb
const vanilla = join(root, "game", "addons", "data");
put(vanilla, { "ArmaReforger.gproj": gproj("ArmaReforger", "58D0FB3206B6F859", []) });
writeFileSync(join(vanilla, "resourceDatabase.rdb"), buildRdb({ "Prefabs/Base.et": "5000000000000001" }));
const dep = join(root, "workshop", "Dep_DDDD000000000001");
put(dep, { "dev.gproj": gproj("Dep", "DDDD000000000001", ["58D0FB3206B6F859"]) });
writeFileSync(join(dep, "data.pak"), buildTestPak([{ path: "Prefabs/Same.et", content: "GenericEntity {\n}\n", compress: false }]));
writeFileSync(join(dep, "resourceDatabase.rdb"), buildRdb({ "Prefabs/Same.et": "6000000000000001", "Prefabs/Theirs.et": "6000000000000002" }));

const projects = join(root, "projects");
const boat = join(projects, "Boat");
put(boat, {
  "addon.gproj": gproj("Boat", "B0A7000000000001", ["58D0FB3206B6F859", "DDDD000000000001"]),
  "Prefabs/Same.et": "GenericEntity {\n}\n",
  "Prefabs/Same.et.meta": meta("6000000000000001", "Prefabs/Same.et"),
  "Prefabs/Mine.et": "GenericEntity {\n m_x 1\n}\n",
  "Prefabs/Mine.et.meta": meta("6000000000000002", "Prefabs/Mine.et"),
  "license.txt": "x\n",
});
writeFileSync(join(boat, "resourceDatabase.rdb"), buildRdb({ "Prefabs/Same.et": "6000000000000001", "Prefabs/Mine.et": "6000000000000002" }));
const clean = join(projects, "Clean");
put(clean, { "addon.gproj": gproj("Clean", "C1EA000000000001", ["58D0FB3206B6F859"]), "license.txt": "x\n" });
writeFileSync(join(clean, "resourceDatabase.rdb"), buildRdb({}));
writeFileSync(join(clean, "thumbnail.png"), (() => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(1920, 16); b.writeUInt32BE(1080, 20); return b; })());
const handlers = join(projects, "Handlers");
put(handlers, { "addon.gproj": gproj("Handlers", "4A4D000000000001", ["58D0FB3206B6F859"]), "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c": "class A {}\n" });
const inCache = join(root, "workshop", "Cached_CCCC000000000001");
put(inCache, { "addon.gproj": gproj("Cached", "CCCC000000000001", ["58D0FB3206B6F859"]) });

const config = { projectPath: projects, gamePath: join(root, "game"), workbenchPath: join(root, "tools"), workshopPath: join(root, "workshop"), defaultMod: "Clean" } as Config;
process.env.ENFUSION_FORBIDDEN_DIRS = join(root, "workshop");

const audit = (opts: Parameters<typeof releaseAudit>[1]) => {
  const r = releaseAudit(config, opts);
  if ("error" in r) throw new Error(r.error);
  return r;
};
const ids = (j: AuditJson) => j.findings.map((f) => `${f.id} ${f.level}${f.path ? ` ${f.path}` : ""}`);

describe("release_audit", () => {
  it("defaults to ENFUSION_DEFAULT_MOD; a clean addon is clean and only reports info", () => {
    const { json } = audit({ checks: ["handlers", "gproj", "meta", "leftovers", "text", "size", "preview"] });
    expect(json.addon).toBe("Clean");
    expect(json.verdict).toBe("clean");
    expect(json.counts).toEqual({ blocker: 0, warning: 0, info: 1 });
    expect(ids(json)).toEqual(["S1 info"]);
  });

  it("blocked by H1; JSON in the report parses and matches", () => {
    const { report, json } = audit({ addonName: "Handlers", checks: ["handlers"] });
    expect(json.verdict).toBe("blocked");
    expect(ids(json)).toEqual(["H1 blocker Scripts/WorkbenchGame/EnfusionMCP"]);
    expect(JSON.parse(report.match(/```json\n(.+)\n```/s)![1])).toEqual(json);
    expect(report).toMatch(/Verdict: \*\*blocked\*\*/);
    expect(report).toContain("## Blockers\n- H1 Scripts/WorkbenchGame/EnfusionMCP: 1 MCP handler files");
  });

  it("checks limit what runs; Passed lists the checks without problems", () => {
    const { report, json } = audit({ addonName: "Boat", checks: ["handlers", "leftovers"] });
    expect(json.findings).toEqual([]);
    expect(json.sizes).toBeNull();
    expect(report).toContain("## Passed\nhandlers, leftovers");
  });

  it("M5 reads dependency rdbs: same GUID and path is an override, another path a clash", () => {
    const { json } = audit({ addonName: "Boat", checks: ["meta"] });
    expect(ids(json).sort()).toEqual(["M5 blocker Prefabs/Mine.et", "M5 info Prefabs/Same.et"]);
    expect(json.findings.find((f) => f.level === "blocker")?.message).toBe("GUID 6000000000000002 is also Dep's Prefabs/Theirs.et");
  });

  it("S2 only with compareOverrides: the file Dep already ships byte for byte", () => {
    expect(audit({ addonName: "Boat", checks: ["overrides"] }).json.findings).toEqual([]);
    expect(ids(audit({ addonName: "Boat", checks: ["overrides"], compareOverrides: true }).json)).toEqual(["S2 warning Prefabs/Same.et"]);
  });

  it("X1 refuses an addon inside a forbidden root and runs no other check", () => {
    const { json } = audit({ gprojPath: join(inCache, "addon.gproj") });
    expect(ids(json)).toEqual(["X1 blocker"]);
    expect(json.verdict).toBe("blocked");
  });

  it("an unknown addon is an error naming the projects path", () => {
    const r = releaseAudit(config, { addonName: "Nope" });
    expect(r).toEqual({ error: `Addon not found. Pass addonName (a folder under ${projects}) or gprojPath.` });
  });

  it("the tool returns JSON only with format json, and isError when not found", async () => {
    type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    let h: Handler = async () => ({ content: [] });
    registerReleaseAudit({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, config);
    expect(JSON.parse((await h({ addonName: "Handlers", checks: ["handlers"], format: "json" })).content[0].text).verdict).toBe("blocked");
    expect((await h({ addonName: "Nope" })).isError).toBe(true);
  });

  it("writes nothing in the addon or its .git (file list, sizes and mtimes unchanged)", () => {
    let hasGit = true;
    try {
      execFileSync("git", ["-C", boat, "init", "-q"], { stdio: "ignore" });
    } catch {
      hasGit = false;
    }
    const snap = (d: string) => readdirSync(d, { recursive: true }).map(String).sort().map((r) => { const s = statSync(join(d, r)); return `${r}|${s.size}|${s.mtimeMs}`; });
    const before = snap(boat);
    audit({ addonName: "Boat", compareOverrides: true });
    expect(snap(boat)).toEqual(before);
    expect(hasGit ? before.some((l) => l.startsWith(".git")) : true).toBe(true);
  });
});
