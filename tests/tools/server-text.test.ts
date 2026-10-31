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
});
