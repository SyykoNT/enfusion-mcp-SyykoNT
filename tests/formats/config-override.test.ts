import { describe, it, expect } from "vitest";
import { parse } from "../../src/formats/enfusion-text.js";
import {
  resolveEffective, buildDelta, mergeNode, mergeOverride, overrideMeta, flatten, lookup, scaleNumber,
} from "../../src/formats/config-override.js";

// Trimmed from Configs/Campaign/XPRewards.conf and CampaignXPRewards.conf (Arma Reforger 1.8)
const files: Record<string, string> = {
  "Configs/Campaign/XPRewards.conf": `SCR_XPRewardList {
 m_aRewardList {
  SCR_XPRewardInfo "{51BC713E81C18CF3}" {
   m_eRewardID ENEMY_KILL
   m_iRewardXP 20
  }
  SCR_XPRewardInfo "{5E0E812547C995B6}" {
   m_eRewardID SUICIDE
   m_iRewardXP 0
  }
 }
}`,
  "Configs/Campaign/CampaignXPRewards.conf": `SCR_XPRewardList : "{E6FC4537B53EA00B}Configs/Campaign/XPRewards.conf" {
 m_aRewardList {
  SCR_XPRewardInfo "{5E0E812547C995B6}" {
   m_iRewardXP -40
  }
 }
}`,
};
const read = (p: string) => files[p] ?? null;

describe("config override engine", () => {
  it("merges a file over its inheritance chain", () => {
    const eff = resolveEffective(read, "{0000000000000000}Configs/Campaign/CampaignXPRewards.conf")!;
    expect(eff.chain).toEqual(["Configs/Campaign/CampaignXPRewards.conf", "Configs/Campaign/XPRewards.conf"]);
    const objs = flatten(eff.root).filter((o) => o.node.id);
    expect(objs.map((o) => [lookup(o, "m_eRewardID"), o.props.m_iRewardXP])).toEqual([["ENEMY_KILL", "20"], ["SUICIDE", "-40"]]);
    // header of the overridden file is kept
    expect(eff.root.inheritance).toBe("{E6FC4537B53EA00B}Configs/Campaign/XPRewards.conf");
  });

  it("emits only the changed values, addressed by object ID", () => {
    const eff = resolveEffective(read, "Configs/Campaign/CampaignXPRewards.conf")!;
    const { delta, changes } = buildDelta(eff.root, [
      { match: (o) => lookup(o, "m_eRewardID") === "ENEMY_KILL", property: "m_iRewardXP", value: "100" },
      { match: (o) => lookup(o, "m_eRewardID") === "SUICIDE", property: "m_iRewardXP", value: "-40" }, // unchanged
    ]);
    expect(changes).toEqual([{ object: expect.stringContaining("ENEMY_KILL"), property: "m_iRewardXP", from: "20", to: "100" }]);
    const tree = parse(mergeOverride(null, delta));
    expect(tree.type).toBe("SCR_XPRewardList");
    expect(tree.inheritance).toBe("{E6FC4537B53EA00B}Configs/Campaign/XPRewards.conf");
    const entries = tree.children[0].children;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("{51BC713E81C18CF3}");
    expect(entries[0].properties).toMatchObject([{ key: "m_iRewardXP", value: "100" }]);
  });

  it("keeps earlier edits when merging into an existing override", () => {
    const eff = resolveEffective(read, "Configs/Campaign/XPRewards.conf")!;
    const first = mergeOverride(null, buildDelta(eff.root, [{ match: (o) => o.props.m_eRewardID === "ENEMY_KILL", property: "m_iRewardXP", value: "50" }]).delta);
    const second = mergeOverride(first, buildDelta(eff.root, [{ match: (o) => o.props.m_eRewardID === "SUICIDE", property: "m_iRewardXP", value: "-10" }]).delta);
    const ids = parse(second).children[0].children.map((c) => [c.id, c.properties[0].value]);
    expect(ids).toEqual([["{51BC713E81C18CF3}", "50"], ["{5E0E812547C995B6}", "-10"]]);
  });

  it("keeps every untouched byte of an existing override", () => {
    const existing = [
      'SCR_Root : "{0000000000000001}Configs/Base.conf" {',
      ' Class "COA_PauseMenuUI"',
      " ParentContextList + {",
      '  "a"',
      " }",
      " HitZones {",
      '  SCR_GearboxHitZone Gearbox_01 : "{0000000000000002}g.conf" {',
      "   MaxHealth 5",
      "  }",
      " }",
      " m_aSlots {",
      "  RIFLEMAN",
      "  MEDIC",
      " }",
      "}",
      "",
    ].join("\r\n");
    const eff = parse(existing);
    const { delta } = buildDelta(eff, [{ match: (o) => o.node.id === "Gearbox_01", property: "MaxHealth", value: "7" }]);
    expect(mergeOverride(existing, delta)).toBe(existing.replace("MaxHealth 5", "MaxHealth 7"));
    const empty = buildDelta(eff, []).delta;
    expect(mergeOverride(existing, empty)).toBe(existing);
    expect(mergeOverride("﻿" + existing, empty)).toBe("﻿" + existing);
  });

  it("writes a new override line the way the base file writes that key", () => {
    const eff = parse('SCR_Root {\n Class "COA_PauseMenuUI"\n m_eType Alpha\n}');
    const { delta } = buildDelta(eff, [
      { match: () => true, property: "Class", value: "COA_Other" },
      { match: () => true, property: "m_eType", value: "Bravo" },
    ]);
    expect(mergeOverride(null, delta)).toBe('SCR_Root {\n Class "COA_Other"\n m_eType Bravo\n}');
  });

  it("does not fold named conf-inherited list entries into one (D20)", () => {
    const base = parse('V {\n m_Seats {\n  CargoCompartmentSlot Driver {\n   SeatName "Driver"\n  }\n }\n}');
    const seats = [1, 2, 3, 4, 5].map((k) =>
      `  CargoCompartmentSlot Passenger_${k} : "{0000000000000005}CargoCompartment_BTR70.conf" {\n   SeatName "P${k}"\n  }`);
    const over = parse(`V : "{0000000000000006}v.et" {\n m_Seats {\n${seats.join("\n")}\n }\n}`);
    const merged = mergeNode(base, over).children[0].children;
    expect(merged.map((s) => [s.id, s.properties[0].value])).toEqual([
      ["Driver", "Driver"], ["Passenger_1", "P1"], ["Passenger_2", "P2"], ["Passenger_3", "P3"], ["Passenger_4", "P4"], ["Passenger_5", "P5"],
    ]);
  });

  it("writes a meta carrying the base GUID", () => {
    expect(overrideMeta("E6FC4537B53EA00B", "Configs/Campaign/XPRewards.conf")).toContain('Name "{E6FC4537B53EA00B}Configs/Campaign/XPRewards.conf"');
  });

  it("scales numbers keeping ints as ints", () => {
    expect(scaleNumber("20", 1.5)).toBe("30");
    expect(scaleNumber("88.5", 2)).toBe("177");
    expect(scaleNumber("0.25", 3)).toBe("0.75");
    expect(scaleNumber(undefined, 2)).toBeNull();
  });
});
