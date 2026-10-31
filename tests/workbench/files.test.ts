import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSnapshots, snapshotDir } from "../../src/workbench/files.js";

function world() {
  const root = mkdtempSync(join(tmpdir(), "emcp-files-"));
  mkdirSync(join(root, "W_Layers", "a", "b", "c"), { recursive: true });
  for (const f of ["W.ent", "W.ent.meta", "W_Layers/default.layer", "W_Layers/a/b/deep.txt", "W_Layers/a/b/c/too-deep.txt"]) {
    writeFileSync(join(root, f), "x");
  }
  return root;
}

describe("snapshotDir and diffSnapshots", () => {
  it("lists a changed, an added and a removed file", async () => {
    const root = world();
    const before = await snapshotDir(root);
    utimesSync(join(root, "W_Layers", "default.layer"), new Date(2030, 0, 1), new Date(2030, 0, 1));
    writeFileSync(join(root, "W_Layers", "new.layer"), "y");
    rmSync(join(root, "W.ent.meta"));
    expect(diffSnapshots(before, await snapshotDir(root))).toEqual({
      changed: ["W_Layers/default.layer"], added: ["W_Layers/new.layer"], removed: ["W.ent.meta"],
    });
    expect(diffSnapshots(before, before)).toEqual({ changed: [], added: [], removed: [] });
  });

  it("keeps to the depth and file caps, and a missing folder is empty", async () => {
    const root = world();
    const all = Object.keys(await snapshotDir(root)).sort();
    // Three subfolder levels by default: W_Layers/a/b is the last one read.
    expect(all).toEqual(["W.ent", "W.ent.meta", "W_Layers/a/b/deep.txt", "W_Layers/default.layer"]);
    expect(Object.keys(await snapshotDir(root, 2)).sort()).toEqual(["W.ent", "W.ent.meta", "W_Layers/default.layer"]);
    expect(Object.keys(await snapshotDir(root, 3, 2))).toHaveLength(2);
    expect(await snapshotDir(join(root, "nope"))).toEqual({});
  });
});
