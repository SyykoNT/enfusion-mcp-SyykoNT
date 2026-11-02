/**
 * Windows side of the watchdog: one long-lived PowerShell per watched Workbench that prints one JSON line
 * every 5 s (windows of that PID, IsHungAppWindow, memory, CPU, CrashReporter, NET API port owner), and a
 * one-shot script that clicks Ignore on the leak assert, and a read-only one that lists open dialogs. None may focus,
 * show, close or end anything.
 */

import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isDialog, leakAssertButton, LEAK_TEXT, type DialogProbe, type WinInfo } from "./signals.js";

export interface ProbeSample {
  t: number;
  alive: boolean;
  /** Process start time, epoch ms. */
  start?: number;
  ws?: number;
  cpu?: number;
  wins?: WinInfo[];
  crs?: { pid: number; ppid: number }[];
  port?: number | null;
}

const WIN32 = `Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class EmcpWatch {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, P f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  public static string Text(IntPtr h) { var s = new StringBuilder(4096); GetWindowText(h, s, 4096); return s.ToString(); }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static List<IntPtr> Top(uint pid) { var r = new List<IntPtr>(); EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) r.Add(h); return true; }, IntPtr.Zero); return r; }
  public static List<IntPtr> Kids(IntPtr parent) { var r = new List<IntPtr>(); EnumChildWindows(parent, (h, l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
}
"@
function Kids($h) { @(foreach ($k in [EmcpWatch]::Kids($h)) { [ordered]@{ hwnd = $k.ToInt64(); cls = [EmcpWatch]::Cls($k); text = [EmcpWatch]::Text($k) } }) }
function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }
function Own($h, $o) {
  $ow = [EmcpWatch]::GetWindow($h, 4)
  $o.enabled = [EmcpWatch]::IsWindowEnabled($h)
  $o.owner = $ow.ToInt64()
  $o.ownerEnabled = $null
  if ($ow -ne [IntPtr]::Zero) { [uint32]$op = 0; [void][EmcpWatch]::GetWindowThreadProcessId($ow, [ref]$op); if ($op -eq $WbPid) { $o.ownerEnabled = [EmcpWatch]::IsWindowEnabled($ow) } }
}
`;

/** Needs $WbPid and $Port. Children are listed only for #32770 dialog boxes. */
export const PROBE_SCRIPT = `$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
${WIN32}
while ($true) {
  $p = Get-Process -Id $WbPid
  if (-not $p) { Say ([ordered]@{ t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); alive = $false }); break }
  $wins = @(foreach ($h in [EmcpWatch]::Top([uint32]$WbPid)) {
    $o = [ordered]@{ hwnd = $h.ToInt64(); cls = [EmcpWatch]::Cls($h); text = [EmcpWatch]::Text($h); visible = $true; hung = [EmcpWatch]::IsHungAppWindow($h) }
    Own $h $o
    if ($o.cls -ceq '#32770') { $o.children = Kids $h }
    $o
  })
  $crs = @(Get-CimInstance Win32_Process -Filter "Name='CrashReporter.exe'" | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId } })
  $port = (Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1).OwningProcess
  Say ([ordered]@{ t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); alive = $true; start = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds(); ws = $p.WorkingSet64; cpu = $p.TotalProcessorTime.TotalSeconds; wins = $wins; crs = $crs; port = $port })
  Start-Sleep -Seconds 5
}
`;

/**
 * Needs $WbPid, $Hwnd, $Button. With $Button = 0 it prints the dialog and its children. Otherwise it checks
 * again, right before the click, that $Hwnd is a visible dialog box of $WbPid holding the leak text and that
 * $Button is its "&Ignore" button, then posts BM_CLICK to that button only.
 */
export const DISMISS_SCRIPT = `$ProgressPreference = 'SilentlyContinue'
${WIN32}
$h = [IntPtr][long]$Hwnd
[uint32]$owner = 0
[void][EmcpWatch]::GetWindowThreadProcessId($h, [ref]$owner)
if ($owner -ne $WbPid -or -not [EmcpWatch]::IsWindowVisible($h) -or [EmcpWatch]::Cls($h) -cne '#32770') { 'refused: the window is gone or is not a dialog box of that Workbench'; exit 2 }
$kids = Kids $h
if ($Button -eq 0) { Say ([ordered]@{ hwnd = $Hwnd; cls = '#32770'; text = [EmcpWatch]::Text($h); visible = $true; children = $kids }); exit 0 }
$btn = $kids | Where-Object { $_.hwnd -eq $Button -and $_.cls -ceq 'Button' -and $_.text -ceq '&Ignore' } | Select-Object -First 1
$leak = $kids | Where-Object { $_.text.Contains('${LEAK_TEXT}') } | Select-Object -First 1
if (-not $btn -or -not $leak) { 'refused: not the leak assert or no &Ignore button'; exit 2 }
[void][EmcpWatch]::PostMessage([IntPtr][long]$Button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
'clicked'
`;

