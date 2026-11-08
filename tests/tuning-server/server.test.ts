import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createTuningServer } from "../../src/tuning-server/server.js";
import { VEHICLES_SUBPATH } from "../../src/tuning-server/discover.js";

const REL = "Prefabs/Vehicles/Wheeled/M151A2/M151A2.et";

const VEHICLE_ET = `Vehicle : "{AAAA}Base.et" {
 components {
  SCR_VehicleSoundComponent "{55C2E66AD4EF2CA6}" {
   Filenames + {
    "{D89573B95647C34A}Sounds/A.acp"
   }
  }
  VehicleWheeledSimulation "{731B26FCA2F19855}" {
   Simulation Wheeled "{4D8B26DEA5F25978}" {
    Engine Engine Engine {
     Inertia 0.3
     MaxPower 53
     MaxTorque 176
     RpmMaxPower 4000
     RpmMaxTorque 1800
     Steepness 15
     Friction 53
     RpmIdle 840
     RpmRedline 4200
     RpmMax 6000
    }
   }
  }
 }
}
`;

describe("tuning server", () => {
  let addonDir: string;
  let etPath: string;
  let baseUrl: string;
  let server: ReturnType<typeof createTuningServer>;

  beforeEach(async () => {
    addonDir = mkdtempSync(join(tmpdir(), "tuner-server-"));
    const dir = join(addonDir, ...VEHICLES_SUBPATH.split("/"), "Wheeled", "M151A2");
    mkdirSync(dir, { recursive: true });
    etPath = join(dir, "M151A2.et");
    writeFileSync(etPath, VEHICLE_ET);

    // Writing is opt-in now: the server is a read-only view of Workbench by
    // default, so the POST tests below exercise the explicitly-enabled path.
    server = createTuningServer(addonDir, undefined, true);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(addonDir, { recursive: true, force: true });
  });

  it("GET / serves the tuner HTML page", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>");
  });

  it("GET /api/vehicles lists vehicles with their Engine-block flag", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      vehicles: [{ path: REL, hasEngineBlock: true }],
    });
  });

  it("GET /api/vehicles/<rel> returns resolved fields with sources", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles/${REL}`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.fields.MaxPower).toMatchObject({ value: 53, source: "own", file: REL });
    expect(body.fields.Steepness).toMatchObject({ value: 15, source: "own" });
    expect(body.fields.RpmRedline.value).toBe(4200);
    // No TyreModel, axles or differentials anywhere in this fixture: empty, not an error.
    expect(body.chassis).toMatchObject({ tyreModel: null, axles: [], differentials: [] });
  });

  it("GET /api/vehicles/<rel> carries the 1.9 chassis: tyreModel, axles and differentials with sources", async () => {
    const vanilla = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "vanilla");
    const own = createTuningServer(addonDir, vanilla);
    await new Promise<void>((resolve) => own.listen(0, "127.0.0.1", resolve));
    try {
      const rel = "Prefabs/Vehicles/Wheeled/Fix/Fix.et";
      const dir = join(addonDir, ...VEHICLES_SUBPATH.split("/"), "Wheeled", "Fix");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "Fix.et"), `Vehicle : "{ABCD0000AAAA0001}Prefabs/Vehicles/Wheeled/Fix/Fix_base.et" {\n}\n`);
      const res = await fetch(`http://127.0.0.1:${(own.address() as AddressInfo).port}/api/vehicles/${rel}`);
      const { chassis, fields } = await res.json();
      expect(chassis.tyreModel).toMatchObject({ class: "Pacejka2002", id: "6A38CB253C2D7203" });
      expect(chassis.tyreModel.groups.top.NominalLoad).toMatchObject({ value: 5000, source: "inherited" });
      expect(chassis.axles.map((a: { id: string }) => a.id)).toEqual(["4D8B26DF957A8E1C", "4D8B26DF8CF2F3D8"]);
      expect(chassis.axles[0].tyre.fields.LongitudinalFriction.value).toBe(1.1);
      expect(chassis.differentials.map((d: { name: string }) => d.name)).toEqual(["Diff_C", "Diff_01", "Diff_02"]);
      expect(fields.RpmMax).toMatchObject({ value: 7000, source: "template" });
    } finally {
      await new Promise<void>((resolve) => own.close(() => resolve()));
    }
  });

  it("GET /api/vehicles/<rel> 404s for an unknown vehicle", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles/Prefabs/Vehicles/Wheeled/Nope/Nope.et`);
    expect(res.status).toBe(404);
    expect((await res.json()).status).toBe("error");
  });

  it("GET rejects a path outside Prefabs/Vehicles before touching the filesystem", async () => {
    // Neither a literal ".." nor a percent-encoded "%2e%2e" segment can ever
    // reach isSafeVehicleRelPath at all: per the WHATWG URL spec, Node's own
    // `new URL()` treats "%2e"/"%2E" as equivalent to a literal "." for
    // dot-segment removal, so ANY attempt to traverse via ".." is eliminated
    // by URL parsing itself before routing ever sees the request, confirmed
    // by inspecting `new URL(...).pathname` directly for both forms. The
    // guard's own `..`-rejection branch is still real and correct, it's
    // exhaustively unit-tested directly against isSafeVehicleRelPath in
    // tests/tuning-server/discover.test.ts, it's just unreachable through
    // this specific HTTP route, which is a property of the routing, not a gap.
    // What we CAN and must prove at the HTTP layer is that the guard actually
    // runs before any filesystem access: a wrong-prefix path is guaranteed to
    // survive URL parsing untouched, so a 400 (not a 404 from existsSync)
    // proves the guard fired first.
    const res = await fetch(`${baseUrl}/api/vehicles/Scripts/Game/Escape.et`);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("Invalid");
  });

  it("POST writes only the changed field and leaves the rest byte-identical", async () => {
    const before = readFileSync(etPath, "utf-8");
    const res = await fetch(`${baseUrl}/api/vehicles/${REL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { engine: { MaxPower: 75 } } }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.written).toEqual(["Engine.MaxPower"]);
    expect(body.message).toMatch(/reload/i);

    const after = readFileSync(etPath, "utf-8");
    const a = before.split("\n");
    const b = after.split("\n");
    expect(b.length).toBe(a.length);
    expect(b.filter((l, i) => l !== a[i])).toEqual(["     MaxPower 75"]);
    expect(after).toContain("Filenames + {");
    expect(after).toContain("RpmRedline 4200");
  });

  it("POST rejects a path outside Prefabs/Vehicles before touching the filesystem", async () => {
    // See the GET test above for why a wrong-prefix path is used instead of "..".
    const res = await fetch(`${baseUrl}/api/vehicles/Scripts/Game/Escape.et`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { engine: { MaxPower: 75 } } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("Invalid");
  });

  it("POST rejects a non-JSON Content-Type", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles/${REL}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ changes: { engine: { MaxPower: 75 } } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("Content-Type");
  });

  it("GET reports the file's mtime so the page can follow Workbench saves", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles/${REL}`);
    const body = await res.json();
    expect(typeof body.mtimeMs).toBe("number");

    writeFileSync(etPath, VEHICLE_ET.replace("MaxPower 53", "MaxPower 99"));
    const after = await (await fetch(`${baseUrl}/api/vehicles/${REL}`)).json();
    expect(after.mtimeMs).not.toBe(body.mtimeMs);
    expect(after.fields.MaxPower.value).toBe(99);
  });

  it("POST rejects an empty or unknown-key changes object", async () => {
    const empty = await fetch(`${baseUrl}/api/vehicles/${REL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: {} }),
    });
    expect(empty.status).toBe(400);

    const bogus = await fetch(`${baseUrl}/api/vehicles/${REL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { engine: { NotAField: 1 } } }),
    });
    expect(bogus.status).toBe(400);
  });
});

describe("tuning server, read-only by default", () => {
  let addonDir: string;
  let etPath: string;
  let baseUrl: string;
  let server: ReturnType<typeof createTuningServer>;

  beforeEach(async () => {
    addonDir = mkdtempSync(join(tmpdir(), "tuner-ro-"));
    const dir = join(addonDir, ...VEHICLES_SUBPATH.split("/"), "Wheeled", "M151A2");
    mkdirSync(dir, { recursive: true });
    etPath = join(dir, "M151A2.et");
    writeFileSync(etPath, VEHICLE_ET);

    server = createTuningServer(addonDir);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(addonDir, { recursive: true, force: true });
  });

  it("still serves reads", async () => {
    const res = await fetch(`${baseUrl}/api/vehicles/${REL}`);
    expect(res.status).toBe(200);
    expect((await res.json()).fields.MaxPower.value).toBe(53);
  });

  it("refuses a write and leaves the file untouched", async () => {
    const before = readFileSync(etPath, "utf-8");
    const res = await fetch(`${baseUrl}/api/vehicles/${REL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { engine: { MaxPower: 75 } } }),
    });
    expect(res.status).toBe(403);
    const { message } = await res.json();
    expect(message).toContain("read-only");
    // The real switch (index.ts), not the retired ENFUSION_TUNING_ALLOW_WRITE.
    expect(message).toContain("ENFUSION_TUNING_READONLY");
    expect(message).not.toContain("ALLOW_WRITE");
    expect(readFileSync(etPath, "utf-8")).toBe(before);
  });
});

