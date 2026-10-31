import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Config } from "../../src/config.js";
import { buildTestPak, buildRdb } from "./test-pak.js";

/** GUIDs of the fake resources (16 hex chars, as in a real rdb). */
export const G = {
  pantsBase: "1111111111111111",
  pantsBdu: "2222222222222222",
  guerilla: "3333333333333333",
  character: "37578B1666981FCE",
  shadow: "9999999999999999",
};

const gproj = (id: string, guid: string, deps: string[]) =>
  `GameProject {\n ID "${id}"\n GUID "${guid}"\n TITLE "${id}"\n Dependencies {\n  ${deps.map((d) => `"${d}"`).join(" ")}\n }\n}\n`;

function put(root: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

/** A packed addon folder: the .gproj loose, everything else in data.pak, GUIDs in its rdb. */
function packed(root: string, files: Record<string, string>, guids: Record<string, string>) {
  mkdirSync(root, { recursive: true });
  const inPak: Array<{ path: string; content: string; compress: boolean }> = [];
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith(".gproj")) writeFileSync(join(root, path), content);
    else inPak.push({ path, content, compress: path.endsWith(".et") });
  }
  writeFileSync(join(root, "data.pak"), buildTestPak(inPak));
  writeFileSync(join(root, "resourceDatabase.rdb"), buildRdb(guids));
}

/**
 * A temp stack: loose AddonA depends on Workshop ModB (which depends on vanilla), on ModC (both a
 * loose clone and a Workshop copy) and on a missing DDDDDDDDDDDDDDDD. Load order:
 * vanilla, ModB, ModC (loose), AddonA.
 */
export function makeFakeStack(): { root: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "emcp-stack-"));
  const vanilla = join(root, "game", "addons", "data");
  packed(vanilla, {
    "ArmaReforger.gproj": gproj("ArmaReforger", "58D0FB3206B6F859", []),
    "Prefabs/Pants_Base.et": 'GenericEntity {\n components {\n  MeshObject "{AAAA000000000001}" {\n   Object "base.xob"\n  }\n }\n}\n',
    "Prefabs/Pants_BDU.et": `GenericEntity : "{${G.pantsBase}}Prefabs/Pants_Base.et" {\n components {\n  SCR_UniversalInventoryStorageComponent "{5222CB01D5B9A306}" {\n   MaxWeight 10\n  }\n }\n}\n`,
    "Prefabs/Character_Base.et": 'GenericEntity {\n m_Value 1\n Tags {\n  "a"\n }\n}\n',
    "Scripts/Game/Big.c": "x\n".repeat(10),
  }, { "Prefabs/Pants_Base.et": G.pantsBase, "Prefabs/Pants_BDU.et": G.pantsBdu, "Prefabs/Character_Base.et": G.character });

  const workshop = join(root, "workshop");
  packed(join(workshop, "ModB_BBBBBBBBBBBBBBBB"), {
    "dev.gproj": gproj("ModB", "BBBBBBBBBBBBBBBB", ["58D0FB3206B6F859"]),
    "Prefabs/Guerilla_Pants.et": `GenericEntity : "{${G.pantsBdu}}Prefabs/Pants_BDU.et" {\n components {\n  InventoryItemComponent "{5222CB01D5B9A306}" {\n   Attributes SCR_ItemAttributeCollection "{CCCC000000000001}" {\n    ItemVolume 2000\n   }\n  }\n }\n}\n`,
    "Prefabs/Character_Base.et": 'GenericEntity {\n m_Value 2\n Tags + {\n  "b"\n }\n}\n',
    // Its parent reference names an old path; only the GUID still points at Pants_BDU.et
    "Prefabs/Moved_Child.et": `GenericEntity : "{${G.pantsBdu}}Prefabs/Old/Pants_BDU.et" {\n m_Child 1\n}\n`,
  }, { "Prefabs/Guerilla_Pants.et": G.guerilla, "Prefabs/Character_Base.et": G.character });
  // As the Workshop writes them: UTF-8 BOM, gameVersion only in the meta
  put(join(workshop, "ModB_BBBBBBBBBBBBBBBB"), {
    "ServerData.json": '﻿{"id":"BBBBBBBBBBBBBBBB","name":"Mod B","revision":{"version":"1.2.0","gameVersion":""}}',
    meta: '﻿{"meta":{"versions":[{"version":"1.2.0","gameVersion":"1.7.0.54","dependencies":[{"assetId":"58d0fb3206b6f859","assetName":"Arma Reforger","version":"1.8"}]},{"version":"1.1.0","gameVersion":"1.6.0.1"}]}}',
  });
  packed(join(workshop, "ModC_CCCCCCCCCCCCCCCC"), {
    "dev.gproj": gproj("ModC", "CCCCCCCCCCCCCCCC", ["58D0FB3206B6F859"]),
  }, {});

  const projects = join(root, "projects");
  put(join(projects, "ModC"), { "addon.gproj": gproj("ModC", "CCCCCCCCCCCCCCCC", ["58D0FB3206B6F859"]) });
  put(join(projects, "AddonA"), {
    "addon.gproj": gproj("AddonA", "AAAAAAAAAAAAAAAA", ["58D0FB3206B6F859", "BBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCC", "DDDDDDDDDDDDDDDD", ""]),
    "Prefabs/Character_Base.et": "GenericEntity {\n m_Value 3\n}\n",
    "Prefabs/Character_Base.et.meta": `MetaFileClass {\n Name "{${G.character}}Prefabs/Character_Base.et"\n}\n`,
    "Prefabs/Pants_Base.et": "GenericEntity {\n m_Other 1\n}\n",
    "Prefabs/Pants_Base.et.meta": `MetaFileClass {\n Name "{${G.shadow}}Prefabs/Pants_Base.et"\n}\n`,
    "Prefabs/Hash.et": "GenericEntity {\n# m_Old 1\n m_A 1\n}\n",
  });

  const config = { gamePath: join(root, "game"), projectPath: projects, workshopPath: workshop } as Config;
  return { root, config };
}
