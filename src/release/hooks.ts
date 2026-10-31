/** Staged paths that must never be committed: the MCP's Workbench handlers, their folder .meta, and the rdb cache. Matched ignoring case: Windows paths do. */
export const GUARDED_PATH = String.raw`^Scripts/WorkbenchGame/EnfusionMCP(/|\.meta$)|(^|/)resourceDatabase\.rdb$`;

export const HOOK_VERSION = 2;
const MARKER = `# enfusion-mcp-syykont commit guard v${HOOK_VERSION} (local hook, not tracked)`;

// Only sh builtins, grep, head and git: GitHub Desktop's embedded Git has no od or mktemp.
export const PRE_COMMIT = String.raw`#!/bin/sh
${MARKER}
bom=$(printf '\357\273\277')
fail=0
staged=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR)
hits=$(printf '%s\n' "$staged" | grep -iE '${GUARDED_PATH}')
if [ -n "$hits" ]; then
  printf '%s\n' "$hits" >&2
  echo "commit guard: MCP handler files or resourceDatabase.rdb are staged (above). Local probes such as SYK_*.c in that folder are refused too: they never ship." >&2; fail=1
fi
while IFS= read -r f; do
  case "$f" in *.c)
    if [ "$(git show ":$f" | head -c 3)" = "$bom" ]; then echo "commit guard: $f starts with a UTF-8 BOM (Enforce rejects it)." >&2; fail=1; fi ;;
  esac
done <<LIST
$staged
LIST
[ $fail -eq 0 ] || { echo "Fix: wb_cleanup (MCP), or git restore --staged <path>. Bypass (--no-verify) only with Don's OK." >&2; exit 1; }
`;

/** The attribution stripper Don's repos already carry (without our marker line). */
export const DON_COMMIT_MSG = String.raw`#!/bin/sh
# Local hook (not tracked): strip Claude/Anthropic attribution so commits read as SyykoNT only.
sed -i -E "/^[Cc]o-[Aa]uthored-[Bb]y:.*([Cc]laude|[Aa]nthropic)/d; /[Gg]enerated with \[?[Cc]laude [Cc]ode/d; /^[Cc]laude-[Ss]ession:/d" "$1"
# drop trailing blank lines left behind
sed -i -e :a -e "/^\n*\$/{\$d;N;ba" -e "}" "$1"
`;

export const COMMIT_MSG = DON_COMMIT_MSG.replace("\n", `\n${MARKER}\n`);

/** Version from our marker line, or null for a hook we did not write. */
export function ourVersion(text: string): number | null {
  const m = text.match(/^# enfusion-mcp-syykont commit guard v(\d+)/m);
  return m ? Number(m[1]) : null;
}
