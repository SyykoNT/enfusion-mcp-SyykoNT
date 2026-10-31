import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadDocs } from "../../src/scraper/source-remote.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("downloadDocs", () => {
  it("throws when pages are missing, so a partial scrape never replaces the index", async () => {
    // annotated.html links two pages; interfaceB is blocked (404 fails at once, no retries).
    vi.stubGlobal("fetch", async (url: string) => {
      const name = url.split("/").pop();
      if (name === "annotated.html") return new Response('<a href="interfaceA.html">A</a><a href="interfaceB.html">B</a>');
      if (name === "interfaceA.html") return new Response("<html></html>");
      return new Response("", { status: 404 });
    });
    await expect(downloadDocs("arma", join(mkdtempSync(join(tmpdir(), "emcp-dl-")), "arma"))).rejects.toThrow(/1 pages missing \(e\.g\. interfaceB\.html\)/);
  });
});
