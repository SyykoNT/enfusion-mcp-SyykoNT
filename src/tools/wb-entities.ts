import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, ensureMode } from "../workbench/status.js";

// 1.9 packs an extra empty object before each real array row; a real property row has a name
function namedRows(rows: unknown): Record<string, unknown>[] {
  return (Array.isArray(rows) ? rows : []).filter((r) => r?.name);
}

function formatEntityDetails(data: Record<string, unknown>): string {
  const lines: string[] = [];

  if (data.name) lines.push(`- **Name:** ${data.name}`);
  if (data.prefab) lines.push(`- **Prefab:** ${data.prefab}`);
  if (data.className) lines.push(`- **Class:** ${data.className}`);
  if (data.position) lines.push(`- **Position:** ${data.position}`);
  if (data.rotation) lines.push(`- **Rotation:** ${data.rotation}`);
  if (data.layerPath) lines.push(`- **Layer:** ${data.layerPath}`);
  if (data.parentName) lines.push(`- **Parent:** ${data.parentName}`);

  // 1.9 packs an empty object before each real component row; a real one has a class
  const comps = (Array.isArray(data.components) ? data.components : []).filter((c) => c?.className || c?.type);
  if (comps.length > 0) {
    lines.push(`\n### Components (${comps.length})`);
    comps.forEach((comp, i) => lines.push(`${i}. ${comp.className || comp.type}`));
  }

  // Values the entity holds (the handler marks a type it cannot read instead of printing a class default); entity-level properties only, capped by the handler
  const props = namedRows(data.properties);
  if (props.length > 0) {
    const total = typeof data.varCount === "number" ? data.varCount : props.length;
    lines.push(`\n### Properties (${props.length}${total > props.length ? ` of ${total}` : ""})`);
    const held = props.filter((p) => p.value !== undefined && p.value !== "");
    if (held.length > 0) lines.push("| Property | Value |", "|---|---|");
    for (const p of held) lines.push(`| ${p.name} | ${p.value} |`);
    // 1.9 lists script-method names with no value; they would bury the real properties
    const empty = props.filter((p) => !held.includes(p));
    if (empty.length > 0) lines.push(`${held.length > 0 ? "\n" : ""}*${empty.length} ${held.length > 0 ? "more " : ""}with no value: ${empty.slice(0, 5).map((p) => p.name).join(", ")}${empty.length > 5 ? ", ..." : ""}*`);
  }

  if (Array.isArray(data.children) && data.children.length > 0) {
    lines.push(`\n### Children (${data.children.length})`);
    for (const child of data.children) {
      const c = child as Record<string, unknown>;
      lines.push(`- ${c.name || "unnamed"}`);
    }
  }

  return lines.join("\n");
}

function formatEntityList(data: Record<string, unknown>): string {
  const lines: string[] = [];
  // 1.9 packs an empty object before each real entity row; a real one has a name, class or position
  const entities = (Array.isArray(data.entities) ? data.entities : []).filter((e) => e?.name || e?.className || e?.position);
  // the handler sends totalCount; total is the older name
  const count = data.totalCount ?? data.total;
  const total = typeof count === "number" ? count : entities.length;
  const offset = typeof data.offset === "number" ? data.offset : 0;

  lines.push(`**Entities** (showing ${entities.length} of ${total}, offset ${offset})\n`);

  for (let i = 0; i < entities.length; i++) {
    const ent = entities[i] as Record<string, unknown>;
    const name = ent.name || "(unnamed)";
    const prefab = ent.prefab ? ` [${ent.prefab}]` : "";
    const pos = ent.position ? ` at ${ent.position}` : "";
    lines.push(`${offset + i + 1}. **${name}**${prefab}${pos}`);
  }

  if (total > offset + entities.length) {
    lines.push(`\n*${total - offset - entities.length} more entities not shown. Use offset/limit to paginate.*`);
  }

  return lines.join("\n");
}

