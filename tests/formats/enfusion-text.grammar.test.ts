import { describe, it, expect } from "vitest";
import { parse, parseAll, serialize, serializeAll, setProperty, getProperty, type EnfusionNode } from "../../src/formats/enfusion-text.js";

// Hand-written snippets of the shapes found in game and addon files (XC-I1 section 2.1, D01 to D21)
const D = {
  append: 'S {\n Filenames + {\n  "a.wav"\n }\n ActionRefs +{\n  "b"\n }\n}',
  numbers: "L {\n Layers 0x4040 0\n Scale 1e-05 0 -0.5\n}",
  continued: 'T {\n m_sText "line1"\\\n "line2"\n m_i 3\n}',
  continued3: 'T {\n s "a"\\\n ""\\\n "c"\n m_i 3\n}',
  group: '$grp GenericEntity : "{0000000000000001}p.et" {\n n1 {\n  coords 1 2 3\n }\n {\n  coords 4 5 6\n }\n}',
  gearbox: 'V {\n HitZones {\n  SCR_GearboxHitZone Gearbox_01 : "{0000000000000002}g.conf" {\n   MaxHealth 5\n  }\n }\n}',
  childBlock: 'P : "{0000000000000003}p.et" {\n coords 1 2 3\n {\n  C {\n   x 1\n  }\n }\n m_i 2\n}',
  threeWord: "V {\n Engine Engine Engine {\n }\n SlotTemplate InventoryStorageSlot m2box {\n }\n}",
  quotedKey: 'W {\n "Additional hit zones" {\n }\n "Turned on" 0\n}',
  lists: "G {\n m_aLabels + {\n  TRAIT_A TRAIT_B TRAIT_C\n }\n DoorInfoList {\n  0 1\n }\n m_aSlots {\n  RIFLEMAN\n  MEDIC\n  RIFLEMAN\n }\n}",
  order: 'E {\n ID "1"\n components {\n }\n coords 1 2 3\n}',
  meta: 'MetaFileClass {\n Name "{0000000000000004}m.xob"\n Configurations {\n  FBXResourceClass PC {\n   ExportSkinning 1\n  }\n  FBXResourceClass XBOX_ONE : PC {\n  }\n }\n}',
  suspension: 'W {\n Suspension VehicleSuspension "{0000000000000007}" : "{0000000000000008}s.conf" {\n  Stiffness 2\n }\n}',
  ast: 'AnimSetTemplateSource_AnimationGroup "{0000000000000009}" {\n Name "Vehicle"\n}',
  agf: 'AnimSrcNodeQueue "{000000000000000B}" {\n Items {\n  AnimSrcNodeQueueItem "{000000000000000A}" {\n   Child "Idle"\n  }\n }\n}',
  quotes: 'C {\n m_sName "Alpha"\n ID "1"\n Class "COA_PauseMenuUI"\n m_eType Alpha\n}',
  escapes: 'X {\n s "a \\"b\\""\n u "\\u1f600"\n p "a\\\\b \\"q\\""\n t 1\n}',
};

const child = (n: EnfusionNode, type: string) => n.children.find((c) => c.type === type)!;

describe("enfusion-text tokenizer", () => {
  it("reads + alone and before a brace as append", () => {
    const n = parse(D.append);
    expect(n.children.map((c) => [c.type, c.append, c.values])).toEqual([["Filenames", true, ["a.wav"]], ["ActionRefs", true, ["b"]]]);
  });

  it("reads hex, exponent and signed numbers as one tuple", () => {
    expect(parse(D.numbers).properties).toMatchObject([
      { key: "Layers", value: "0x4040 0", quoted: false },
      { key: "Scale", value: "1e-05 0 -0.5", quoted: false },
    ]);
  });

  it("treats only \\\" as an escape", () => {
    const n = parse(D.escapes);
    expect(getProperty(n, "s")).toBe('a "b"');
    expect(getProperty(n, "u")).toBe("\\u1f600");
    expect(getProperty(n, "p")).toBe('a\\\\b "q"');
    expect(getProperty(n, "t")).toBe("1");
  });

  it("joins a continued string of three pieces with an empty middle", () => {
    const n = parse(D.continued3);
    expect(getProperty(n, "s")).toBe("a\n\nc");
    expect(getProperty(n, "m_i")).toBe("3");
  });

  it("names the line of an unterminated string", () => {
    expect(() => parse('X {\n a 1\n s "abc\n}')).toThrow(/line 3: unterminated string/);
  });
});

