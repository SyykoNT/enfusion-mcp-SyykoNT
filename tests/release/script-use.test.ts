import { describe, it, expect } from "vitest";
import { declaredNames, usedNames } from "../../src/release/script-use.js";

const dep = `
modded class SCR_CharacterDamageManagerComponent : SCR_DamageManagerComponent
{
	[Attribute(defvalue: "1")]
	protected int m_iCount;

	//! Not a method: Commented(x)
	bool ACE_Medical_ShouldDeactivateSecondChance()
	{
		if (m_iCount > 0)
			return Helper(m_iCount);
		string s = "{ not a brace";
		return false;
	}

	override void OnInit(IEntity owner)
	{
		super.OnInit(owner);
	}
}

class ACE_Medical_PainHitZone : SCR_RegeneratingHitZone
{
	static array<ref ACE_Thing> GetThings(int n) { return null; }
}

enum ACE_EState
{
	A,
	B
}
`;

describe("declaredNames", () => {
  it("collects classes, enums and methods in class bodies, but not modded classes, calls or comments", () => {
    expect([...declaredNames([dep])].sort()).toEqual([
      "ACE_EState", "ACE_Medical_PainHitZone", "ACE_Medical_ShouldDeactivateSecondChance", "GetThings", "OnInit",
    ]);
  });
});

describe("usedNames", () => {
  it("matches whole words only and drops names the base game also declares", () => {
    const target = [
      "modded class ACE_Medical_PainHitZone : SCR_RegeneratingHitZone {}\n",
      "void F() { if (dm.ACE_Medical_ShouldDeactivateSecondChance()) OnInit(null); GetThingsCount(); }\n",
      "// ACE_EState only in a comment\n",
    ];
    expect(usedNames(target, declaredNames([dep]), new Set(["OnInit"]))).toEqual([
      "ACE_Medical_PainHitZone", "ACE_Medical_ShouldDeactivateSecondChance",
    ]);
  });
});
