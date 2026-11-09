import { describe, it, expect, vi } from "vitest";
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
    if (!els.has(id)) els.set(id, { disabled: false, checked: false, textContent: "", className: "", innerHTML: "", appendChild: () => {} });
    return els.get(id)!;
  };
  el("autoWatch").checked = true;
  el("allowWrite").checked = true;
  const noop = () => {};
  const listeners = new Map<string, (e: unknown) => void>();
  const edited: El[] = []; // stand-ins for the rows the page marks as edited
  const ctx = vm.createContext({
    document: { getElementById: el, addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn), createElement: () => ({}), querySelectorAll: (sel: string) => (sel === ".sr.edited" ? edited : []) },
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
  return { el, run, edited, fire: (type: string, e: unknown) => listeners.get(type)!(e) };
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** A page whose POST succeeds with `reply` and whose later GETs answer with `get`; `done` is the write. */
function afterWrite(get: () => Promise<unknown>, reply: Record<string, unknown>) {
  let posted = false;
  const page = loadPage((url, init) => {
    if (init?.method === "POST") { posted = true; return Promise.resolve(json({ status: "ok", written: ["a.et"], ...reply })); }
    return posted ? get() : Promise.resolve(json({ status: "ok", vehicles: [], mtimeMs: 1, fields: {} }));
  });
  return { ...page, done: page.run("writeChanges()") as Promise<void> };
}

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
    expect(page.el("panels").disabled).toBe(false); // the write lock is released; Apply stays off because the edits are written
  });

  it("keeps the server's message and the Workbench line on the warn banner when the reload after a good write fails", async () => {
    const page = afterWrite(() => Promise.reject(new Error("down")), { message: "Saved ok", workbench: "Workbench not notified (x)" });
    await page.done;
    expect(page.el("banner").className).toBe("banner warn");
    expect(page.el("banner").textContent).toContain("Saved ok");
    expect(page.el("banner").textContent).toContain("Workbench not notified (x)");
  });

  it("warns, and no longer counts the edits as unsaved, when the reload after a good write answers not ok", async () => {
    const page = afterWrite(() => Promise.resolve(json({ status: "error", message: "gone" })), { message: "m" });
    const editedRow = { classList: { remove: vi.fn() } };
    page.edited.push(editedRow);
    await page.done;
    const banner = page.el("banner");
    expect(banner.className).toBe("banner warn");
    expect(banner.textContent).toContain("Wrote a.et");
    expect(banner.textContent).toContain("could not reload");
    expect(page.run("changedRows().length")).toBe(0);
    expect(page.el("writeBtn").textContent).toBe("Apply to prefab");
    expect(editedRow.classList.remove).toHaveBeenCalledWith("edited");
  });

  it("keeps the warn banner after a failed reload while the polls see only that write, and goes back to normal on a later change", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    let mtime = 2, reloads = 0;
    const page = afterWrite(() => (reloads++ === 0 ? Promise.reject(new Error("down")) : Promise.resolve(json({ status: "ok", mtimeMs: mtime, fields: {} }))), { message: "Saved ok", workbench: "Workbench not notified (x)" });
    await page.done;
    const banner = page.el("banner");
    expect(banner.className).toBe("banner warn");
    // The file now carries the write's mtime (2); neither the first poll that sees it nor the second may swap the banner
    for (let i = 0; i < 2; i++) { await page.run("pollForChanges()"); await tick(); }
    expect(banner.className).toBe("banner warn");
    expect(banner.textContent).toContain("Workbench not notified (x)");
    // A real later change on disk reloads as before
    mtime = 3;
    await page.run("pollForChanges()");
    await tick();
    expect(banner.className).toBe("banner ok");
    expect(banner.textContent).toContain("Loaded");
  });

  it("does not swallow the next change when the reload read the write's mtime and then failed while drawing", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    let mtime = 2;
    const page = afterWrite(() => Promise.resolve(json({ status: "ok", mtimeMs: mtime, fields: {} })), { message: "Saved ok" });
    page.run("{ let n = 0; const draw = renderTyre; renderTyre = (t) => { if (n++ === 0) throw new Error('draw'); return draw(t); }; }");
    await page.done;
    const banner = page.el("banner");
    expect(banner.className).toBe("banner warn");
    expect(banner.textContent).toContain("could not reload");
    expect(page.run("lastMtime")).toBe(2); // the failed load had already taken the write's mtime
    expect(page.run("unseenWrite")).toBe(false);
    mtime = 3;
    await page.run("pollForChanges()");
    await tick();
    expect(banner.className).toBe("banner ok");
    expect(banner.textContent).toContain("Loaded");
  });

  describe("a failed load shows a warn banner instead of an unhandled rejection", () => {
    // Macrotask waits: a rejection that nobody awaits only surfaces after the microtask queue drains.
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const down = () => Promise.reject(new Error("down"));
    const list = json({ status: "ok", vehicles: [{ path: "Prefabs/Vehicles/X.et" }] });
    /** A page whose startup works; each vehicle GET after that takes the next function in `replies`. */
    const started = async () => {
      const replies: (() => Promise<unknown>)[] = [];
      const page = loadPage((url) => (url === "/api/vehicles" ? Promise.resolve(list) : (replies.shift() ?? (() => Promise.resolve(json({ status: "ok", mtimeMs: 1, fields: {} }))))()));
      await tick();
      return { page, replies };
    };

    it("the poll's reload after a Workbench save", async () => {
      const { page, replies } = await started();
      page.run("rows.clear(); lastMtime = 1");
      replies.push(() => Promise.resolve(json({ status: "ok", mtimeMs: 2, fields: {} })), down); // the poll sees a save, the reload fails
      await page.run("pollForChanges()");
      await tick();
      expect(page.el("banner").className).toBe("banner warn");
      expect(page.el("banner").textContent).toContain("Could not load");
    });

    it("the vehicle select", async () => {
      const { page, replies } = await started();
      replies.push(down);
      page.el("vehicle").value = "Prefabs/Vehicles/X.et";
      page.el("vehicle").onchange();
      await tick();
      expect(page.el("banner").className).toBe("banner warn");
      expect(page.el("banner").textContent).toMatch(/Could not load Prefabs\/Vehicles\/X\.et: .*down/);
    });

    it("the Reload button", async () => {
      const { page, replies } = await started();
      replies.push(down);
      await page.el("reloadBtn").onclick();
      await tick();
      expect(page.el("banner").className).toBe("banner warn");
      expect(page.el("banner").textContent).toContain("Could not load");
    });

    it("the startup vehicle list", async () => {
      const page = loadPage(down);
      await tick();
      expect(page.el("banner").className).toBe("banner warn");
      expect(page.el("banner").textContent).toMatch(/Could not list the vehicle prefabs: .*down/); // the page's Error is another realm's, so the text may carry "Error: "
    });

    it("the vehicle load at startup", async () => {
      const page = loadPage((url) => (url === "/api/vehicles" ? Promise.resolve(list) : down()));
      page.el("vehicle").value = "Prefabs/Vehicles/X.et";
      await tick();
      expect(page.el("banner").className).toBe("banner warn");
      expect(page.el("banner").textContent).toMatch(/Could not load Prefabs\/Vehicles\/X\.et: .*down/);
    });
  });
});

