import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/tuning-server/public/tuner.html"), "utf8");
// The page has no module split, so run its inline script against a stub DOM; top-level let/const stay reachable from later runInContext calls.
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1].replace(/^import \* as MF .*$/m, "const MF = {};");

type El = Record<string, any>;

function loadPage(fetchStub: (url: string, init?: { method?: string }) => Promise<unknown>) {
  const els = new Map<string, El>();
  const el = (id: string): El => {
    if (!els.has(id)) els.set(id, { disabled: false, checked: false, textContent: "", className: "", innerHTML: "" });
    return els.get(id)!;
  };
  el("autoWatch").checked = true;
  el("allowWrite").checked = true;
  const noop = () => {};
  const ctx = vm.createContext({
    document: { getElementById: el, addEventListener: noop },
    window: { addEventListener: noop, location: { search: "" } },
    fetch: fetchStub,
    setInterval: noop,
    URLSearchParams,
    console,
  });
  vm.runInContext(script, ctx);
  const run = (code: string) => vm.runInContext(code, ctx);
  run("redraw = () => {}"); // canvas drawing needs the tyre maths and a real canvas
  // One vehicle with one edited value, so there is a change to apply
  run(`cur = { rel: "Prefabs/Vehicles/X.et", body: {} }; lastMtime = 1;
       rows.set("engine.MaxPower", { target: { part: "engine", key: "MaxPower" }, loaded: 100, value: 120, touched: true });`);
  return { el, run };
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("tuner.html while a write is in flight", () => {
  it("keeps Apply disabled whatever the user edits, and lets go after the reply", async () => {
    let reply!: (v: unknown) => void;
    const page = loadPage((url, init) => (init?.method === "POST" ? new Promise((r) => (reply = r)) : Promise.resolve(json({ status: "ok", mtimeMs: 1, fields: {} }))));
    page.run("refreshWriteState()");
    expect(page.el("writeBtn").disabled).toBe(false);
    const done = page.run("writeChanges()") as Promise<void>;
    expect(page.el("writeBtn").disabled).toBe(true);
    // The user types in a box meanwhile: the input handler ends in refreshWriteState
    page.run("refreshWriteState()");
    expect(page.el("writeBtn").disabled).toBe(true);
    // A refusal keeps the edits, so Apply comes back
    reply({ ok: false, status: 409, json: async () => ({ status: "error", message: "no" }) });
    await done;
    expect(page.el("writeBtn").disabled).toBe(false);
  });

  it("does not show the would-be-lost banner when the poll sees the file change mid-write", async () => {
    let reply!: (v: unknown) => void;
    const page = loadPage((url, init) => (init?.method === "POST" ? new Promise((r) => (reply = r)) : Promise.resolve(json({ status: "ok", mtimeMs: 2, fields: {} }))));
    const done = page.run("writeChanges()") as Promise<void>;
    await page.run("pollForChanges()");
    expect(page.el("banner").textContent).not.toContain("would be lost");
    reply(json({ status: "ok", written: ["a"], message: "m" }));
    await done;
    // Outside a write the same poll still warns about unapplied edits
    page.run(`rows.set("engine.MaxPower", { target: { part: "engine", key: "MaxPower" }, loaded: 100, value: 130, touched: true }); lastMtime = 1;`);
    await page.run("pollForChanges()");
    expect(page.el("banner").textContent).toContain("would be lost");
  });

  it("does not show the banner when a write starts while the poll's fetch is still out", async () => {
    let reply!: (v: unknown) => void, answerPoll!: (v: unknown) => void;
    const page = loadPage((url, init) => (init?.method === "POST" ? new Promise((r) => (reply = r)) : new Promise((r) => (answerPoll = r))));
    const polled = page.run("pollForChanges()") as Promise<void>;
    const done = page.run("writeChanges()") as Promise<void>;
    answerPoll(json({ status: "ok", mtimeMs: 2, fields: {} }));
    await polled;
    expect(page.el("banner").textContent).not.toContain("would be lost");
    reply({ ok: false, status: 409, json: async () => ({ status: "error", message: "no" }) });
    await done;
  });
  it("disables the value panels, the vehicle select and Reload during a write, and enables them again on every path", async () => {
    const locked = (page: ReturnType<typeof loadPage>) => ["panels", "vehicle", "reloadBtn"].map((id) => page.el(id).disabled);
    let reply!: (v: unknown) => void;
    const get = () => Promise.resolve(json({ status: "ok", mtimeMs: 1, fields: {} }));
    const page = loadPage((url, init) => (init?.method === "POST" ? new Promise((r) => (reply = r)) : get()));
    page.run("refreshWriteState()");
    expect(locked(page)).toEqual([false, false, false]);
    const refused = page.run("writeChanges()") as Promise<void>;
    expect(locked(page)).toEqual([true, true, true]);
    reply({ ok: false, status: 409, json: async () => ({ status: "error", message: "no" }) });
    await refused;
    expect(locked(page)).toEqual([false, false, false]);
    // A good write reloads the vehicle, then lets go as well
    const written = page.run("writeChanges()") as Promise<void>;
    expect(locked(page)).toEqual([true, true, true]);
    reply(json({ status: "ok", written: ["a"], message: "m" }));
    await written;
    expect(locked(page)).toEqual([false, false, false]);
  });

  it("warns, and does not reject, when the reload after a good write throws", async () => {
    let reply!: (v: unknown) => void, posted = false; // the page's own startup fetches must still succeed
    const page = loadPage((url, init) => {
      if (init?.method === "POST") { posted = true; return new Promise((r) => (reply = r)); }
      return posted ? Promise.reject(new Error("down")) : Promise.resolve(json({ status: "ok", vehicles: [], mtimeMs: 1, fields: {} }));
    });
    const done = page.run("writeChanges()") as Promise<void>;
    reply(json({ status: "ok", written: ["a.et"], message: "m" }));
    await done;
    expect(page.el("banner").className).toBe("banner warn");
    expect(page.el("banner").textContent).toContain("Wrote a.et");
    expect(page.el("banner").textContent).toContain("could not reload");
    expect(page.el("writeBtn").disabled).toBe(false);
  });
});
