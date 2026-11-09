import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { registerScenarioTools } from "../../src/tools/wb-scenario.js";

type Result = { content: { text: string }[]; isError?: boolean };
let create!: (args: Record<string, unknown>) => Promise<Result>;
const client = {
  state: { connected: true, mode: "edit" },
  port: 5775,
  endpoint: "127.0.0.1:5775",
  probeMode: async () => "edit",
  call: async () => ({ status: "ok" }),
} as unknown as WorkbenchClient;
registerScenarioTools({ registerTool: (_n: string, _d: unknown, h: typeof create) => { create = h; } } as unknown as McpServer, client);

const base = (baseType: string) =>
  create({ type: "base", baseName: "Alpha", baseFaction: "US", baseType, position: "1 0 1", patrolCount: 0 });

describe("scenario_create (type base) next steps", () => {
  it("step 3 names the flags an entry needs, because an entry clears the base's own", async () => {
    const mob = (await base("MOB")).content[0].text;
    expect(mob).toContain("3. Add Alpha_Base to the mission header m_aCampaignCustomBaseList with m_bCanBeHQ 1 and m_bIsControlPoint 1: an entry replaces the base's own flags");
    const plain = (await base("base")).content[0].text;
    expect(plain).toContain("3. Add Alpha_Base to the mission header m_aCampaignCustomBaseList with m_bIsControlPoint 1 if it is a major base");
    expect(plain).not.toContain("m_bCanBeHQ 1 and");
  });

  it("step 5 asks for at least 2 MOBs, not one per faction", async () => {
    for (const type of ["MOB", "base"]) {
      const text = (await base(type)).content[0].text;
      expect(text).toContain("5. A Conflict mission needs at least 2 MOBs");
      expect(text).not.toContain("one MOB per faction");
    }
  });
});
