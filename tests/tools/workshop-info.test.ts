import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { nextVersion, registerWorkshopInfo } from "../../src/tools/workshop-info.js";

const root = mkdtempSync(join(tmpdir(), "emcp-wsi-"));
const projects = join(root, "projects");
const addon = (base: string, name: string, guid: string, deps: string[] = []) => {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "addon.gproj"),
    `GameProject {\n ID "${name}"\n GUID "${guid}"\n TITLE "${name} Title"\n Dependencies {\n${deps.map((d) => `  "${d}"\n`).join("")} }\n}\n`
  );
  return dir;
};
addon(projects, "Alpha", "AAAA000000000001");
addon(projects, "Default", "DDDD000000000001");
addon(root, "Outside", "0000000000000099");
const config = { projectPath: projects, gamePath: join(root, "game"), workshopPath: join(root, "workshop"), defaultMod: "Default" } as Config;

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let call: Handler = async () => ({ content: [] });
registerWorkshopInfo({ registerTool: (_n: string, _d: unknown, h: Handler) => { call = h; } } as unknown as McpServer, config);
const text = async (args: Record<string, unknown>) => (await call(args)).content[0].text;

describe("workshop_info: finding the addon", () => {
  it("projectPath = the addon folder itself (the F0.5 case)", async () => {
    expect(await text({ projectPath: join(projects, "Alpha") })).toContain("AAAA000000000001");
  });

  it("modName finds addon.gproj", async () => {
    expect(await text({ modName: "Alpha" })).toContain("AAAA000000000001");
  });

  it("no arguments use ENFUSION_DEFAULT_MOD", async () => {
    expect(await text({})).toContain("DDDD000000000001");
  });

  it("refuses traversal and reports not found as an error", async () => {
    for (const modName of ["..\\Outside", "../Outside", "Missing"]) {
      const r = await call({ modName });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/No \.gproj found/);
    }
  });

  it("prints no publishing steps, only the neutral closing line", async () => {
    const t = await text({ modName: "Alpha" });
    expect(t).not.toMatch(/Steam|Click|File > Addon Publishing/);
    expect(t).toContain("This tool does not publish.");
  });
});