export function registerWbEntityTools(server: McpServer, client: WorkbenchClient): void {
  // wb_entity_create
  server.registerTool(
    "wb_entity_create",
    {
      description:
        "Create a new entity in the World Editor from a prefab. Optionally set position, rotation, name, and target layer. Only works in edit mode (not play mode).",
      inputSchema: {
        prefab: z
          .string()
          .describe("Prefab resource path: a {GUID}path such as '{GUID}Prefabs/<path>.et' from asset_search or game_read; never typed from memory."),
        position: z
          .string()
          .optional()
          .describe("World position as 'x y z' (e.g., '100 0 200'). Defaults to origin."),
        rotation: z
          .string()
          .optional()
          .describe("Rotation as 'pitch yaw roll' in degrees (e.g., '0 90 0')"),
        name: z
          .string()
          .optional()
          .describe("Entity display name. Auto-generated if omitted."),
        layerPath: z
          .string()
          .optional()
          .describe("Target layer path (e.g., 'default/MyLayer'). Uses active layer if omitted."),
      },
    },
    async ({ prefab, position, rotation, name, layerPath }) => {
      const modeErr = await ensureMode(client, "edit", "create entity");
      if (modeErr) {
        return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }], isError: true };
      }
      try {
        const params: Record<string, unknown> = { prefab };
        if (position) params.position = position;
        if (rotation) params.rotation = rotation;
        if (name) params.name = name;
        if (layerPath) params.layerPath = layerPath;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_CreateEntity", params);

        const lines: string[] = ["**Entity Created**\n"];
        if (result.name) lines.push(`- **Name:** ${result.name}`);
        lines.push(`- **Prefab:** ${prefab}`);
        if (position) lines.push(`- **Position:** ${position}`);
        if (rotation) lines.push(`- **Rotation:** ${rotation}`);
        // The layer the handler read back; an old handler ignores layerPath and reports none.
        if (typeof result.layerPath === "string" && result.layerPath) lines.push(`- **Layer:** ${result.layerPath}`);
        else if (layerPath) lines.push(`- **Layer:** ${layerPath} requested, not confirmed (handler out of date or no layer reported; check with wb_layers)`);
        if (result.id) lines.push(`- **ID:** ${result.id}`);

        return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error creating entity: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );

  // wb_entity_delete
  server.registerTool(
    "wb_entity_delete",
    {
      description: "Delete an entity from the World Editor by name. Only works in edit mode.",
      inputSchema: {
        name: z.string().describe("Name of the entity to delete"),
      },
    },
    async ({ name }) => {
      const modeErr = await ensureMode(client, "edit", "delete entity");
      if (modeErr) {
        return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }], isError: true };
      }
      try {
        await client.call("EMCP_WB_DeleteEntity", { name });

        return {
          content: [
            {
              type: "text" as const,
              text: `**Entity Deleted**\n\nRemoved entity: ${name}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error deleting entity "${name}": ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );

  // wb_entity_list
  server.registerTool(
    "wb_entity_list",
    {
      description:
        "List entities in the current world. Supports pagination and optional name filtering.",
      inputSchema: {
        offset: z
          .number()
          .default(0)
          .describe("Starting offset for pagination (default 0)"),
        limit: z
          .number()
          .default(50)
          .describe("Maximum number of entities to return (default 50)"),
        nameFilter: z
          .string()
          .optional()
          .describe("Filter entities by name substring (case-insensitive)"),
      },
    },
    async ({ offset, limit, nameFilter }) => {
      try {
        const params: Record<string, unknown> = { offset, limit };
        if (nameFilter) params.nameFilter = nameFilter;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_ListEntities", params);

        return {
          content: [{ type: "text" as const, text: formatEntityList(result) + formatConnectionStatus(client) }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error listing entities: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );

  // wb_entity_inspect
  server.registerTool(
    "wb_entity_inspect",
    {
      description:
        "Get detailed information about a specific entity, including its components, properties, position, and children. Identify by name or index.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Entity name to inspect"),
        index: z
          .number()
          .optional()
          .describe("Entity index (from wb_entity_list) to inspect"),
      },
    },
    async ({ name, index }) => {
      try {
        const params: Record<string, unknown> = {};
        if (name) params.name = name;
        if (index !== undefined) params.index = index;

        if (!name && index === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Provide either `name` or `index` to identify the entity.",
              },
            ],
            isError: true,
          };
        }

        const result = await client.call<Record<string, unknown>>("EMCP_WB_GetEntity", params);

        const label = name || `index ${index}`;
        return {
          content: [
            {
              type: "text" as const,
              text: `**Entity: ${result.name || label}**\n\n${formatEntityDetails(result)}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error inspecting entity: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );

  // wb_entity_modify
  server.registerTool(
    "wb_entity_modify",
    {
      description:
        "Modify an entity in the World Editor. Supports moving, rotating, renaming, reparenting, and setting or clearing component properties. Only works in edit mode. Enum properties: setProperty refuses a name that is not in the property's enum list (names are listed in the refusal); still verify a setProperty with getProperty.",
      inputSchema: {
        name: z.string().describe("Name of the entity to modify"),
        action: z
          .enum([
            "move", "rotate", "rename", "reparent",
            "setProperty", "clearProperty", "getProperty", "listProperties",
            "listArrayItems", "addArrayItem", "removeArrayItem", "setObjectClass",
            "getWorldTransform", "makeVisible",
          ])
          .describe(
            "Modification action: move (set position), rotate (set rotation), rename, reparent (change parent entity), setProperty (set a component property), clearProperty (reset to default), getProperty (read a property value), listProperties (list all property names on entity or component), listArrayItems (list items in an array-of-objects property with class names and indices), addArrayItem (append item to array-of-objects property — like the + button), removeArrayItem (remove item from array by index), setObjectClass (change class of an object property — like the dropdown), getWorldTransform (read world position and rotation), makeVisible (scroll World Editor hierarchy to this entity)"
          ),
        value: z
          .string()
          .optional()
          .describe(
            "Value for the action: coordinates 'x y z' for move/rotate, new name for rename, parent name for reparent, property value for setProperty, item class for addArrayItem, new class for setObjectClass. Not needed for clearProperty/getProperty/listProperties/removeArrayItem."
          ),
        propertyPath: z
          .string()
          .optional()
          .describe("Component property path for setProperty/clearProperty (e.g., 'MeshObject.Object')"),
        propertyKey: z
          .string()
          .optional()
          .describe("Property key name for setProperty/clearProperty/getProperty/listProperties/listArrayItems/addArrayItem/removeArrayItem/setObjectClass"),
        memberIndex: z
          .number()
          .default(-1)
          .describe("Array element index for addArrayItem (insert position, -1 = append) or removeArrayItem (item to remove, 0-based)"),
      },
    },
    async ({ name, action, value, propertyPath, propertyKey, memberIndex }) => {
      // Only require edit mode for mutating actions, not read-only ones
      const READ_ONLY_ACTIONS = ["getProperty", "listProperties", "listArrayItems", "getWorldTransform", "makeVisible"];
      if (!READ_ONLY_ACTIONS.includes(action)) {
        const modeErr = await ensureMode(client, "edit", "modify entity");
        if (modeErr) {
          return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }], isError: true };
        }
      }
      try {
        // Validate value is provided for actions that require it
        // Note: setProperty allows empty string as a valid value, so it's validated separately
        const actionsRequiringValue = ["move", "rotate", "rename", "reparent", "addArrayItem", "setObjectClass"];
        if (actionsRequiringValue.includes(action) && (!value || value.trim() === "")) {
          return {
            content: [{ type: "text" as const, text: `Error: "value" parameter is required for the "${action}" action.` }],
          isError: true,
          };
        }
        if (action === "setProperty" && value === undefined) {
          return {
            content: [{ type: "text" as const, text: `Error: "value" parameter is required for the "${action}" action.` }],
          isError: true,
          };
        }

        const params: Record<string, unknown> = { name, action };
        if (!READ_ONLY_ACTIONS.includes(action)) {
          params.value = value ?? "";
        }
        if (propertyPath) params.propertyPath = propertyPath;
        if (propertyKey) params.propertyKey = propertyKey;
        // Always send memberIndex for array actions (-1 = append for addArrayItem)
        if (action === "addArrayItem" || action === "removeArrayItem") {
          params.memberIndex = memberIndex;
        }

        const result = await client.call<Record<string, unknown>>("EMCP_WB_ModifyEntity", params);

        // Special output for getWorldTransform
        if (action === "getWorldTransform") {
          const props = Array.isArray(result.properties) ? result.properties : [];
          const pos = (props as Record<string, unknown>[]).find((p) => p.name === "position");
          const rot = (props as Record<string, unknown>[]).find((p) => p.name === "rotation");
          return {
            content: [{
              type: "text" as const,
              text: `**Transform: ${name}**\n\n- **Position:** ${(pos?.value as string | undefined)?.trim() || "(unknown)"}\n- **Rotation:** ${(rot?.value as string | undefined)?.trim() || "(unknown)"}${formatConnectionStatus(client)}`,
            }],
          };
        }

        // Enhanced output for listProperties
        if (action === "listProperties") {
          const props = namedRows(result.properties);
          if (props.length === 0) {
            return { content: [{ type: "text" as const, text: `**No properties found.**${formatConnectionStatus(client)}` }] };
          }
          const lines = [
            `**Properties${propertyPath ? " of " + propertyPath : ""}** (${props.length})\n`,
            "| Property | Value |",
            "|---|---|",
          ];
          for (const p of props) {
            const prop = p as Record<string, unknown>;
            lines.push(`| ${prop.name} | ${prop.value || ""} |`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
        }

        const actionLabels: Record<string, string> = {
          move: `Moved to ${value}`,
          rotate: `Rotated to ${value}`,
          rename: `Renamed to "${value}"`,
          reparent: `Reparented to "${value}"`,
          setProperty: `Set ${propertyPath || propertyKey || "property"} = ${value}`,
          clearProperty: `Cleared ${propertyPath || propertyKey || "property"}`,
          getProperty: `Got ${propertyPath ? propertyPath + "." : ""}${propertyKey || "property"}`,
          listProperties: `Listed properties${propertyPath ? " of " + propertyPath : ""}`,
          listArrayItems: `Listed array items in '${propertyKey || "array"}'`,
          addArrayItem: `Added '${value}' to '${propertyKey || "array"}' at index ${memberIndex ?? -1}`,
          removeArrayItem: `Removed index ${memberIndex ?? 0} from '${propertyKey || "array"}'`,
          setObjectClass: `Changed class of '${propertyKey || "property"}' to '${value}'`,
          getWorldTransform: `Got world transform of ${name}`,
          makeVisible: `Scrolled to ${name}`,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `**Entity Modified**\n\n- **Entity:** ${name}\n- **Action:** ${actionLabels[action] || action}${result.message ? `\n- **Note:** ${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error modifying entity "${name}": ${msg}${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // wb_entity_select
  server.registerTool(
    "wb_entity_select",
    {
      description:
        "Manage entity selection in the World Editor. 'select' clears the current selection and only locates the entity; it does not select it. " +
        "'deselect', 'clear' and 'getSelected' use the documented selection API.",
      inputSchema: {
        action: z
          .enum(["select", "deselect", "clear", "getSelected"])
          .describe("Selection action to perform"),
        name: z
          .string()
          .optional()
          .describe("Entity name (required for select/deselect, ignored for clear/getSelected)"),
      },
    },
    async ({ action, name }) => {
      try {
        if ((action === "select" || action === "deselect") && !name) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: \`name\` is required for the "${action}" action.`,
              },
            ],
            isError: true,
          };
        }

        const params: Record<string, unknown> = { action };
        if (name) params.name = name;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_SelectEntity", params);

        if (action === "getSelected") {
          const selected = Array.isArray(result.selected) ? result.selected : [];
          if (selected.length === 0) {
            return {
              content: [{ type: "text" as const, text: `**No entities selected.**${formatConnectionStatus(client)}` }],
            };
          }
          const lines = ["**Selected Entities**\n"];
          for (const ent of selected) {
            const e = ent as Record<string, unknown>;
            lines.push(`- ${e.name || "(unnamed)"}`);
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
        }

        const labels: Record<string, string> = {
          select: `Selected: ${name}`,
          deselect: `Deselected: ${name}`,
          clear: "Selection cleared",
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `**${labels[action]}**${result.message ? `\n\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            { type: "text" as const, text: `Error with selection (${action}): ${msg}${formatConnectionStatus(client)}` },
          ],
          isError: true,
        };
      }
    }
  );
}
