import { createNode, serialize, type EnfusionNode } from "../formats/enfusion-text.js";
import { generateGuid } from "../formats/guid.js";
import { recipeLoader } from "./recipe-loader.js";

export type PrefabType =
  | "firearm"
  | "attachment"
  | "ground_vehicle"
  | "air_vehicle"
  | "character"
  | "prop"
  | "building"
  | "item"
  | "group"
  | "spawnpoint"
  | "gamemode"
  | "generic";

export interface ComponentDef {
  type: string;
  /** Raw 16-character uppercase hex GUID (without braces). Generated if omitted. */
  guid?: string;
  properties?: Record<string, string>;
}

export interface PrefabOptions {
  /** Prefab name (used for filename and ID) */
  name: string;
  /** Prefab template type */
  prefabType: PrefabType;
  /** Optional recipe variant (e.g., "handgun" for firearm type) */
  variant?: string;
  /** Parent prefab path to inherit from (uses recipe default if omitted) */
  parentPrefab?: string;
  /** Additional components to add */
  components?: ComponentDef[];
  /** Description (used for m_sDisplayName if applicable) */
  description?: string;
  /** Root entity class (the parent's, when resolved). Default: the recipe's entityType. */
  rootClass?: string;
  /**
   * The parent chain's top-level components. A component of a type listed here once reuses
   * its ID (an override, not a second component); one with no value left is dropped.
   */
  parentComponents?: { type: string; guid: string }[];
}


/**
 * Generate an Enfusion .et prefab file.
 * Recipe components, user components and the description's editable component, matched to the
 * parent's component IDs when parentComponents is given. Empty ("") values are never written.
 */
export function generatePrefab(opts: PrefabOptions): string {
  const recipe = recipeLoader.getRecipe(opts.prefabType, opts.variant);
  const parentPrefab = opts.parentPrefab || recipe.defaultParent;
  const entityGuid = generateGuid();

  const root = createNode(opts.rootClass ?? recipe.entityType, {
    inheritance: parentPrefab || undefined,
    properties: [{ key: "ID", value: entityGuid, quoted: true }],
  });

  const recipeComponents: ComponentDef[] = recipe.overrideComponents.map((override) => ({
    type: override.type,
    properties: { ...override.properties },
  }));

  // A user component of a recipe type merges into it, so one type never gets two blocks with one ID
  const allComponents = [...recipeComponents];
  for (const comp of opts.components ?? []) {
    const same = comp.guid ? undefined : recipeComponents.find((rc) => rc.type === comp.type);
    if (same) same.properties = { ...same.properties, ...comp.properties };
    else allComponents.push({ ...comp, properties: { ...comp.properties } });
  }
  if (opts.description) {
    const editable = allComponents.find((c) => c.type === "SCR_EditableEntityComponent");
    if (editable) editable.properties = { ...editable.properties, m_sDisplayName: opts.description };
    else allComponents.push({ type: "SCR_EditableEntityComponent", properties: { m_sDisplayName: opts.description } });
  }

  const parent = opts.parentComponents;
  const componentNodes: EnfusionNode[] = [];
  for (const comp of allComponents) {
    const properties = Object.entries(comp.properties ?? {}).filter(([, value]) => value !== "");
    const matches = parent?.filter((p) => p.type === comp.type) ?? [];
    // An override block with no values changes nothing
    if (matches.length > 0 && !comp.guid && properties.length === 0) continue;
    if (matches.length > 1 && !comp.guid) {
      throw new Error(
        `Parent has ${matches.length} top-level components of type ${comp.type} (${matches.map((m) => `{${m.guid}}`).join(",")}); pass "guid" for the one to override.`
      );
    }
    componentNodes.push(
      createNode(comp.type, {
        id: `{${comp.guid ?? matches[0]?.guid ?? generateGuid()}}`,
        properties: properties.map(([key, value]) => ({ key, value })),
      })
    );
  }

  if (componentNodes.length > 0) {
    root.children.push(createNode("components", { children: componentNodes }));
  }

  return serialize(root);
}

/**
 * Get the subdirectory for a prefab type.
 */
export function getPrefabSubdirectory(prefabType: PrefabType, variant?: string): string {
  const recipe = recipeLoader.getRecipe(prefabType, variant);
  return recipe.subdirectory;
}

/**
 * Derive a filename from the prefab name.
 */
export function getPrefabFilename(name: string): string {
  return `${name}.et`;
}
