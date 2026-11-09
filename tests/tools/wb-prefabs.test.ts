import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Socket } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbPrefabs, locateRequest } from "../../src/tools/wb-prefabs.js";
import { decodeInt32LE, decodePascalString, encodePascalString } from "../../src/workbench/protocol.js";

type Result = { content: { text: string }[]; isError?: boolean };

/** Fake Workbench NET API (same shape as the one in wb-save.test.ts): answers with handler(apiFunc, params). */
function mockWorkbench(handler: (apiFunc: string, params: Record<string, unknown>) => unknown) {
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      const buf = Buffer.concat(chunks);
      let offset = decodeInt32LE(buf, 0).bytesRead;
      offset += decodePascalString(buf, offset).bytesRead;
      offset += decodePascalString(buf, offset).bytesRead;
      const { APIFunc, ...params } = JSON.parse(decodePascalString(buf, offset).value);
      socket.end(Buffer.concat([encodePascalString("Ok"), encodePascalString(JSON.stringify(handler(APIFunc, params)))]));
    });
  });
  server.listen(0);
  const addr = server.address();
  return { port: addr && typeof addr !== "string" ? addr.port : 0, close: () => new Promise<void>((res) => server.close(() => res())) };
}

let mock: ReturnType<typeof mockWorkbench> | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

/** wb_prefabs locate against a mock that records every NET API call and replies with `reply`. */
async function locate(searchPath: string, reply: unknown = { status: "OK", message: "", prefabsPaths: [] }) {
  const calls: { f: string; p: Record<string, unknown> }[] = [];
  mock = mockWorkbench((f, p) => (calls.push({ f, p }), reply));
  const client = new WorkbenchClient("127.0.0.1", mock.port);
  let tool: ((args: Record<string, unknown>) => Promise<Result>) | undefined;
  registerWbPrefabs({ registerTool: (_n: string, _d: unknown, h: typeof tool) => (tool = h) } as unknown as McpServer, client);
  return { calls, r: await tool!({ action: "locate", searchPath }) };
}

const twelve = Array.from({ length: 12 }, (_, i) => `Prefabs/Weapons/Rifles/AK74/Rifle_${i}.et`);

describe("wb_prefabs locate", () => {
  it("sends the vanilla fields for a vanilla path", async () => {
    const { calls } = await locate("Prefabs/Weapons/Rifles/AK74");
    expect(calls).toEqual([{ f: "LocatePrefabsFromPath", p: { selectedProject: "ArmaReforger", projectPath: "Prefabs", selectedFolder: "Prefabs/Weapons/Rifles/AK74" } }]);
  });

  it("sends the vanilla fields for an addon path", async () => {
    const { calls } = await locate("$MyAddon:Prefabs/Props\\");
    expect(calls).toEqual([{ f: "LocatePrefabsFromPath", p: { selectedProject: "MyAddon", projectPath: "$MyAddon:Prefabs", selectedFolder: "$MyAddon:Prefabs/Props" } }]);
  });

  it.each(["", "   ", "/", "\\", ".", "./", "..", "Prefabs/../..", "$MyAddon:", "$MyAddon:/", "C:", "C:/", "$ArmaReforger:.", "$ArmaReforger:./", "$MyAddon:..", "C:.", "/ /", "$:", "$:Prefabs/X", "$ :", "$MyAddon:/ . /", "$MyAddon:Prefabs/ .. ", "Prefabs", "Prefabs/", " Prefabs ", "C:Prefabs", "...", ". .", "Prefabs/...", "$ArmaReforger:...", "$ArmaReforger:. .", "$MyAddon:\u0000", "\u0000/\u0000", "\u0001/\u0001", "$ArmaReforger:\u200b", "\u200b/\u200b", "Prefabs/Weapons/\u200b", "D:Prefabs/X", "C:/Windows/System32", "C:\\Windows\\System32", "//server/share", "\\\\server\\share", "/C:/Windows/System32", "\\C:\\Windows\\System32", "./C:/Windows", " /C:/Users/x", "/D:Prefabs/X", "$MyAddon:C:/Windows", "Prefabs/C:/Windows", "/$MyAddon:/Prefabs", "$..:Prefabs/X", "$...:Prefabs/X", "$. .:Prefabs/X", "$.:Prefabs/X"])("refuses %j before any NET API call", async (p) => {
    expect(locateRequest(p)).toBeUndefined();
    const { calls, r } = await locate(p);
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
    if (p.trim()) expect(r.content[0].text).toContain(`"${p}"`);
  });

  it.each([["$..\\..:Prefabs/X", "..\\.."], ["$My\\Addon:Prefabs/X", "My\\Addon"], ["$..:Prefabs/X", ".."]])("refuses %j without a NET API call and names the addon name", async (p, name) => {
    expect(locateRequest(p)).toBeUndefined();
    const { calls, r } = await locate(p);
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(r.content[0].text).toContain(`The addon name "${name}" must be a plain name`);
  });

  it.each([
    ["Prefabs/Weapons/Rifles", "ArmaReforger", "Prefabs", "Prefabs/Weapons/Rifles"],
    [" Prefabs\\Weapons\\Rifles\\ ", "ArmaReforger", "Prefabs", "Prefabs/Weapons/Rifles"],
    ["./Prefabs//Weapons/./Rifles/.", "ArmaReforger", "Prefabs", "Prefabs/Weapons/Rifles"],
    ["Prefabs/a.b/..x", "ArmaReforger", "Prefabs", "Prefabs/a.b/..x"],
    ["$ArmaReforger:Prefabs/Weapons", "ArmaReforger", "$ArmaReforger:Prefabs", "$ArmaReforger:Prefabs/Weapons"],
    ["$My Addon:Prefabs/Props", "My Addon", "$My Addon:Prefabs", "$My Addon:Prefabs/Props"],
    ["$MyAddon:Prefabs/X", "MyAddon", "$MyAddon:Prefabs", "$MyAddon:Prefabs/X"],
    ["$MyAddon.v2:Prefabs", "MyAddon.v2", "$MyAddon.v2:Prefabs", "$MyAddon.v2:Prefabs"],
  ])("keeps %j", (p, selectedProject, projectPath, selectedFolder) => {
    expect(locateRequest(p)).toEqual({ selectedProject, projectPath, selectedFolder });
  });

  it("allows a single segment under an addon prefix", async () => {
    const { calls } = await locate("$MyAddon:Prefabs");
    expect(calls).toEqual([{ f: "LocatePrefabsFromPath", p: { selectedProject: "MyAddon", projectPath: "$MyAddon:Prefabs", selectedFolder: "$MyAddon:Prefabs" } }]);
  });

  it("lists prefabsPaths from an OK reply", async () => {
    const { r } = await locate("Prefabs/Weapons/Rifles/AK74", { status: "OK", message: "", prefabsPaths: twelve });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("(12)");
    expect(r.content[0].text).toContain("- Prefabs/Weapons/Rifles/AK74/Rifle_11.et");
  });

  it("returns the handler's message for an ERROR reply", async () => {
    const message = "Could not find any Prefabs! Does Prefabs/Nope folder exist in your project? Does Prefabs/Nope folder contain any prefabs?";
    const { r } = await locate("Prefabs/Nope", { status: "ERROR", message, prefabsPaths: null });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(message);
  });
});
