import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { SERVER_INSTRUCTIONS } from "../../src/server-instructions.js";

// src/index.ts connects to stdio at import time, so build the same server here.
async function connect(): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, loadConfig());
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

let client: Client;
beforeAll(async () => { client = await connect(); });
afterAll(async () => { await client.close(); });

describe("server text", () => {
  it("sends instructions under the 4,096-char client cap", () => {
    const text = client.getInstructions() ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThan(4096);
  });

  it("prompts carry no autonomy directives or close-Workbench advice", async () => {
    for (const p of PROMPTS) {
      const text = JSON.stringify(await client.getPrompt(p));
      expect(text, p.name).not.toMatch(/fully autonomous|you are autonomous|MUST NEVER contain|close it first with|wb_close\*\* first/i);
    }
  });

  it("tool descriptions drop the claims PX-I3 found wrong", async () => {
    // Stringifying covers top-level and every inputSchema property description.
    const text = JSON.stringify((await client.listTools()).tools);
    expect(text).not.toMatch(/rarely need to call this directly|Tools,Reload Scripts|opens to its launcher|all wiki content is already available/);
  });

  it("server text holds no literal GUID outside the verified allowlist", async () => {
    const parts = [client.getInstructions() ?? "", JSON.stringify((await client.listTools()).tools)];
    for (const p of PROMPTS) parts.push(JSON.stringify(await client.getPrompt(p)));
    expect(unknownGuids(parts.join("\n"))).toEqual([]);
  });

  it("the GUID guard catches a GUID that is not in 1.8 data", () => {
    expect(unknownGuids("'{5F4C4181F065B447}Assets/Props/Military/Barrels/BarrelGreen_01.xob'")).toEqual(["{5F4C4181F065B447}"]);
  });
});

// Each entry was found in 1.8 game data with asset_search or game_read (2026-10-31).
const VERIFIED_GUIDS = new Set([
  "{ECC61978EDCC2B5A}", // Missions/23_Campaign.conf
  "{9DF143A76F5C6460}", // worlds/MP/CTI_Campaign_Eden.ent (World line of 23_Campaign.conf)
  "{657590C1EC9E27D3}", // Prefabs/Groups/OPFOR/Group_USSR_LightFireTeam.et
  "{51BC713E81C18CF3}", // config_override object ID example, an ID inside a config, not a resource
]);

function unknownGuids(text: string): string[] {
  return [...new Set(text.match(/\{[0-9A-Fa-f]{16}\}/g) ?? [])].filter((g) => !VERIFIED_GUIDS.has(g));
}

const PROMPTS: { name: string; arguments: Record<string, string> }[] = [
  { name: "create-mod", arguments: { description: "test" } },
  { name: "modify-mod", arguments: { projectPath: "C:/x", task: "test" } },
  { name: "server-mod", arguments: { goal: "test" } },
];
