import { execFileSync } from "node:child_process";

export interface PythonCommand {
  cmd: string;
  /** Arguments that select the interpreter (e.g. ["-3"] for the py launcher). */
  args: string[];
  version: string;
}

let cached: PythonCommand | null | undefined;

/**
 * First Python 3.11 or newer (the version CRF's CI runs): ENFUSION_PYTHON, then `py -3` on
 * Windows, then `python`, then `python3`. Cached per process; null when none is found.
 */
export function findPython(): PythonCommand | null {
  if (cached !== undefined) return cached;
  const candidates: [string, string[]][] = [];
  if (process.env.ENFUSION_PYTHON) candidates.push([process.env.ENFUSION_PYTHON, []]);
  if (process.platform === "win32") candidates.push(["py", ["-3"]]);
  candidates.push(["python", []], ["python3", []]);

  for (const [cmd, args] of candidates) {
    try {
      const out = execFileSync(cmd, [...args, "--version"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(out);
      if (m && Number(m[1]) === 3 && Number(m[2]) >= 11) {
        return (cached = { cmd, args, version: `${m[1]}.${m[2]}.${m[3]}` });
      }
    } catch {
      // not installed or not runnable: try the next one
    }
  }
  return (cached = null);
}