describe("tuning server, Workbench notification after write", () => {
  let addonDir: string;
  let etPath: string;
  let baseUrl: string;
  let server: ReturnType<typeof createTuningServer>;
  let seen: string[];
  let notifier: (rel: string) => Promise<string | null>;

  beforeEach(async () => {
    addonDir = mkdtempSync(join(tmpdir(), "tuner-notify-"));
    const dir = join(addonDir, ...VEHICLES_SUBPATH.split("/"), "Wheeled", "M151A2");
    mkdirSync(dir, { recursive: true });
    etPath = join(dir, "M151A2.et");
    writeFileSync(etPath, VEHICLE_ET);

    seen = [];
    server = createTuningServer(addonDir, undefined, true, async (rel) => {
      seen.push(rel);
      return notifier(rel);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(addonDir, { recursive: true, force: true });
  });

  const post = () =>
    fetch(`${baseUrl}/api/vehicles/${REL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: { engine: { MaxPower: 75 } } }),
    });

  it("passes the written vehicle to the notifier and reports its result", async () => {
    notifier = async () => "Workbench: rebuild requested";
    const body = await (await post()).json();
    expect(seen).toEqual([REL]);
    expect(body.workbench).toBe("Workbench: rebuild requested");
  });

  it("still reports the write as successful when Workbench is unreachable", async () => {
    notifier = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await post();
    const body = await res.json();
    // The bytes are on disk either way, an unreachable editor must not turn a
    // completed write into a failed request.
    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.written).toEqual(["Engine.MaxPower"]);
    expect(body.workbench).toContain("ECONNREFUSED");
    expect(readFileSync(etPath, "utf-8")).toContain("MaxPower 75");
  });
});