describe("enfusion-text parser", () => {
  it("D01: reads every top-level object", () => {
    const text = "A {\n x 1\n}\nB {\n y 2\n}";
    expect(parseAll(text).map((n) => n.type)).toEqual(["A", "B"]);
    expect(() => parse(text)).toThrow("2 top-level objects; use parseAll()");
  });

  it("D02: an empty file has no objects", () => {
    expect(parseAll("")).toEqual([]);
    expect(parseAll(" \r\n")).toEqual([]);
    expect(() => parse("")).toThrow("Empty input");
  });

  it("D03: key + { sets append", () => {
    expect(parse(D.append).children[0]).toMatchObject({ type: "Filenames", append: true });
  });

  it("D04: a continued string is one value and the next key stays a property", () => {
    const n = parse(D.continued);
    expect(getProperty(n, "m_sText")).toBe("line1\nline2");
    expect(n.properties.map((p) => p.key)).toEqual(["m_sText", "m_i"]);
  });

  it("D05: $grp with a named and a bare member", () => {
    const n = parse(D.group);
    expect(n).toMatchObject({ type: "GenericEntity", group: true, inheritance: "{0000000000000001}p.et", properties: [] });
    expect(n.children.map((c) => [c.type, c.id, getProperty(c, "coords")])).toEqual([["", "n1", "1 2 3"], ["", undefined, "4 5 6"]]);
  });

  it("D06: named conf-inherited object in a list", () => {
    expect(parse(D.gearbox).children[0]).toMatchObject({
      type: "HitZones",
      children: [{ type: "SCR_GearboxHitZone", id: "Gearbox_01", inheritance: "{0000000000000002}g.conf", properties: [{ key: "MaxHealth", value: "5", quoted: false }] }],
    });
  });

  it("D07: an anonymous child block keeps the parent's later members", () => {
    const n = parse(D.childBlock);
    expect(n.children).toHaveLength(1);
    expect(n.children[0]).toMatchObject({ type: "", children: [{ type: "C" }] });
    expect(getProperty(n, "m_i")).toBe("2");
  });

  it("D08: key Class Name {", () => {
    const n = parse(D.threeWord);
    expect(n.properties).toEqual([]);
    expect(n.children.map((c) => [c.type, c.className, c.id])).toEqual([["Engine", "Engine", "Engine"], ["SlotTemplate", "InventoryStorageSlot", "m2box"]]);
  });

  it("D09: quoted key as a block head", () => {
    const n = parse(D.quotedKey);
    expect(n.children[0].type).toBe("Additional hit zones");
    n.children[0].append = true; // head edited: canonical text must quote the key
    expect(serialize(n)).toContain('"Additional hit zones" + {');
  });

  it("D12 and D13: value lists stay values", () => {
    const n = parse(D.lists);
    expect(child(n, "m_aLabels")).toMatchObject({ values: ["TRAIT_A", "TRAIT_B", "TRAIT_C"], valuesQuoted: [false, false, false], properties: [] });
    expect(child(n, "DoorInfoList")).toMatchObject({ values: ["0", "1"], properties: [] });
    expect(child(n, "m_aSlots")).toMatchObject({ values: ["RIFLEMAN", "MEDIC", "RIFLEMAN"], valuesQuoted: [false, false, false], properties: [] });
  });

  it("D16: .meta platform blocks with a sibling as parent", () => {
    const conf = child(parse(D.meta), "Configurations");
    expect(conf.children.map((c) => [c.type, c.id, c.inheritance])).toEqual([["FBXResourceClass", "PC", undefined], ["FBXResourceClass", "XBOX_ONE", "PC"]]);
    expect(getProperty(conf.children[0], "ExportSkinning")).toBe("1");
  });

  it("D18: brace errors name the line", () => {
    expect(() => parse("A {\n B {\n  x 1\n }\n }\n}")).toThrow(/line 6: '}' without a matching '\{' \(indent first disagrees with depth at line 5\)/);
    expect(() => parse("A {\n x 1\n")).toThrow(/line 1: '\{' never closed/);
  });

  it("D18: a line that is not key value throws", () => {
    expect(() => parse("X {\n a b c\n}")).toThrow("line 2: 'a b c' is not 'key value'");
  });

  it("D19: key Class {ID} : parent { is one node", () => {
    expect(parse(D.suspension).children[0]).toMatchObject({
      type: "Suspension", className: "VehicleSuspension", id: "{0000000000000007}", inheritance: "{0000000000000008}s.conf",
      properties: [{ key: "Stiffness", value: "2" }],
    });
  });

  it("animation files keep GUID ids", () => {
    expect(parse(D.ast)).toMatchObject({ type: "AnimSetTemplateSource_AnimationGroup", id: "{0000000000000009}" });
    expect(child(parse(D.agf), "Items").children[0]).toMatchObject({ type: "AnimSrcNodeQueueItem", id: "{000000000000000A}" });
  });

  it("D21: the legacy animation graph format throws", () => {
    expect(() => parse('$AnimGraph 8 {\n $Sheet "Master" {\n }\n}')).toThrow("line 2: unexpected 'Master' in block head");
  });
});

