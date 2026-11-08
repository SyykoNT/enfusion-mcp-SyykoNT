import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTuningServer } from "../../src/tuning-server/server.js";
import { VEHICLES_SUBPATH } from "../../src/tuning-server/discover.js";

const REL = "Prefabs/Vehicles/Wheeled/M151A2/M151A2.et";

const VEHICLE_ET = `Vehicle : "{AAAA}Base.et" {
 components {
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

const GOOD_BODY = JSON.stringify({ changes: { engine: { MaxPower: 75 } } });

describe("tuning server write path, hostile requests", () => {
  let addonDir: string;
  let etPath: string;
  let port: number;
  let server: ReturnType<typeof createTuningServer>;

  /** node:http, not fetch: the test has to control Host and Origin exactly. */
  const send = (
    method: string,
    path: string,
    headers: Record<string, string | undefined>,
    body?: string | Buffer
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined)) as Record<string, string>;
      const req = request({ host: "127.0.0.1", port, method, path, headers: clean }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      });
      req.on("error", reject);
      req.end(body);
    });

  const post = (headers: Record<string, string | undefined>, body: string | Buffer = GOOD_BODY, path = `/api/vehicles/${REL}`) =>
    send("POST", path, { "Content-Type": "application/json", ...headers }, body);

  beforeEach(async () => {
    addonDir = mkdtempSync(join(tmpdir(), "tuner-sec-"));
    const dir = join(addonDir, ...VEHICLES_SUBPATH.split("/"), "Wheeled", "M151A2");
    mkdirSync(dir, { recursive: true });
    etPath = join(dir, "M151A2.et");
    writeFileSync(etPath, VEHICLE_ET);
    server = createTuningServer(addonDir, undefined, true);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(addonDir, { recursive: true, force: true });
  });

  const unchanged = () => expect(readFileSync(etPath, "utf-8")).toBe(VEHICLE_ET);

  describe("Content-Type", () => {
    it.each(["text/plain; charset=application/json", "application/jsonx", "text/plain; x=application/json", "application/json5"])(
      "refuses %s and writes nothing",
      async (ct) => {
        const res = await post({ "Content-Type": ct });
        expect(res.status).toBe(400);
        expect(res.body).toContain("Content-Type");
        unchanged();
      }
    );

    it("accepts the exact type with a parameter and any letter case", async () => {
      const res = await post({ "Content-Type": "Application/JSON; charset=utf-8" });
      expect(res.status).toBe(200);
      expect(readFileSync(etPath, "utf-8")).toContain("MaxPower 75");
    });
  });

  describe("Origin and Host", () => {
    it.each([
      ["a foreign Origin", { Origin: "http://example.com" }],
      ["the null Origin", { Origin: "null" }],
      ["the right host on the wrong port", { Origin: "http://127.0.0.1:1" }],
      ["https on our own port", { Origin: "https://127.0.0.1:PORT" }],
      ["a lookalike host", { Origin: "http://127.0.0.1.evil.test:PORT" }],
      ["a foreign Host (DNS rebinding)", { Host: "evil.example:PORT" }],
      ["a Host without the port", { Host: "127.0.0.1" }],
    ])("403 for %s and the file is untouched", async (_name, h) => {
      const headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.replace("PORT", String(port))]));
      const res = await post(headers);
      expect(res.status).toBe(403);
      unchanged();
    });

    it.each(["127.0.0.1", "localhost"])("allows the server's own origin http://%s:<port>", async (name) => {
      const res = await post({ Origin: `http://${name}:${port}`, Host: `${name}:${port}` });
      expect(res.status).toBe(200);
      expect(readFileSync(etPath, "utf-8")).toContain("MaxPower 75");
    });

    it("allows a client that sends no Origin (curl, scripts)", async () => {
      expect((await post({})).status).toBe(200);
    });

    it("GET ignores Origin: the page and its data load with or without one", async () => {
      expect((await send("GET", "/", {})).status).toBe(200);
      expect((await send("GET", "/api/vehicles", { Origin: "http://example.com" })).status).toBe(200);
    });

    it.each(["/", "/mf2002.js", "/api/vehicles", `/api/vehicles/${REL}`])("403 for GET %s with a foreign Host (DNS rebinding)", async (path) => {
      for (const host of [`evil.example:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`]) {
        const res = await send("GET", path, { Host: host });
        expect(res.status, host).toBe(403);
        expect(res.body, host).not.toContain("M151A2");
        expect(res.body, host).not.toContain("<title>");
      }
    });

    it.each(["127.0.0.1", "localhost"])("serves GET to the server's own Host %s:<port>", async (name) => {
      for (const path of ["/", "/mf2002.js", `/api/vehicles/${REL}`]) {
        expect((await send("GET", path, { Host: `${name}:${port}` })).status, path).toBe(200);
      }
    });
  });

  describe("body size", () => {
    it("413 for a body over the cap, and it is not parsed or written", async () => {
      const big = JSON.stringify({ changes: { engine: { MaxPower: 75 } }, pad: "x".repeat(2 * 1024 * 1024) });
      const res = await post({}, big);
      expect(res.status).toBe(413);
      unchanged();
    });

    it("413 for a chunked body over the cap (no Content-Length to check)", async () => {
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, method: "POST", path: `/api/vehicles/${REL}`, headers: { "Content-Type": "application/json", "Transfer-Encoding": "chunked" } },
          (r) => {
            r.resume();
            resolve({ status: r.statusCode ?? 0 });
          }
        );
        req.on("error", reject);
        req.write(`{"pad":"${"x".repeat(1024 * 1024)}`);
        req.end(`${"x".repeat(1024)}"}`);
      });
      expect(res.status).toBe(413);
      unchanged();
    });

    it("a body just under the cap still gets through to the JSON check", async () => {
      const res = await post({}, "x".repeat(900 * 1024));
      expect(res.status).toBe(400);
      expect(res.body).toContain("Invalid JSON");
    });
  });

  describe("route", () => {
    it("400, not 500, for a malformed percent escape", async () => {
      for (const bad of ["%E0%A4%A", "%", "%zz"]) {
        const res = await send("GET", `/api/vehicles/Prefabs/Vehicles/${bad}.et`, {});
        expect(res.status, bad).toBe(400);
        expect((await post({}, GOOD_BODY, `/api/vehicles/Prefabs/Vehicles/${bad}.et`)).status, bad).toBe(400);
      }
    });
  });

  describe("junctions and symlinks", () => {
    it("refuses to read or write a vehicle that resolves outside the addon", async (ctx) => {
      const outside = mkdtempSync(join(tmpdir(), "tuner-outside-"));
      try {
        const outsideEt = join(outside, "Out.et");
        writeFileSync(outsideEt, VEHICLE_ET);
        const link = join(addonDir, ...VEHICLES_SUBPATH.split("/"), "Link");
        try {
          symlinkSync(outside, link, "junction");
        } catch (e) {
          ctx.skip(`this platform refused to create a junction or symlink: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        const linked = `${VEHICLES_SUBPATH}/Link/Out.et`;
        const get = await send("GET", `/api/vehicles/${linked}`, {});
        expect(get.status).toBe(400);
        expect(get.body).not.toContain("Engine");
        const res = await post({}, GOOD_BODY, `/api/vehicles/${linked}`);
        expect(res.status).toBe(400);
        expect(readFileSync(outsideEt, "utf-8")).toBe(VEHICLE_ET);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("still serves an ordinary vehicle inside the addon", async () => {
      expect((await send("GET", `/api/vehicles/${REL}`, {})).status).toBe(200);
    });
  });
});
