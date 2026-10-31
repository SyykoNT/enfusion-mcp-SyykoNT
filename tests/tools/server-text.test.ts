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
});

const PROMPTS = [
  { name: "create-mod", arguments: { description: "test" } },
  { name: "modify-mod", arguments: { projectPath: "C:/x", task: "test" } },
  { name: "server-mod", arguments: { goal: "test" } },
];
