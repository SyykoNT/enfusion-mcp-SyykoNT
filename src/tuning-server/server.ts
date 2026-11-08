import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { listVehicles, vehicleEtPath, isSafeVehicleRelPath, isInsideAddon } from "./discover.js";
import { resolveEngineFields } from "./resolve-engine.js";
import { resolveChassis } from "./resolve-chassis.js";
import { planBlockWrites } from "./et-write.js";

const TUNER_HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), "public", "tuner.html");

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

/** A change request is a few hundred bytes; anything near this size is not the page talking. */
const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        req.removeAllListeners("data");
        req.resume(); // drain the rest unread so the 413 can still be delivered
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * True when a request can only have come from the tuner page this server served
 * (or a non-browser client): the Host must be our own loopback name, which stops
 * DNS rebinding, and an Origin, if the client sent one, must be that same
 * origin, which stops a page on another site from posting here.
 */
function isOwnRequest(req: IncomingMessage): boolean {
  const port = req.socket.localPort;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const host = req.headers.host?.toLowerCase();
  if (!host || !hosts.includes(host)) return false;
  const origin = req.headers.origin?.toLowerCase();
  return origin === undefined || hosts.some((h) => origin === `http://${h}`);
}

/**
 * Replace the file in one step: write beside it, then rename over it, so a crash
 * or a failed write leaves the original bytes, never a half-written prefab.
 */
function writeAtomic(filePath: string, text: string): void {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tuning-tmp`);
  try {
    writeFileSync(tmp, text, "utf-8");
    renameSync(tmp, filePath);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the original error matters more than a leftover temp file
    }
    throw e;
  }
}

const RELOAD_REMINDER =
  "Written to disk. If this vehicle prefab is open in Workbench, reload it. " +
  "Workbench silently reverts external file edits to a prefab it has open.";

/**
 * Told about a prefab that changed on disk, so Workbench can pick it up.
 * Returns a short status for the response, or null if nothing was attempted.
 *
 * Injected rather than imported so the tests never open a socket, and so a
 * missing or unreachable Workbench can never turn a successful write into a
 * failed request.
 */
export type WorkbenchNotifier = (relPath: string) => Promise<string | null>;

export function createTuningServer(
  addonPath: string,
  extractedPath?: string,
  allowWrite = false,
  notifyWorkbench?: WorkbenchNotifier,
  /** Vanilla files from the installed paks; consulted only when extractedPath is not set. */
  readBase?: (rel: string) => string | null
): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "POST" && !isOwnRequest(req)) {
        sendJson(res, 403, { status: "error", message: "Cross-site or foreign-host requests cannot write." });
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        const html = readFileSync(TUNER_HTML_PATH, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/vehicles") {
        sendJson(res, 200, { status: "ok", vehicles: listVehicles(addonPath) });
        return;
      }

      const match = /^\/api\/vehicles\/(.+)$/.exec(url.pathname);
      if (match && (req.method === "GET" || req.method === "POST")) {
        let rel: string;
        try {
          rel = decodeURIComponent(match[1]);
        } catch {
          sendJson(res, 400, { status: "error", message: "Invalid vehicle path" });
          return;
        }
        if (!isSafeVehicleRelPath(rel)) {
          sendJson(res, 400, { status: "error", message: "Invalid vehicle path" });
          return;
        }
        const filePath = vehicleEtPath(addonPath, rel);
        if (!existsSync(filePath)) {
          sendJson(res, 404, { status: "error", message: `Not found: ${rel}` });
          return;
        }
        // A junction or symlink under Prefabs/Vehicles could lead anywhere; refuse before any read or write.
        if (!isInsideAddon(addonPath, filePath)) {
          sendJson(res, 400, { status: "error", message: "Invalid vehicle path" });
          return;
        }

        if (req.method === "GET") {
          const modText = readFileSync(filePath, "utf-8");
          const fields = resolveEngineFields({ modText, relPath: rel, addonPath, extractedPath, readBase });
          const chassis = resolveChassis({ modText, relPath: rel, addonPath, extractedPath, readBase });
          // mtime lets the page poll cheaply and re-read only when Workbench saves.
          const mtimeMs = statSync(filePath).mtimeMs;
          sendJson(res, 200, { status: "ok", vehicle: rel, fields, chassis, mtimeMs });
          return;
        }

        if (!allowWrite) {
          sendJson(res, 403, {
            status: "error",
            message:
              "This server is read-only. Edit the prefab in Workbench; the page picks the change up automatically. " +
              "Start it without ENFUSION_TUNING_READONLY=1 to allow writing.",
          });
          return;
        }

        const contentType = req.headers["content-type"];
        // Compare the media type itself: a substring match lets "text/plain; x=application/json" through, and that is a no-preflight form post.
        if (typeof contentType !== "string" || contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
          sendJson(res, 400, { status: "error", message: "Content-Type must be application/json" });
          return;
        }

        const tooLarge = () => {
          res.setHeader("Connection", "close");
          sendJson(res, 413, { status: "error", message: `Request body is larger than ${MAX_BODY_BYTES} bytes` });
        };
        if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
          tooLarge();
          return;
        }
        let rawBody: string;
        try {
          rawBody = await readBody(req);
        } catch (e) {
          if (!(e instanceof BodyTooLarge)) throw e;
          tooLarge();
          return;
        }
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          sendJson(res, 400, { status: "error", message: "Invalid JSON body" });
          return;
        }

        const raw = readFileSync(filePath);
        const original = raw.toString("utf-8");
        // Bytes that are not UTF-8 would come back changed on every line, so refuse instead.
        if (!Buffer.from(original, "utf-8").equals(raw)) {
          sendJson(res, 409, { status: "error", message: `${rel} is not valid UTF-8, so it cannot be edited byte-safely. Nothing was written.` });
          return;
        }
        const plan = planBlockWrites(original, (parsedBody as { changes?: unknown } | null)?.changes);
        if (!plan.ok) {
          sendJson(res, plan.status, { status: "error", message: `${rel}: ${plan.message}`, errors: plan.errors });
          return;
        }

        // The one write of this request, all of it at once: only the vehicle's own .et.
        try {
          writeAtomic(filePath, plan.text);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EPERM" || code === "EACCES" || code === "EBUSY") {
            sendJson(res, 409, {
              status: "error",
              message: `${rel} is locked or read-only (Workbench may have it open), so it was not replaced. Nothing was changed.`,
            });
            return;
          }
          throw e;
        }

        // Best effort: ask Workbench to re-read the file so the change shows up in
        // the editor. A failure here is not a write failure (the bytes are on disk
        // either way), so it is reported alongside the success, never instead of it.
        let workbench: string | null = null;
        if (notifyWorkbench) {
          try {
            workbench = await notifyWorkbench(rel);
          } catch (e) {
            workbench = `Workbench not notified: ${e instanceof Error ? e.message : String(e)}`;
          }
        }

        sendJson(res, 200, {
          status: "ok",
          vehicle: rel,
          written: plan.written,
          message: RELOAD_REMINDER,
          workbench,
        });
        return;
      }

      sendJson(res, 404, { status: "error", message: "Not found" });
    } catch (e) {
      sendJson(res, 500, { status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  });
}
