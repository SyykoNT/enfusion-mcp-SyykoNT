import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createTuningServer } from "../../src/tuning-server/server.js";

// Every path the server hands to writeFileSync, so a test can prove the vehicle .et is the only one.
const fsWrites = vi.hoisted(() => ({
  paths: [] as string[],
  renames: [] as string[][],
  renameError: null as (Error & { code?: string }) | null,
  /** Thrown once by the next read of this exact path. */
  readError: null as { path: string; error: Error & { code?: string } } | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      const fail = fsWrites.readError;
      if (fail && String(args[0]) === fail.path) {
        fsWrites.readError = null;
        throw fail.error;
      }
      return fs.readFileSync(...args);
    }) as typeof fs.readFileSync,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      fsWrites.paths.push(String(args[0]));
      return fs.writeFileSync(...args);
    },
    renameSync: (from: string, to: string) => {
      fsWrites.renames.push([String(from), String(to)]);
      if (fsWrites.renameError) throw fsWrites.renameError;
      return fs.renameSync(from, to);
    },
  };
});

const VANILLA = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "vanilla");
const REL = "Prefabs/Vehicles/Wheeled/Fix/Fix_base.et";
const P94_REL = "Prefabs/Vehicles/Wheeled/P94/P94.et";
const FRONT = "4D8B26DF957A8E1C";
const REAR = "4D8B26DF8CF2F3D8";

/** The sibling the server writes first and then renames over the target. */
const tmpOf = (p: string) => join(dirname(p), `.${basename(p)}.tuning-tmp`);

/** Every file under a folder with its bytes. */
function snapshot(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    const abs = join(root, rel);
    if (statSync(abs).isFile()) out.set(abs, readFileSync(abs));
  }
  return out;
}