describe("workshop_info: dependencies", () => {
  // Loose dep -> Workshop dep -> base game, plus one GUID found nowhere
  addon(join(root, "game", "addons"), "data", "58D0FB3206B6F859");
  addon(join(root, "workshop"), "WsDep_BBBB000000000001", "BBBB000000000001", ["58D0FB3206B6F859"]);
  addon(projects, "LocalDep", "CCCC000000000001", ["BBBB000000000001"]);
  addon(projects, "Boat", "EEEE000000000001", ["58D0FB3206B6F859", "CCCC000000000001", "FFFF000000000001"]);

  it("names direct deps with their source and counts the closure with missing ones", async () => {
    const t = await text({ modName: "Boat" });
    expect(t).toContain("- 58D0FB3206B6F859 data Title (game)");
    expect(t).toContain("- CCCC000000000001 LocalDep Title (local)");
    expect(t).toMatch(/- FFFF000000000001 \(missing: /);
    expect(t).toContain("Closure: 3 addons found, 1 missing (FFFF000000000001)");
  });
});

describe("workshop_info: Workshop text lint", () => {
  const dir = addon(projects, "Texts", "1234000000000001");
  writeFileSync(join(dir, "README.md"), "Credits: model by someone.\n");
  writeFileSync(join(root, "summary.txt"), `${"s".repeat(200)}\n`);

  it("lints the gproj TITLE by default and the fields given", async () => {
    const t = await text({ modName: "Texts", summary: "A boat — fast", changeNotes: "ok" });
    expect(t).toContain("- name: ok (11/30)");
    expect(t).toContain("- summary: en or em dash: — at 8 (measured dialog limit; BI documents 1024)");
    expect(t).toContain("- changeNotes: ok (2/30000)");
    expect(t).not.toContain("- description:");
    expect(t).toContain("- licence: license.txt absent");
    expect(t).toMatch(/- reminder: README\.md mention credits/);
  });

  it("reads text files (last newline dropped) and flags a planned name that differs from TITLE", async () => {
    const t = await text({ modName: "Texts", name: "Texts (Boat)", textFiles: { summary: join(root, "summary.txt"), description: join(root, "nope.txt") } });
    expect(t).toContain('- name: characters not allowed: ( ) (info: .gproj TITLE is "Texts Title")');
    expect(t).toContain("- summary: ok (200/200)");
    expect(t).toMatch(/- description: cannot read .*nope\.txt/);
  });

  it("201 summary characters fail", async () => {
    expect(await text({ modName: "Texts", summary: "s".repeat(201) })).toContain("- summary: 201/200 characters");
  });
});

describe("workshop_info: preview image", () => {
  const png = (w: number, h: number, size = 33) => {
    const b = Buffer.alloc(size);
    b.writeUInt32BE(0x89504e47, 0);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };

  it("checks format, pixels and the 2 MB limit", async () => {
    writeFileSync(join(root, "ok.png"), png(1920, 1080));
    writeFileSync(join(root, "big.png"), png(1280, 720, 2 * 1024 * 1024 + 1));
    writeFileSync(join(root, "x.gif"), "GIF89a");
    expect(await text({ modName: "Alpha", previewImage: join(root, "ok.png") })).toContain("- PNG 1920x1080, 33 bytes: ok");
    expect(await text({ modName: "Alpha", previewImage: join(root, "big.png") })).toContain("2097153 bytes, over the 2 MB limit; info: 1280x720, 1920x1080 recommended");
    expect(await text({ modName: "Alpha", previewImage: join(root, "x.gif") })).toContain("not a PNG or JPG");
  });
});

describe("workshop_info: published state", () => {
  const page = readFileSync(join(__dirname, "..", "fixtures", "workshop-page.json"), "utf-8");
  const html = (json: string) => `<html><script id="__NEXT_DATA__" type="application/json">${json}</script></html>`;
  const stubFetch = (impl: (url: string) => Promise<Response>) => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => { urls.push(url); return impl(url); });
    return urls;
  };
  afterEach(() => vi.unstubAllGlobals());

  it("reads the local Workshop cache folder for the GUID", async () => {
    const d = join(root, "workshop", "Boat_EEEE000000000001");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "ServerData.json"), '﻿{"id":"EEEE000000000001","revision":{"version":"1.1.0"}}');
    writeFileSync(join(d, "meta"), '﻿{"meta":{"name":"Boat","summary":"Fast boat","license":"APL","versions":[{"version":"1.1.0"}]}}');
    expect(await text({ modName: "Boat" })).toContain('- Workshop cache Boat_EEEE000000000001: installed 1.1.0; name "Boat"; summary "Fast boat"; licence APL; versions 1.1.0');
    expect(await text({ modName: "Alpha" })).toMatch(/- Workshop cache: no folder for AAAA000000000001/);
  });

  it("is offline unless online is true", async () => {
    const urls = stubFetch(async () => new Response(html(page)));
    expect(await text({ modName: "Boat" })).not.toContain("- online");
    expect(urls).toEqual([]);
  });

  it("online: page fields, approval, dependency diff against the closure, next version", async () => {
    const urls = stubFetch(async () => new Response(html(page)));
    const t = await text({ modName: "Boat", online: true });
    expect(urls).toEqual(["https://reforger.armaplatform.com/workshop/EEEE000000000001"]);
    expect(t).toContain('name "Boat Test"; version 1.1.1 (approved); gameVersion 1.8.0.13; size 6254; licence Custom license');
    expect(t).toContain("- tags: VEHICLES; preview 1920x1080");
    expect(t).toContain("- published dependencies (2): Ws Dep BBBB000000000001 2.0.0; Extra 9999000000000001 1.0.0");
    // local closure minus vanilla: BBBB (workshop), CCCC (local), FFFF (missing)
    expect(t).toContain("- dependencies vs local closure: only published: 9999000000000001; only local: CCCC000000000001, FFFF000000000001");
    expect(t).toContain("- next version: 1.1.2");
  });

  it("online: 404, deleted asset, missing page JSON and a timeout each give one line and keep the report", async () => {
    stubFetch(async () => new Response("", { status: 404 }));
    expect(await text({ modName: "Boat", online: true })).toContain("not published yet (HTTP 404)");
    stubFetch(async () => new Response(html(page.replace('"deletedAt": null', '"deletedAt": "2026-01-01T00:00:00Z"'))));
    expect(await text({ modName: "Boat", online: true })).toContain("deleted from the Workshop (2026-01-01T00:00:00Z)");
    stubFetch(async () => new Response("<html></html>"));
    expect(await text({ modName: "Boat", online: true })).toContain("online check failed: no __NEXT_DATA__");
    stubFetch(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    const t = await text({ modName: "Boat", online: true });
    expect(t).toContain("online check failed: The operation was aborted due to timeout");
    expect(t).toContain("This tool does not publish.");
  });

  it("next version keeps each part within 32000", () => {
    expect(nextVersion("1.1.1")).toBe("1.1.2");
    expect(nextVersion("1.2.32000")).toMatch(/^none \(patch would pass 32000/);
    expect(nextVersion("1.0")).toMatch(/^none \(version "1.0"/);
  });
});