describe("enfusion-text serializer", () => {
  it("round-trips every snippet byte for byte", () => {
    for (const text of Object.values(D)) expect(serialize(parse(text))).toBe(text);
  });

  it("round-trips a CRLF .layer of three entities", () => {
    const text = ['GenericEntity : "{000000000000000C}a.et" {', ' coords 1 2 3', '}', "SCR_AIGroup {", ' m_aUnitPrefabSlots {', '  "{000000000000000D}b.et"', " }", "}", "$grp E {", " x {", " }", "}"].join("\r\n");
    const nodes = parseAll(text);
    expect(nodes).toHaveLength(3);
    expect(serializeAll(nodes, "\r\n")).toBe(text);
  });

  it("keeps source quoting after a value is edited", () => {
    const n = parse(D.quotes);
    setProperty(n, "m_sName", "Bravo");
    setProperty(n, "ID", "2");
    setProperty(n, "Class", "COA_Other");
    setProperty(n, "m_eType", "Bravo");
    expect(serialize(n)).toBe('C {\n m_sName "Bravo"\n ID "2"\n Class "COA_Other"\n m_eType Bravo\n}');
    setProperty(n, "m_eType", "has space\tand tab"); // cannot stay bare; a TAB stays literal
    expect(serialize(n)).toContain(' m_eType "has space\tand tab"');
  });

  it("changes only the edited line", () => {
    const n = parse(D.gearbox);
    setProperty(n.children[0].children[0], "MaxHealth", "7");
    expect(serialize(n)).toBe(D.gearbox.replace("MaxHealth 5", "MaxHealth 7"));
  });

  it("writes an edited list one value per line with its source quoting", () => {
    const n = parse('G {\n m_aLabels + {\n  TRAIT_A TRAIT_B "TRAIT_C"\n }\n}');
    n.children[0].values.push("TRAIT_D");
    expect(serialize(n)).toBe('G {\n m_aLabels + {\n  TRAIT_A\n  TRAIT_B\n  "TRAIT_C"\n  "TRAIT_D"\n }\n}');
  });

  it("puts a new property after the last positioned member", () => {
    const n = parse("N {\n a 1\n B {\n }\n}");
    setProperty(n, "c", "2");
    expect(serialize(n)).toBe("N {\n a 1\n B {\n }\n c 2\n}");
  });

  it("refuses a string ending in a backslash", () => {
    const n = parse('T {\n p "x"\n}');
    setProperty(n, "p", "a\\");
    expect(() => serialize(n)).toThrow(/backslash/);
  });
});
