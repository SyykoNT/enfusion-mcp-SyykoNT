/**
 * Parser and serializer for Enfusion text serialization format.
 * Used by .gproj, .et, .ct, .conf, .layer, .ent, .meta, .acp, .layout and the animation files.
 *
 * Grammar (as observed in the game data and local addons):
 *   File      = { Element }                      one root; zero or more in .layer/.ent
 *   Element   = ["$grp"] Class [Id | Name] [":" Parent] ["+"] "{" ObjectBody "}"
 *   GroupBody = { [Name] "{" ObjectBody "}" }    members of a $grp element
 *   Member    = Key Value | Key Number Number...  scalar or tuple, one per line
 *             | Key ["+"] "{" ListBody "}"       array or value list
 *             | Key Class [Id | Name] [":" Parent] "{" ObjectBody "}"
 *             | "{" ListBody "}"                 child entities of an entity
 *   ListBody  = { Element } | { Value... }       never mixed
 * Line breaks matter: the block's context decides whether `A B` is two list values or
 * `key value`. Strings escape only `\"`; `"a"\` newline `"b"` is one value "a\nb".
 */

/** A single property: key-value pair */
export interface EnfusionProperty {
  key: string;
  value: string | EnfusionNode;
  /**
   * Written with quotes. parse() sets it for every scalar; when undefined (new
   * properties) the serializer guesses from the value. Templates set it for fields that
   * are always strings (e.g. a widget Name) whose value could pass for an identifier.
   */
  quoted?: boolean;
  /** Source order among the parent's members (parsed trees only) */
  pos?: number;
  /** Source text, written back as is while key and value are unchanged */
  raw?: { text: string; key: string; value: string };
}

/** A node in the Enfusion text tree */
export interface EnfusionNode {
  /** Type name (e.g., "GameProject", "GenericEntity", "MeshObject"), or the key of an object member */
  type: string;
  /** Quoted GUID or bare name that follows the type name (e.g., component instance ID) */
  id?: string;
  /**
   * Class qualifier between type/key and the GUID.
   * E.g., in `Attributes SCR_ItemAttributeCollection "{GUID}" { ... }`,
   * type="Attributes", className="SCR_ItemAttributeCollection", id="{GUID}".
   */
  className?: string;
  /** Parent reference after ":" (e.g., "{GUID}path/to/parent.et", or a sibling name in .meta) */
  inheritance?: string;
  /** Key-value properties */
  properties: EnfusionProperty[];
  /** Standalone values (e.g., dependency GUIDs in Dependencies block) */
  values: string[];
  /** Child nodes (blocks nested inside this node) */
  children: EnfusionNode[];
  /**
   * Optional raw string to emit verbatim inside the braces instead of serializing
   * properties/values/children. Used when injecting ancestor components with their
   * original content preserved exactly.
   */
  rawContent?: string;
  /** `key + {`: appends to the inherited array instead of replacing it */
  append?: boolean;
  /** `$grp Class {`: entities sharing one class; its members have type "" */
  group?: boolean;
  /** Per entry of `values`: false when the source wrote it bare */
  valuesQuoted?: boolean[];
  /** Source order among the parent's members (parsed trees only) */
  pos?: number;
  /** Source head and value lines, written back as is while the fields they came from are unchanged */
  raw?: { head: string; sig: string; values?: string[]; valuesSig?: string };
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  t: "s" | "w" | "{" | "}" | ":" | "+";
  v: string;
  /** First and last line (a continued string spans several) */
  line: number;
  endLine: number;
  /** Offsets in the source */
  start: number;
  end: number;
}

