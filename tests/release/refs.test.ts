import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { collectRefs, classifyRefs, metaGuids } from "../../src/release/refs.js";

const dir = mkdtempSync(join(tmpdir(), "emcp-refs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
put("Prefabs/Boat.et", 'Vehicle : "{AAAAAAAAAAAAAAA1}Prefabs/Base.et" {\n Mesh "{bbbbbbbbbbbbbbb2}Assets/Hull.xob"\n Own "{CCCCCCCCCCCCCCC3}Prefabs/Own.et"\n}\n');
put("Prefabs/Own.et.meta", 'MetaFileClass {\n Name "{CCCCCCCCCCCCCCC3}Prefabs/Own.et"\n}\n');
put("Worlds/W.ent", 'Ent : "{DDDDDDDDDDDDDDD4}Prefabs/Gone.et" {\n}\n');
put("Worlds/W_Layers/default.layer", 'X : "{AAAAAAAAAAAAAAA1}Prefabs/Base.et" {\n}\n');
put("Scripts/Game/S.c", 'static const ResourceName R = "{BBBBBBBBBBBBBBB2}Assets/Hull.xob";\n');
put("Docs/readme.txt", '"{EEEEEEEEEEEEEEE5}Prefabs/Txt.et"');
put(".git/objects/x.et", '"{FFFFFFFFFFFFFFF6}Prefabs/Git.et"');

describe("collectRefs", () => {
  it("finds refs in resource and script files only, upper-cases GUIDs and skips dot folders", () => {
    const refs = collectRefs(dir);
    expect(refs.map((r) => `${r.guid} ${r.file}`).sort()).toEqual([
      "AAAAAAAAAAAAAAA1 Prefabs/Boat.et",
      "AAAAAAAAAAAAAAA1 Worlds/W_Layers/default.layer",
      "BBBBBBBBBBBBBBB2 Prefabs/Boat.et",
      "BBBBBBBBBBBBBBB2 Scripts/Game/S.c",
      "CCCCCCCCCCCCCCC3 Prefabs/Boat.et",
      "DDDDDDDDDDDDDDD4 Worlds/W.ent",
    ]);
    expect(refs.find((r) => r.file === "Prefabs/Boat.et" && r.guid.startsWith("B"))!.path).toBe("Assets/Hull.xob");
  });

  it("filters by exact file or folder prefix, with either slash", () => {
    expect(collectRefs(dir, ["Worlds\\W.ent", "Worlds\\W_Layers\\"]).map((r) => r.file).sort()).toEqual(["Worlds/W.ent", "Worlds/W_Layers/default.layer"]);
    expect(collectRefs(dir, ["Worlds/W"])).toEqual([]);
  });
});

describe("classifyRefs", () => {
  it("sorts refs into own, closure, undeclared and dangling", () => {
    const kinds = classifyRefs(
      collectRefs(dir, ["Prefabs", "Worlds/W.ent"]),
      metaGuids(dir),
      new Map([["AAAAAAAAAAAAAAA1", "MODA"]]),
      new Map([["BBBBBBBBBBBBBBB2", "MODB"], ["AAAAAAAAAAAAAAA1", "LATER"]])
    ).map((c) => `${c.ref.guid[0]} ${c.kind} ${c.owner ?? "-"}`).sort();
    expect(kinds).toEqual(["A closure MODA", "B undeclared MODB", "C own -", "D dangling -"]);
  });
});