describe("tuner.html number boxes", () => {
  /** A page plus a function that types `text` into the number box of the edited row. */
  const open = () => {
    const page = loadPage(() => Promise.resolve(json({ status: "ok", mtimeMs: 1, fields: {} })));
    page.el("banner").textContent = "";
    page.run(`rows.set("engine.MaxTorque", { target: { part: "engine", key: "MaxTorque" }, loaded: 200, value: 200, touched: false });`);
    const sr = (id: string) => ({ dataset: { id }, querySelectorAll: () => [{ min: "0", max: "10", value: "" }, { value: "" }], classList: { toggle: () => {} } });
    return {
      page,
      enter: (text: string, id = "engine.MaxPower") => page.fire("input", { target: { dataset: {}, value: text, closest: () => sr(id) } }),
      reset: (id: string) => page.fire("click", { target: { closest: (q: string) => (q === ".rst" ? { closest: () => sr(id) } : null) } }),
    };
  };
  const type = (text: string) => {
    const { page, enter } = open();
    enter(text);
    return page;
  };

  it("warns when a typed number does not survive being stored as a JavaScript number, and keeps the stored value", () => {
    const page = type("123456789012345678901");
    expect(page.el("banner").className).toBe("banner warn");
    expect(page.el("banner").textContent).toContain("123456789012345678901 cannot be stored exactly");
    expect(page.el("banner").textContent).toContain("written as 123456789012345680000.");
    expect(page.run('rows.get("engine.MaxPower").value')).toBe(123456789012345680000);
  });

  it.each(["1.50", "0.1", "-2.5e3", "007", "0", "0.000", "1e-7", "123456789012345", "9007199254740991"])("stays quiet for %s", (text) => {
    expect(type(text).el("banner").textContent).toBe("");
  });

  it("writes tiny and huge values as plain decimals in the warning", () => {
    expect(type("0.12345678901234567890123").el("banner").textContent).toContain("written as 0.12345678901234568.");
    // JavaScript prints these two as 1.2345678901234568e+21 and 1.2345678901234568e-7; the file gets plain decimals
    expect(type("1234567890123456789012").el("banner").textContent).toContain("written as 1234567890123456800000.");
    expect(type("1.23456789012345678e-7").el("banner").textContent).toContain("written as 0.00000012345678901234568.");
  });

  // 17-digit shortest forms from 1e11 up to the samples below (the largest is 1.6e15) ending in a tie: toString and toPrecision(17) rounded them differently, which warned although they round-trip.
  it.each(["1600559752013866.2", "846587145912647.2", "591584520101547.2", "672029393815994.2"])("stays quiet for the 17-digit value %s", (text) => {
    expect(type(text).el("banner").textContent).toBe("");
  });

  it("never warns for the shortest text of a double", () => {
    const { page } = open();
    let seed = 1;
    for (let i = 0; i < 3000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const v = 1e11 + (seed / 2147483648) * 9.99e14 / (i % 3 + 1); // mostly the 1e11 to 1e15 range, where the tie cases lived
      expect(page.run(`exact("${String(v)}", ${v})`), String(v)).toBe(true);
    }
  });

  it("clears the warning when the next entry round-trips, but not another banner", () => {
    const { page, enter } = open();
    enter("123456789012345678901");
    expect(page.el("banner").className).toBe("banner warn");
    enter("1500");
    expect(page.el("banner").textContent).toBe("");
    expect(page.el("banner").className).not.toContain("warn");
    // Another banner on screen stays when an exact value is typed
    page.run('showBanner("err", "something else")');
    enter("1501");
    expect(page.el("banner").textContent).toBe("something else");
  });

  it("keeps the warning for its own field: an exact entry in another field leaves it, resetting that field clears it", () => {
    const { page, enter, reset } = open();
    enter("123456789012345678901"); // engine.MaxPower
    const warning = page.el("banner").textContent;
    expect(warning).toContain("cannot be stored exactly");
    enter("1500", "engine.MaxTorque");
    expect(page.el("banner").textContent).toBe(warning);
    expect(page.el("banner").className).toBe("banner warn");
    reset("engine.MaxTorque"); // another field's reset leaves it too
    expect(page.el("banner").textContent).toBe(warning);
    reset("engine.MaxPower");
    expect(page.el("banner").textContent).toBe("");
    expect(page.run("typedWarn")).toBe(null);
    // an exact entry in the field it is about still clears it
    enter("123456789012345678901");
    enter("1500");
    expect(page.el("banner").textContent).toBe("");
  });

  it("forgets that a write is unseen when the vehicle is loaded again", async () => {
    const page = loadPage(() => Promise.resolve(json({ status: "ok", mtimeMs: 1, fields: {} })));
    page.run("unseenWrite = true");
    await page.run('loadVehicle("Prefabs/Vehicles/X.et")');
    expect(page.run("unseenWrite")).toBe(false);
  });

  it("forgets the warning when the vehicle is reloaded", async () => {
    const { page, enter } = open();
    enter("123456789012345678901");
    await page.run('loadVehicle("Prefabs/Vehicles/X.et")');
    expect(page.el("banner").textContent).toContain("Loaded");
    expect(page.run("typedWarn")).toBe(null);
  });

  it.each(["9007199254740993", "0.12345678901234567890123", "1.00000000000000000001", "1e-400"])("warns for %s", (text) => {
    expect(type(text).el("banner").className).toBe("banner warn");
  });
});