const NUMBER = /^[-+]?(?:0x[0-9A-Fa-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]\d+)?)$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORD = /[^\s"{}:]+/y;
const CONTINUATION = /\\[ \t]*\n\s*"/y;

const fail = (line: number, msg: string) => new Error(`line ${line}: ${msg}`);
const newlines = (s: string, a: number, b: number) => s.slice(a, b).split("\n").length - 1;

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let line = 1;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (text.startsWith("//", i)) {
      i = text.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const e = text.indexOf("*/", i + 2);
      if (e < 0) throw fail(line, "unterminated comment");
      line += newlines(text, i, e);
      i = e + 2;
      continue;
    }
    const start = i, first = line;
    let t: Token["t"] = "w", v = "";
    if (c === '"') {
      t = "s";
      for (i++; ; ) {
        const ch = text[i];
        if (ch === undefined || ch === "\n") throw fail(first, "unterminated string");
        // Only \" is an escape: other backslashes are text (ὠ0 in vanilla localization)
        if (ch === "\\" && text[i + 1] === '"') { v += '"'; i += 2; continue; }
        if (ch !== '"') { v += ch; i++; continue; }
        CONTINUATION.lastIndex = i + 1;
        if (!CONTINUATION.test(text)) { i++; break; }
        line += newlines(text, i, CONTINUATION.lastIndex);
        v += "\n";
        i = CONTINUATION.lastIndex;
      }
    } else if (c === "{" || c === "}" || c === ":" || (c === "+" && /[\s{]/.test(text[i + 1] ?? " "))) {
      t = c;
      v = c;
      i++;
    } else {
      WORD.lastIndex = i;
      WORD.test(text);
      v = text.slice(i, WORD.lastIndex);
      i = WORD.lastIndex;
    }
    out.push({ t, v, line: first, endLine: line, start, end: i });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** list: lines are values, blocks are elements. object: lines are `key value`, blocks are members. */
type Context = "list" | "object" | "group";

const headSig = (n: EnfusionNode) =>
  JSON.stringify([n.type, n.className, n.id, n.inheritance, !!n.append, !!n.group]);
const valuesSig = (n: EnfusionNode) => JSON.stringify([n.values, n.valuesQuoted]);
const isValue = (t: Token) => t.t === "s" || t.t === "w";

function read(text: string): EnfusionNode[] {
  const toks = tokenize(text);
  const src = (a: Token, b: Token) => text.slice(a.start, b.end);
  let i = 0;

  /** For brace-count errors: the first line indented differently from its depth (one space per level). */
  const indentHint = () => {
    let depth = 0, prevEnd = 0;
    for (const t of toks) {
      if (t.t === "}") depth--;
      if (t.line > prevEnd && t.start - text.lastIndexOf("\n", t.start - 1) - 1 !== depth) {
        return ` (indent first disagrees with depth at line ${t.line})`;
      }
      if (t.t === "{") depth++;
      prevEnd = t.endLine;
    }
    return "";
  };

  /** Read a block head (the tokens before its `{`); returns the node and the context of its body. */
  const head = (ts: Token[], brace: Token, ctx: Context): [EnfusionNode, Context] => {
    const n: EnfusionNode = { type: "", properties: [], values: [], children: [] };
    let k = 0;
    const is = (...types: Token["t"][]) => k < ts.length && types.includes(ts[k].t);
    const bad = () => {
      const t = ts[k] ?? brace;
      return fail(t.line, `unexpected '${t.v}' in block head`);
    };
    if (ctx === "group") {
      if (ts.length > 1) { k = 1; throw bad(); }
      if (ts.length) {
        if (!is("w", "s")) throw bad();
        n.id = ts[0].v;
      }
      return [n, "object"];
    }
    if (ctx === "list" && ts[0]?.t === "w" && ts[0].v === "$grp") { n.group = true; k++; }
    if (ctx === "object" && !ts.length) return [n, "list"]; // bare `{`: child entities
    if (!is("w", "s")) throw bad();
    n.type = ts[k++].v;
    let body: Context = n.group ? "group" : "object";
    if (ctx === "object") {
      if (k === ts.length || is("+")) body = "list"; // `key {` or `key + {`
      else if (is("w")) n.className = ts[k++].v;
      else throw bad();
    }
    if (body !== "list") {
      if (is("w", "s")) n.id = ts[k++].v;
      if (is(":")) {
        k++;
        if (!is("w", "s")) throw bad();
        n.inheritance = ts[k++].v;
      }
    }
    if (is("+")) { n.append = true; k++; }
    if (k < ts.length) throw bad();
    return [n, body];
  };

  const body = (node: EnfusionNode, ctx: Context, open?: Token): void => {
    let pos = 0;
    for (;;) {
      const first = toks[i];
      if (!first) {
        if (open) throw fail(open.line, `'{' never closed${indentHint()}`);
        return;
      }
      if (first.t === "}") {
        if (!open) throw fail(first.line, `'}' without a matching '{'${indentHint()}`);
        i++;
        return;
      }
      // A statement ends at the end of its line, at a `{` (included) or before a `}`
      const st: Token[] = [];
      while (i < toks.length && toks[i].t !== "}" && (!st.length || toks[i].line === st[st.length - 1].endLine)) {
        st.push(toks[i++]);
        if (st[st.length - 1].t === "{") break;
      }
      const last = st[st.length - 1];
      if (last.t === "{") {
        const [child, inner] = head(st.slice(0, -1), last, ctx);
        child.pos = pos++;
        child.raw = { head: src(first, last), sig: headSig(child) };
        node.children.push(child);
        body(child, inner, last);
        if (child.values.length) child.raw.valuesSig = valuesSig(child);
      } else if (ctx === "object") {
        // Usually one member per line; inline input such as `coords 1 2 3 angleY 90` is split greedily
        for (let k = 0; k < st.length; ) {
          const key = st[k++], val = st[k++];
          if (!val || !isValue(key) || !isValue(val)) throw fail(first.line, `'${src(first, last)}' is not 'key value'`);
          let end = val, value = val.v;
          if (val.t === "w" && NUMBER.test(val.v)) {
            while (k < st.length && st[k].t === "w" && NUMBER.test(st[k].v)) {
              end = st[k++];
              value += ` ${end.v}`;
            }
          }
          node.properties.push({ key: key.v, value, quoted: val.t === "s", pos: pos++, raw: { text: src(key, end), key: key.v, value } });
        }
      } else {
        if (!open) throw fail(first.line, `'${src(first, last)}' is outside any block`);
        for (const t of st) {
          if (!isValue(t)) throw fail(t.line, `unexpected '${t.v}'`);
          node.values.push(t.v);
          (node.valuesQuoted ??= []).push(t.t === "s");
        }
        (node.raw!.values ??= []).push(src(first, last));
      }
    }
  };

  const root: EnfusionNode = { type: "", properties: [], values: [], children: [] };
  body(root, "list");
  return root.children;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/** A quoted string: only `"` is escaped; a newline becomes a `\`-continued line at `pad`. */
function str(s: string, pad = ""): string {
  return s.split("\n").map((piece) => {
    // `"a\"` would read back as an escaped quote
    if (piece.endsWith("\\")) throw new Error(`Cannot write a string ending in a backslash: ${piece}`);
    return `"${piece.replace(/"/g, '\\"')}"`;
  }).join(`\\\n${pad}`);
}

/**
 * Format a property key. Plain identifiers are emitted bare; keys containing
 * spaces or other non-identifier characters (e.g. UI widget properties like
 * "Blend Mode", "Font Size", "Horizontal Alignment") must be quoted.
 */
function formatKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(key) ? key : str(key);
}

const tuple = (v: string) => v.split(" ").every((x) => NUMBER.test(x));
const bareOk = (v: string) => /^[^\s"{}:]+$/.test(v) || tuple(v);

function headText(n: EnfusionNode): string {
  const parts = n.group ? ["$grp"] : [];
  if (n.type) parts.push(formatKey(n.type));
  if (n.className !== undefined) parts.push(n.className);
  // Node ID: bare word (e.g., "PC") or quoted GUID
  if (n.id !== undefined) parts.push(/^[A-Za-z0-9_]+$/.test(n.id) && !/^[0-9A-Fa-f]{16}$/.test(n.id) ? n.id : str(n.id));
  if (n.inheritance !== undefined) parts.push(":", str(n.inheritance));
  if (n.append) parts.push("+");
  parts.push("{");
  return parts.join(" ");
}

function serializeNode(node: EnfusionNode, indent: number): string {
  const pad = " ".repeat(indent);
  const innerPad = " ".repeat(indent + 1);
  const header = node.raw?.sig === headSig(node) ? node.raw.head : headText(node);

  // If raw content is provided, re-indent it to match the target depth and emit
  if (node.rawContent !== undefined) {
    const lines = node.rawContent.split("\n");
    // Find minimum indentation of non-empty lines
    let minIndent = Infinity;
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const leading = line.match(/^[ \t]*/)?.[0].length ?? 0;
      if (leading < minIndent) minIndent = leading;
    }
    if (minIndent === Infinity) minIndent = 0;

    // Re-indent each line to innerPad level
    const reindented = lines
      .map((line) => {
        if (line.trim().length === 0) return "";
        return innerPad + line.slice(minIndent);
      })
      .filter((line, idx, arr) => {
        // Remove leading/trailing blank lines
        if (idx === 0 && line === "") return false;
        if (idx === arr.length - 1 && line === "") return false;
        return true;
      })
      .join("\n");

    return `${pad}${header}\n${reindented}\n${pad}}`;
  }

  const prop = (p: EnfusionProperty): string => {
    // Value is a child node
    if (typeof p.value !== "string") return serializeNode(p.value, indent + 1);
    if (p.raw && p.raw.key === p.key && p.raw.value === p.value) return innerPad + p.raw.text;
    // Bare for numbers, numeric tuples and identifiers (enums like Manual, Runtime, None),
    // unless the source or the caller said otherwise
    const bare = p.quoted === false ? bareOk(p.value) : !p.quoted && (IDENT.test(p.value) || tuple(p.value));
    return `${innerPad}${formatKey(p.key)} ${bare ? p.value : str(p.value, innerPad)}`;
  };

  const parts = [pad + header];
  // Parsed members keep their source order; new ones follow: properties, values, children
  const placed = [...node.properties, ...node.children].filter((m) => m.pos !== undefined).sort((a, b) => a.pos! - b.pos!);
  for (const m of placed) parts.push("key" in m ? prop(m) : serializeNode(m, indent + 1));
  for (const p of node.properties) if (p.pos === undefined) parts.push(prop(p));
  if (node.raw?.values && node.raw.valuesSig === valuesSig(node)) {
    for (const line of node.raw.values) parts.push(innerPad + line);
  } else {
    node.values.forEach((v, k) => parts.push(innerPad + (node.valuesQuoted?.[k] === false && bareOk(v) ? v : str(v, innerPad))));
  }
  for (const c of node.children) if (c.pos === undefined) parts.push(serializeNode(c, indent + 1));
  parts.push(`${pad}}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse every top-level object of a file (a .layer or .ent may hold several, or none).
 * Throws with a line number on malformed input.
 */
export function parseAll(input: string): EnfusionNode[] {
  return read(input.replace(/^﻿/, "").replace(/\r\n/g, "\n"));
}

/**
 * Parse Enfusion text serialization format into a node tree. The input must hold exactly one top-level object.
 */
export function parse(input: string): EnfusionNode {
  const roots = parseAll(input);
  if (roots.length === 0) throw new Error("Empty input");
  if (roots.length > 1) throw new Error(`${roots.length} top-level objects; use parseAll()`);
  return roots[0];
}

/**
 * Serialize an EnfusionNode tree back to Enfusion text format. Lines join with "\n"; no final newline.
 */
export function serialize(node: EnfusionNode): string {
  return serializeNode(node, 0);
}

/** Serialize several top-level objects (a .layer), joined by `eol`, no final newline. */
export function serializeAll(nodes: EnfusionNode[], eol: "\n" | "\r\n" = "\n"): string {
  return nodes.map(serialize).join("\n").split("\n").join(eol);
}

/**
 * Create a new empty EnfusionNode.
 */
export function createNode(
  type: string,
  opts?: {
    id?: string;
    inheritance?: string;
    properties?: EnfusionProperty[];
    values?: string[];
    children?: EnfusionNode[];
  }
): EnfusionNode {
  return {
    type,
    id: opts?.id,
    inheritance: opts?.inheritance,
    properties: opts?.properties ?? [],
    values: opts?.values ?? [],
    children: opts?.children ?? [],
  };
}

/**
 * Helper: set or update a property on a node.
 */
export function setProperty(node: EnfusionNode, key: string, value: string | EnfusionNode): void {
  const existing = node.properties.find((p) => p.key === key);
  if (existing) {
    existing.value = value;
  } else {
    node.properties.push({ key, value });
  }
}

/**
 * Helper: get a property value from a node.
 */
export function getProperty(node: EnfusionNode, key: string): string | EnfusionNode | undefined {
  const prop = node.properties.find((p) => p.key === key);
  return prop?.value;
}
