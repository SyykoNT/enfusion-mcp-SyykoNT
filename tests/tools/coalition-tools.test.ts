import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { serverInstructions } from "../../src/server-instructions.js";

const NINE = [
  "coalition_doctor", "mission_inspect", "mission_validate", "gearscript_inspect", "mission_names",
  "mission_git", "mission_pr_draft", "mission_preflight", "server_params",
];
const OFF_SENTENCE = "COALITION mission-making tools are off. If the user asks to enable them, set ENFUSION_COALITION_TOOLS=on";

// Builds the server the way src/index.ts does, with ENFUSION_COALITION_TOOLS set to `setting` (unset when undefined).
async function connect(setting?: string): Promise<{ names: string[]; instructions: string }> {
  const saved = process.env.ENFUSION_COALITION_TOOLS;
  if (setting === undefined) delete process.env.ENFUSION_COALITION_TOOLS;
  else process.env.ENFUSION_COALITION_TOOLS = setting;
  try {
    const config = loadConfig();
    const server = new McpServer({ name: "t", version: "0" }, { instructions: serverInstructions(config) });
    registerTools(server, config);
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    const instructions = client.getInstructions() ?? "";
    await client.close();
    return { names, instructions };
  } finally {
    if (saved === undefined) delete process.env.ENFUSION_COALITION_TOOLS;
    else process.env.ENFUSION_COALITION_TOOLS = saved;
  }
}

describe("ENFUSION_COALITION_TOOLS", () => {
  it.each(["on", "ON", "1", "true"])("%s registers the nine COALITION tools", async (value) => {
    const { names } = await connect(value);
    for (const n of NINE) expect(names, n).toContain(n);
  });

  it.each([undefined, "", "off", "0", "false", "yes"])("%s leaves the nine off and every other tool as it is", async (value) => {
    const on = (await connect("on")).names;
    const off = (await connect(value)).names;
    expect(off).toEqual(on.filter((n) => !NINE.includes(n)));
    expect(off).toContain("log_watch");
    expect(off).toContain("script_errors");
    expect(off).toContain("mission_server");
  });

  it("tells the agent how to turn them on only while they are off", async () => {
    expect((await connect()).instructions).toContain(OFF_SENTENCE);
    expect((await connect("off")).instructions).toContain(OFF_SENTENCE);
    expect((await connect("on")).instructions).not.toContain("COALITION");
    expect((await connect()).instructions.length).toBeLessThan(4096);
  });
});
