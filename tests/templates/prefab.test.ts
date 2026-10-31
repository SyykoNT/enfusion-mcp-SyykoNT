import { describe, it, expect } from "vitest";
import { generatePrefab, getPrefabSubdirectory, getPrefabFilename } from "../../src/templates/prefab.js";
import { parse } from "../../src/formats/enfusion-text.js";

describe("generatePrefab", () => {
  it("generates valid Enfusion text for generic prefab", () => {
    const text = generatePrefab({ name: "Test", prefabType: "generic" });
    const node = parse(text);
    expect(node.type).toBe("GenericEntity");
  });

  it("generates spawnpoint prefab as an SCR_SpawnPoint entity", () => {
    const text = generatePrefab({ name: "MySpawn", prefabType: "spawnpoint" });
    const node = parse(text);
    // SCR_SpawnPoint is the entity class, not a component
    expect(node.type).toBe("SCR_SpawnPoint");
    expect(node.inheritance).toBe("Prefabs/MP/Spawning/SpawnPoint_Base.et");
  });

  it("generates character prefab", () => {
    const text = generatePrefab({ name: "MyChar", prefabType: "character" });
    const node = parse(text);
    expect(node.type).toBe("SCR_ChimeraCharacter");
    const comps = node.children.find((c) => c.type === "components");
    expect(comps).toBeDefined();
    // Recipe components should be present (MeshObject, SCR_CharacterAnimationComponent)
    expect(comps!.children.length).toBeGreaterThan(0);
  });

  it("generates prop prefab with mesh", () => {
    const text = generatePrefab({ name: "Door", prefabType: "prop" });
    const node = parse(text);
    expect(node.type).toBe("GenericEntity");
    const comps = node.children.find((c) => c.type === "components");
    expect(comps).toBeDefined();
    expect(comps!.children.find((c) => c.type === "MeshObject")).toBeDefined();
  });

  it("includes parent prefab as inheritance", () => {
    const text = generatePrefab({
      name: "MyFirearm",
      prefabType: "firearm",
      parentPrefab: "{AABB}Prefabs/Weapons/AK47.et",
    });
    const node = parse(text);
    expect(node.inheritance).toBe("{AABB}Prefabs/Weapons/AK47.et");
  });

  it("generates firearm prefab with variant", () => {
    const text = generatePrefab({
      name: "MyPistol",
      prefabType: "firearm",
      variant: "handgun",
    });
    const node = parse(text);
    expect(node.type).toBe("GenericEntity");
    const comps = node.children.find((c) => c.type === "components");
    expect(comps).toBeDefined();
    // Should have recipe override components
    expect(comps!.children.find((c) => c.type === "MeshObject")).toBeDefined();
  });

  it("generates ground_vehicle prefab", () => {
    const text = generatePrefab({ name: "MyCar", prefabType: "ground_vehicle" });
    const node = parse(text);
    expect(node.type).toBe("Vehicle");
  });

  it("adds custom components", () => {
    const text = generatePrefab({
      name: "Custom",
      prefabType: "generic",
      components: [
        { type: "RigidBody", properties: { Mass: "10" } },
      ],
    });
    const node = parse(text);
    const comps = node.children.find((c) => c.type === "components");
    expect(comps).toBeDefined();
    const rb = comps!.children.find((c) => c.type === "RigidBody");
    expect(rb).toBeDefined();
    const massProp = rb!.properties.find((p) => p.key === "Mass");
    expect(massProp).toBeDefined();
    expect(massProp!.value).toBe("10");
  });

  it("adds editable component with description", () => {
    const text = generatePrefab({
      name: "Test",
      prefabType: "generic",
      description: "A test entity",
    });
    const node = parse(text);
    const comps = node.children.find((c) => c.type === "components");
    expect(comps).toBeDefined();
    const editable = comps!.children.find((c) => c.type === "SCR_EditableEntityComponent");
    expect(editable).toBeDefined();
    const nameProp = editable!.properties.find((p) => p.key === "m_sDisplayName");
    expect(nameProp).toBeDefined();
    expect(nameProp!.value).toBe("A test entity");
  });

  it("generates gamemode prefab", () => {
    const text = generatePrefab({ name: "MyMode", prefabType: "gamemode" });
    const node = parse(text);
    const comps = node.children.find((c) => c.type === "components");
    expect(comps).toBeDefined();
    // Recipe override components should be present
    expect(comps!.children.length).toBeGreaterThan(0);
  });

  it("all component nodes have GUIDs", () => {
    const text = generatePrefab({ name: "Test", prefabType: "prop" });
    const node = parse(text);
    const comps = node.children.find((c) => c.type === "components");
    for (const child of comps!.children) {
      expect(child.id).toBeDefined();
      expect(child.id).toMatch(/^\{[0-9A-F]{16}\}$/);
    }
  });

  const rifleParent = [
    { type: "MeshObject", guid: "CFBAA4B701F95D69" },
    { type: "WeaponSoundComponent", guid: "5A8685198A9AEEDD" },
  ];
  const compsOf = (text: string) => parse(text).children.find((c) => c.type === "components")?.children ?? [];

  it("never writes empty recipe placeholders", () => {
    const mesh = compsOf(generatePrefab({ name: "T", prefabType: "firearm" })).find((c) => c.type === "MeshObject");
    expect(mesh).toBeDefined();
    expect(mesh!.properties.find((p) => p.key === "Object")).toBeUndefined();
  });

  it("writes no component blocks when the parent has every recipe type and nothing is set", () => {
    const text = generatePrefab({ name: "T", prefabType: "firearm", variant: "rifle", parentComponents: rifleParent });
    expect(compsOf(text)).toEqual([]);
  });

  it("reuses the parent's component ID for a value it sets", () => {
    const comps = compsOf(generatePrefab({
      name: "T",
      prefabType: "firearm",
      parentComponents: rifleParent,
      components: [{ type: "MeshObject", properties: { Object: "{0000000000000001}Assets/X.xob" } }],
    }));
    expect(comps.map((c) => [c.type, c.id])).toEqual([["MeshObject", "{CFBAA4B701F95D69}"]]);
  });

  it("requires guid when the parent has the type twice", () => {
    const parentComponents = [{ type: "SoundComponent", guid: "1111111111111111" }, { type: "SoundComponent", guid: "2222222222222222" }];
    const components = [{ type: "SoundComponent", properties: { A: "1" } }];
    expect(() => generatePrefab({ name: "T", prefabType: "generic", parentComponents, components })).toThrow(/pass "guid"/);
    const comps = compsOf(generatePrefab({ name: "T", prefabType: "generic", parentComponents, components: [{ ...components[0], guid: "2222222222222222" }] }));
    expect(comps.find((c) => c.type === "SoundComponent")!.id).toBe("{2222222222222222}");
  });

  it("always quotes the root ID, as Workbench writes it", () => {
    for (let i = 0; i < 20; i++) {
      expect(generatePrefab({ name: "T", prefabType: "generic" })).toMatch(/^ ID "[0-9A-F]{16}"$/m);
    }
  });

  it("uses rootClass over the recipe entity type", () => {
    expect(parse(generatePrefab({ name: "T", prefabType: "prop", rootClass: "SCR_DestructibleEntity" })).type).toBe("SCR_DestructibleEntity");
  });

  it("keeps a property-less recipe component the parent lacks, with a new ID", () => {
    const comps = compsOf(generatePrefab({ name: "T", prefabType: "prop", variant: "interactive", parentComponents: [] }));
    const storage = comps.find((c) => c.type === "SCR_UniversalInventoryStorageComponent");
    expect(storage?.id).toMatch(/^\{[0-9A-F]{16}\}$/);
  });

  it("a group without ancestry gets no second SCR_CallsignGroupComponent", () => {
    // PlayableGroup already has one; an empty override block would add a copy with a new ID.
    expect(compsOf(generatePrefab({ name: "T", prefabType: "group" }))).toEqual([]);
  });

  it("merges a user component into the recipe component of the same type", () => {
    const comps = compsOf(generatePrefab({
      name: "T",
      prefabType: "firearm",
      components: [{ type: "MeshObject", properties: { Object: "X.xob" } }, { type: "RigidBody" }],
    }));
    expect(comps.filter((c) => c.type === "MeshObject")).toHaveLength(1);
    expect(comps.find((c) => c.type === "RigidBody")).toBeDefined();
  });

  it("generates all new recipe types", () => {
    const types: Array<[string, string]> = [
      ["firearm", "GenericEntity"],
      ["attachment", "GenericEntity"],
      ["ground_vehicle", "Vehicle"],
      ["air_vehicle", "Vehicle"],
      ["character", "SCR_ChimeraCharacter"],
      ["prop", "GenericEntity"],
      ["building", "SCR_DestructibleBuildingEntity"],
      ["item", "GenericEntity"],
      ["group", "SCR_AIGroup"],
      ["spawnpoint", "SCR_SpawnPoint"],
      ["gamemode", "SCR_BaseGameMode"],
      ["generic", "GenericEntity"],
    ];

    for (const [type, expectedEntity] of types) {
      const text = generatePrefab({
        name: `Test${type}`,
        prefabType: type as any,
      });
      const node = parse(text);
      expect(node.type).toBe(expectedEntity);
    }
  });
});