describe("tuning server POST writes the 1.9 blocks", () => {
  let addonDir: string;
  let etPath: string;
  let baseUrl: string;
  let server: ReturnType<typeof createTuningServer>;

  const post = (rel: string, body: string) =>
    fetch(`${baseUrl}/api/vehicles/${rel}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const postChanges = (changes: unknown, rel = REL) => post(rel, JSON.stringify({ changes }));

  beforeEach(async () => {
    // The whole vanilla fixture tree, .conf files included, becomes the addon, so a write
    // to any referenced conf would show up in the snapshot.
    addonDir = mkdtempSync(join(tmpdir(), "tuner-write-"));
    cpSync(VANILLA, addonDir, { recursive: true });
    etPath = join(addonDir, ...REL.split("/"));
    // The checkout may have turned the fixture into CRLF; the LF case is the vanilla one.
    writeFileSync(etPath, readFileSync(etPath, "utf-8").replace(/\r\n/g, "\n"));
    server = createTuningServer(addonDir, undefined, true);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fsWrites.paths.length = 0;
    fsWrites.renames.length = 0;
    fsWrites.renameError = null;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(addonDir, { recursive: true, force: true });
  });

  it("writes every block kind in one request and the vehicle .et is the only file written", async () => {
    const before = snapshot(addonDir);
    const res = await postChanges({
      engine: { MaxPower: 95 },
      tyreModel: { top: { NominalLoad: 5100 } },
      axles: [
        {
          axle: FRONT,
          steering: { SteeringRatio: 16 },
          suspension: { MaxSteeringAngle: 30 },
          wheel: { Radius: 0.38 },
          tyre: { Roughness: 0.2 },
          swaybar: { Stiffness: 2600 },
        },
        { axle: REAR, tyre: { Roughness: 0.3 } },
      ],
      differentials: [
        { name: "Diff_C", fields: { Ratio: 1.2 } },
        { name: "Diff_01", axle: FRONT, fields: { Strength: 0.4 } },
        { name: "Diff_02", axle: REAR, fields: { Ratio: 5.3 } },
      ],
    });
    const body = await res.json();
    expect(res.status, body.message).toBe(200);
    expect(body.written).toContain("Differential Diff_02 in axle 4D8B26DF8CF2F3D8.Ratio");

    // The new text goes to a sibling temp file, then replaces the .et in one rename.
    expect(fsWrites.paths).toEqual([tmpOf(etPath)]);
    expect(fsWrites.renames).toEqual([[tmpOf(etPath), etPath]]);
    const after = snapshot(addonDir);
    const changed = [...after.keys()].filter((p) => !before.get(p)!.equals(after.get(p)!));
    expect(changed).toEqual([etPath]);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

    const text = readFileSync(etPath, "utf-8");
    expect(text).toContain("       Ratio 5.3\n");
    expect(text).toContain("    Engine Engine Engine : ");
    expect(text).not.toMatch(/^\s*[A-Za-z]\w*\s+-?[\d.]+[eE][+-]?\d+\s*$/m);
  });

  // Bodies the tuner page sent, captured in the browser against a temp copy of this fixture.
  it("accepts a body captured from the tuner page, and the page's missing-block body gets the 409 text", async () => {
    const captured =
      '{"changes":{"tyreModel":{"top":{"NominalLoad":5100}},"engine":{"MaxPower":95},"axles":[{"axle":"4D8B26DF957A8E1C","tyre":{"Roughness":0.2},' +
      '"steering":{"SteeringRatio":16}},{"axle":"4D8B26DF8CF2F3D8","suspension":{"SpringRate":32000}}],"differentials":[{"name":"Diff_C","fields":{"Ratio":1.2}},' +
      '{"name":"Diff_02","axle":"4D8B26DF8CF2F3D8","fields":{"Ratio":5.3}}]}}';
    const res = await post(REL, captured);
    const body = await res.json();
    expect(res.status, body.message).toBe(200);
    expect(body.written).toHaveLength(7);
    const text = readFileSync(etPath, "utf-8");
    for (const line of ["     MaxPower 95\n", "      Ratio 1.2\n", "       SteeringRatio 16\n", "       Roughness 0.2\n", "       Ratio 5.3\n", "       SpringRate 32000\n", "     NominalLoad 5100\n"]) {
      expect(text).toContain(line);
    }

    const before = readFileSync(etPath);
    const missing = await post(REL, '{"changes":{"tyreModel":{"Longitudinal":{"PCX1":1.7}},"engine":{"MaxPower":96}}}');
    expect(missing.status).toBe(409);
    expect((await missing.json()).message).toBe(
      `${REL}: TyreModel Longitudinal is not in this .et. Add the override in Workbench first; this tool never creates blocks. Nothing was written.`
    );
    expect(readFileSync(etPath).equals(before)).toBe(true);
  });

  it("409 for a block the .et lacks, names it, and leaves the file's bytes alone (all or nothing)", async () => {
    const before = readFileSync(etPath);
    // The Engine block exists; the TyreModel Longitudinal sub-block is only in the conf.
    const res = await postChanges({ engine: { MaxPower: 95 }, tyreModel: { Longitudinal: { PCX1: 1.6 } } });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.message).toContain("TyreModel Longitudinal");
    expect(body.message).toContain("Add the override in Workbench first");
    expect(body.errors).toEqual(["TyreModel Longitudinal is not in this .et"]);
    expect(readFileSync(etPath).equals(before)).toBe(true);
    expect(fsWrites.paths).toEqual([]);
  });

  it("400 for a Pacejka2002 key into the .et's Pacejka94 TyreModel, file unchanged", async () => {
    const p94 = join(addonDir, ...P94_REL.split("/"));
    const before = readFileSync(p94);
    const res = await postChanges({ tyreModel: { Longitudinal: { PCX1: 1.6 } } }, P94_REL);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('"PCX1" is not a writable key');
    expect(readFileSync(p94).equals(before)).toBe(true);
  });

  it("400 for a value JSON turns into Infinity, file unchanged", async () => {
    const before = readFileSync(etPath);
    const res = await post(REL, '{"changes":{"engine":{"MaxPower":1e999}}}');
    expect(res.status).toBe(400);
    expect(readFileSync(etPath).equals(before)).toBe(true);
  });

  it("400, not a crash, for a JSON body of null", async () => {
    const res = await post(REL, "null");
    expect(res.status).toBe(400);
  });

  it("round-trips 0.0000001 through POST and GET, and a second POST keeps one line", async () => {
    const change = { axles: [{ axle: FRONT, tyre: { Roughness: 0.0000001 } }] };
    expect((await postChanges(change)).status).toBe(200);
    const first = readFileSync(etPath, "utf-8");
    expect((await postChanges(change)).status).toBe(200);
    const second = readFileSync(etPath, "utf-8");
    expect(second).toBe(first);
    expect(second.match(/Roughness/g)).toHaveLength(1);
    expect(second).toContain("       Roughness 0.0000001\n");

    const { chassis } = await (await fetch(`${baseUrl}/api/vehicles/${REL}`)).json();
    const front = chassis.axles.find((a: { id: string }) => a.id === FRONT);
    expect(front.tyre.fields.Roughness).toMatchObject({ value: 0.0000001, source: "own" });
  });

  it("keeps a CRLF file CRLF", async () => {
    const crlf = readFileSync(etPath, "utf-8").replace(/\n/g, "\r\n");
    writeFileSync(etPath, crlf);
    expect((await postChanges({ engine: { MaxPower: 95, RpmIdle: 800 } })).status).toBe(200);
    const text = readFileSync(etPath, "utf-8");
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).toBe(crlf.replace('     Output "Clutch"\r\n', '     Output "Clutch"\r\n     MaxPower 95\r\n     RpmIdle 800\r\n'));
  });

  it("409 for a file that is not valid UTF-8, bytes unchanged", async () => {
    const bytes = Buffer.concat([readFileSync(etPath), Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a])]);
    writeFileSync(etPath, bytes);
    fsWrites.paths.length = 0;
    const res = await postChanges({ engine: { MaxPower: 95 } });
    expect(res.status).toBe(409);
    expect(readFileSync(etPath).equals(bytes)).toBe(true);
    expect(fsWrites.paths).toEqual([]);
  });

  it("a failure between the temp write and the rename leaves the original bytes and no temp file", async () => {
    const before = readFileSync(etPath);
    fsWrites.renameError = new Error("disk full");
    const res = await postChanges({ engine: { MaxPower: 95 } });
    expect(res.status).toBe(500);
    expect(fsWrites.renames).toEqual([[tmpOf(etPath), etPath]]);
    expect(readFileSync(etPath).equals(before)).toBe(true);
    expect(readdirSync(dirname(etPath)).filter((n) => n.endsWith(".tuning-tmp"))).toEqual([]);
  });

  it("409 saying the file is locked when the rename is refused, original untouched", async () => {
    const before = readFileSync(etPath);
    fsWrites.renameError = Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    const res = await postChanges({ engine: { MaxPower: 95 } });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.message).toContain("locked");
    expect(body.message).toContain("Nothing was changed");
    expect(readFileSync(etPath).equals(before)).toBe(true);
    expect(readdirSync(dirname(etPath)).filter((n) => n.endsWith(".tuning-tmp"))).toEqual([]);
  });

  it.each(["EBUSY", "EPERM", "EACCES"])("409 saying the file is locked when the read before the write fails with %s", async (code) => {
    const before = readFileSync(etPath);
    fsWrites.readError = { path: etPath, error: Object.assign(new Error(`${code}: resource busy or locked, open '${etPath}'`), { code }) };
    const res = await postChanges({ engine: { MaxPower: 95 } });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.message).toContain("locked");
    expect(body.message).not.toContain(etPath);
    expect(fsWrites.readError).toBeNull();
    expect(fsWrites.paths).toEqual([]);
    expect(readFileSync(etPath).equals(before)).toBe(true);
  });

  it("still 500 for a read failure that is not a lock", async () => {
    fsWrites.readError = { path: etPath, error: Object.assign(new Error("EIO: i/o error"), { code: "EIO" }) };
    expect((await postChanges({ engine: { MaxPower: 95 } })).status).toBe(500);
  });

  it("400 for a colon inside the route path (B-073)", async () => {
    const res = await postChanges({ engine: { MaxPower: 95 } }, `${REL}:stream.et`);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("Invalid vehicle path");
  });
});