/**
 * Needs $WbPid. One run: every visible top-level window of that PID that the same rule as isDialog() calls a
 * dialog, with its text. Reads only: Win32 getters and UI Automation FromHandle/FindAll/Name, no input, no focus.
 */
export const DIALOG_SCRIPT = `$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
${WIN32}
# --- dialog probe body ---
$titles = @('Opening world', 'Script Authorization Required')
$ae = [System.Windows.Automation.AutomationElement]
$descend = [System.Windows.Automation.TreeScope]::Descendants
function Names($el, $type) {
  $c = New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, $type)
  @(foreach ($e in $el.FindAll($descend, $c)) { $e.Current.Name })
}
$wins = @(foreach ($h in [EmcpWatch]::Top([uint32]$WbPid)) {
  $o = [ordered]@{ hwnd = $h.ToInt64(); cls = [EmcpWatch]::Cls($h); text = [EmcpWatch]::Text($h); visible = $true }
  Own $h $o
  if (($o.owner -ne 0 -and $o.ownerEnabled -eq $false -and $o.enabled) -or $o.cls -ceq '#32770' -or $titles -contains $o.text -or $o.text.StartsWith('Validating ')) {
    if ($o.cls -ceq '#32770') { $o.children = Kids $h }
    else {
      $el = $ae::FromHandle($h)
      $o.children = @(foreach ($t in (Names $el ([System.Windows.Automation.ControlType]::Text))) { [ordered]@{ hwnd = 0; cls = 'Text'; text = $t } })
      $o.buttons = @(Names $el ([System.Windows.Automation.ControlType]::Button))
    }
    $o
  }
})
Say ([ordered]@{ wins = $wins })
`;

/** Prefix integer parameters; anything else is refused so no text reaches the script. */
export function withArgs(script: string, args: Record<string, number>): string {
  const lines = Object.entries(args).map(([k, v]) => {
    if (!Number.isSafeInteger(v)) throw new Error(`${k} must be an integer`);
    return `$${k} = ${v}`;
  });
  return `${lines.join("\n")}\n${script}`;
}

const psArgs = (script: string) => ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];

export type PsRunner = (script: string, timeoutMs?: number) => Promise<{ code: number; out: string }>;

export const runPs: PsRunner = (script, timeoutMs = 30_000) =>
  new Promise((done) => {
    execFile("powershell", psArgs(script), { windowsHide: true, timeout: timeoutMs }, (err, out) =>
      done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, out: String(out) })
    );
  });

const DIALOG_TIMEOUT_MS = 8000;

/** Dialogs of each Workbench PID, one read-only PowerShell run per PID. Never throws: a failed run is that PID's "unavailable". */
export function probeDialogs(pids: number[], run: PsRunner = runPs): Promise<DialogProbe[]> {
  return Promise.all(
    pids.map(async (pid): Promise<DialogProbe> => {
      if (run === runPs && process.platform !== "win32") return { pid, unavailable: "only Windows can be checked" };
      try {
        const r = await run(withArgs(DIALOG_SCRIPT, { WbPid: pid }), DIALOG_TIMEOUT_MS);
        if (r.code !== 0) return { pid, unavailable: `the check failed or took over ${DIALOG_TIMEOUT_MS / 1000} s (exit ${r.code})` };
        const wins = (JSON.parse(r.out.trim().split("\n").pop()!) as { wins?: WinInfo[] }).wins ?? [];
        return { pid, dialogs: wins.filter(isDialog) };
      } catch (e) {
        return { pid, unavailable: e instanceof Error ? e.message : String(e) };
      }
    })
  );
}

/** Click Ignore on the leak assert `hwnd` of Workbench `pid`, only when both checks (here and in the script) match. */
export async function dismissLeakAssert(pid: number, hwnd: number, run: PsRunner = runPs): Promise<string> {
  const look = await run(withArgs(DISMISS_SCRIPT, { WbPid: pid, Hwnd: hwnd, Button: 0 }));
  if (look.code !== 0) return look.out.trim() || `refused: dialog check failed (exit ${look.code})`;
  let button: number | undefined;
  try {
    button = leakAssertButton(JSON.parse(look.out) as WinInfo);
  } catch {
    return "refused: unreadable dialog check output";
  }
  if (!button) return "refused: not the leak assert or no &Ignore button";
  return (await run(withArgs(DISMISS_SCRIPT, { WbPid: pid, Hwnd: hwnd, Button: button }))).out.trim();
}

/** Run the probe for `pid`, call `onSample` per line, restart it 5 s after it dies until stopped. */
export function startProbe(pid: number, port: number, onSample: (s: ProbeSample) => void, spawnFn: typeof spawn = spawn): { stop(): void } {
  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  const start = () => {
    child = spawnFn("powershell", psArgs(withArgs(PROBE_SCRIPT, { WbPid: pid, Port: port })), { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", () => {}); // a missing powershell ends in 'exit' too, which restarts it
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        onSample(JSON.parse(line) as ProbeSample);
      } catch {
        // not a sample line
      }
    });
    child.on("exit", () => {
      if (!stopped) setTimeout(() => !stopped && start(), 5000).unref();
    });
  };
  start();
  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}