describe("getPrefabSubdirectory", () => {
  it("returns correct base subdirectories", () => {
    expect(getPrefabSubdirectory("character")).toBe("Prefabs/Characters");
    expect(getPrefabSubdirectory("ground_vehicle")).toBe("Prefabs/Vehicles");
    expect(getPrefabSubdirectory("firearm")).toBe("Prefabs/Weapons");
    expect(getPrefabSubdirectory("spawnpoint")).toBe("Prefabs/Systems");
    expect(getPrefabSubdirectory("prop")).toBe("Prefabs/Props");
    expect(getPrefabSubdirectory("generic")).toBe("Prefabs");
  });

  it("returns variant-specific subdirectories", () => {
    expect(getPrefabSubdirectory("firearm", "handgun")).toBe("Prefabs/Weapons/Handguns");
    expect(getPrefabSubdirectory("firearm", "rifle")).toBe("Prefabs/Weapons/Rifles");
    expect(getPrefabSubdirectory("ground_vehicle", "car")).toBe("Prefabs/Vehicles/Cars");
    expect(getPrefabSubdirectory("ground_vehicle", "tracked")).toBe("Prefabs/Vehicles/Tracked");
  });
});

describe("getPrefabFilename", () => {
  it("appends .et extension", () => {
    expect(getPrefabFilename("MyPrefab")).toBe("MyPrefab.et");
  });
});
