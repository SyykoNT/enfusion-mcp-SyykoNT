# Conflict Supply System

The supply system is the economic backbone of all Conflict scenarios. Supplies fund building, spawning, and base establishment. Understanding the flow is essential for designing balanced scenarios.

---

## Architecture

The modern supply system uses `SCR_ResourceComponent` internally. The older `SCR_CampaignSuppliesComponent` still exists on vehicles and depots but is marked `[Obsolete]` — do not use it for new logic. Query supply values through `SCR_CampaignMilitaryBaseComponent` and the gamemode getters.

---

## Supply Income Flow

Numbers in this flow are script defaults; the vanilla game mode prefabs override several (see Gamemode Supply Attributes below).

```
Every base: the check before each tick
    → no income unless the base has an owner and a spawn point, is not being captured by another faction, its respawn delay after capture has passed, and (except a source base) it has two-way HQ radio coverage; INDFOR-owned bases always pass the coverage check
    → HQ radio coverage passes from radio to radio, only through radios that are powered and on the HQ radio's encryption key, so a relay chain can turn a cut-off base's income on
    → the income loop runs only for BASE and SOURCE_BASE types and never in the tutorial, so a relay (RELAY) gets no income itself

Source base (SCR_CampaignSourceBaseComponent, m_eType SOURCE_BASE: harbors, airfields)
    → income: its own m_iRegularSuppliesIncomeBase if set (not -1), else m_iRegularSuppliesIncomeSource (2500)
    → tick: its own m_iSuppliesArrivalInterval if set (not -1), else m_iSuppliesArrivalIntervalSource (300s); auto regeneration changes neither income nor tick
    → vanilla prefabs set both: T1 harbor 3000 per 900s, T2 harbor 2000 per 900s, T3 harbor 1000 per 600s, airfield 2000 per 600s
    → the supplies go into the source base itself, up to the replenish ceiling below
    → radio extra like any non-HQ base, only while m_bSuppliesAutoRegenerationEnabled is on
    → these income and tick rules hold even when the source base is also a supply hub or an HQ (its two getters read neither flag); the HQ flag still removes the radio extra and the replenish ceiling

HQ (m_bIsHQ, not a source base)
    → income: m_iRegularSuppliesIncome (script default 40, 10 in GameMode_Campaign.et); the base's own m_iRegularSuppliesIncomeBase, if not -1, replaces it only while auto regeneration is off
    → tick: the game mode's m_iSuppliesArrivalInterval (5s) while auto regeneration is on, unless the HQ is also a supply hub; otherwise the base's own m_iSuppliesArrivalInterval if not -1, else m_iSuppliesArrivalIntervalSource (300s)
    → vanilla ConflictBase_MOB.et sets m_iRegularSuppliesIncomeBase 250 and m_iSuppliesArrivalInterval 300, so a vanilla MOB that is the HQ gets 250 every 300s while auto regeneration is off
    → no radio extra (the game skips it for HQs); no replenish ceiling, only its storage max

Supply hub (m_bIsSupplyHub, not an HQ or source base)
    → income: same rule as an HQ (m_iRegularSuppliesIncome, or its own m_iRegularSuppliesIncomeBase if not -1 while auto regeneration is off)
    → tick: the base's own m_iSuppliesArrivalInterval if set, else 300s; never the game mode's 5s
    → radio extra like any non-HQ base, only while m_bSuppliesAutoRegenerationEnabled is on

Regular base (BASE type, not an HQ or supply hub): income only while m_bSuppliesAutoRegenerationEnabled is on, else 0
    → every 5s (game mode m_iSuppliesArrivalInterval): +4 supplies (game mode m_iRegularSuppliesIncomeBase, script default 4, 0 in GameMode_Campaign.et; the per-base value is not read)
    → radio extra: +4/tick (m_iRegularSuppliesIncomeExtra, script default 4, 1 in GameMode_Campaign.et) for each friendly BASE-type base in this base's radio range that receives HQ radio traffic, up to 5

Quick replenish (below m_iQuickSuppliesReplenishThreshold, 200; every base type)
    → the income (not the radio extra) × m_fQuickSuppliesReplenishMultiplier (2.0), capped at what brings the base to 200, never below the normal income

Replenish ceiling: m_iSuppliesReplenishThreshold (1000)
    → every base except an HQ stops taking income at this level; every base also stops at its storage max
```

---

## Gamemode Supply Attributes (`SCR_GameModeCampaign`)

Every default in this file is the script attribute default (`SCR_GameModeCampaign.c:17-117`). The vanilla game mode prefabs override several: `GameMode_Campaign.et:356-366` sets `m_iSuppliesReplenishThreshold` 6000, `m_iQuickSuppliesReplenishThreshold` 100, `m_iRegularSuppliesIncome` 10, `m_iRegularSuppliesIncomeBase` 0, `m_iRegularSuppliesIncomeExtra` 1, `m_iHQStartingSupplies` 1000, `m_iMinStartingSupplies` 75, `m_iMaxStartingSupplies` 250, `m_bSuppliesAutoRegenerationEnabled` 1 and `m_iSuppliesArrivalIntervalSource` 5; `GameMode_CampaignHQC.et:110-111` sets auto regeneration 0 and the source interval 300. When the mission has an `SCR_MissionHeaderCampaign`, its own `m_bSuppliesAutoRegenerationEnabled` (default 1) replaces the game mode value at start (`SCR_GameModeCampaign.c:1920`); the vanilla HQC mission headers set 0. A world can override these again on its game mode entity, except auto regeneration when the mission has a campaign header: the game mode constructor applies the header after the entity values (`SCR_BaseGameMode.c:2335-2337` calls `ParseHeaderFile`), so the header value wins.

### Income
| Attribute | Default | Description |
|---|---|---|
| `m_iRegularSuppliesIncome` | `40` | Supplies replenished periodically in HQs and supply hubs (not source bases, which use their own getters) |
| `m_iRegularSuppliesIncomeBase` | `4` | Income per tick for a regular base (not an HQ, supply hub or source base), only while `m_bSuppliesAutoRegenerationEnabled` is on (script default off); otherwise a regular base gets 0. Supply hubs that are not source bases take `m_iRegularSuppliesIncome`; source bases take their own value, else `m_iRegularSuppliesIncomeSource` |
| `m_iRegularSuppliesIncomeExtra` | `4` | Bonus per tick for each friendly `BASE`-type base in this base's radio range that receives HQ radio traffic (up to 5; relays and source bases are not counted). Added to every non-HQ base that has an income loop (regular bases, supply hubs and source bases; a relay has none), only while `m_bSuppliesAutoRegenerationEnabled` is on |
| `m_iRegularSuppliesIncomeSource` | `2500` | Source base income per tick when the base's own `m_iRegularSuppliesIncomeBase` is -1 (vanilla source prefabs set their own) |
| `m_iSuppliesArrivalInterval` | `5` | Seconds between income ticks for a base that is neither a supply hub nor a source base, only while `m_bSuppliesAutoRegenerationEnabled` is on; otherwise a base uses its own `m_iSuppliesArrivalInterval`, else `m_iSuppliesArrivalIntervalSource` |
| `m_iSuppliesArrivalIntervalSource` | `300` | Fallback seconds between income ticks when a base's own `m_iSuppliesArrivalInterval` is -1: always for a source base or supply hub, and for any other base while auto regeneration is off |

### Thresholds
| Attribute | Default | Description |
|---|---|---|
| `m_iSuppliesReplenishThreshold` | `1000` | Replenish ceiling: income stops at this level for every base except an HQ |
| `m_iQuickSuppliesReplenishThreshold` | `200` | Below this, every base gets its income (not the radio extra) multiplied, capped at this level, never below the normal income |
| `m_fQuickSuppliesReplenishMultiplier` | `2.0` | Multiplier when below quick threshold |

### Starting Supplies
| Attribute | Default | Description |
|---|---|---|
| `m_iHQStartingSupplies` | `600` | Initial supplies for HQ/MOB bases |
| `m_iMinStartingSupplies` | `100` | Randomized start min for regular bases |
| `m_iMaxStartingSupplies` | `500` | Randomized start max for regular bases |
| `m_iStartingSuppliesInterval` | `25` | Randomization step size |
| `m_bRandomizeSupplies` | `true` | Toggle randomized starting supplies |

**Note:** `m_iSupplies` and `m_iSuppliesMax` on the obsolete `SCR_CampaignSuppliesComponent` (vanilla `ConflictBase_MOB.et:7-9` sets 3000 and 3000; production mods often set `m_iSupplies 500`) are not read for a base's supplies, start or max in 1.9.0.37: only the component's own obsolete methods read them. An HQ starts with `m_iHQStartingSupplies`, or the mission header's `m_iStartingHQSupplies` when that is not -1, applied when its main building composition spawns unless more supplies are already in range (`SCR_GameModeCampaign.c:622-630`, `:700`; `SCR_CampaignMilitaryBaseComponent.c:2161-2179`). A base's max is the storage in its resource range (see the guidelines table).

### Map Display
| Attribute | Default | Description |
|---|---|---|
| `m_iSupplyDepotIconThreshold` | `1200` | Distance to show standalone depots on map |

---

## Per-Base Supply Overrides (`SCR_CampaignMilitaryBaseComponent`)

These override the gamemode defaults for individual bases:

| Property | Default | Description |
|---|---|---|
| `m_iRegularSuppliesIncomeBase` | `-1` | Per-base income. Read for an HQ or supply hub only while auto regeneration is off (-1 = use `m_iRegularSuppliesIncome`), and always for a source base, also one that is a hub or HQ (-1 = use `m_iRegularSuppliesIncomeSource`); never read for a regular base |
| `m_iSuppliesArrivalInterval` | `-1` | Per-base tick interval. Read always for a supply hub or source base, and for any other base while auto regeneration is off (-1 = use `m_iSuppliesArrivalIntervalSource`, 300s) |
| `m_fSupplyLimit` | `0.2` | Resupply threshold as fraction of max capacity (0–0.9) |
| `m_fReservedSupplyAmount` | `0.5` | Fraction kept in reserve for storage (0.1–0.9) |
| `m_eSupplyRequestExecutionPriority` | `MEDIUM` | Priority when multiple resupply tasks compete |

---

## Rank-Based Supply Allocation

Players receive a personal supply budget based on rank (from `CampaignMilitarySupplyAllocationConfig.conf`). Replenishment interval: 300s.

| Rank | Allocation |
|---|---|
| Renegade | 0 |
| Private | 85 |
| Corporal | 115 |
| Sergeant | 150 |
| Lieutenant | 185 |
| Captain | 235 |
| Major | 300 |

Mod override (SeizeAMPSecure values):

| Rank | Allocation |
|---|---|
| Private | 50 |
| Corporal | 75 |
| Sergeant | 100 |
| Lieutenant | 150 |
| Captain | 250 |
| Major | 400 |

---

## Supply Vehicle System (`SCR_CampaignSuppliesComponent`)

Supply trucks and helicopters carry supplies between depots and bases.

Key properties (on vehicle entity):
- `m_iSupplies` (RplProp) — current supply amount on vehicle
- `m_iSuppliesMax` (RplProp) — vehicle capacity
- `m_fOperationalRadius` — load/unload radius (default 25m)
- `m_bIsStandaloneDepot` — marks standalone supply depot

Key methods:
```c
GetSupplies() → int
GetSuppliesMax() → int
AddSupplies(int supplies, bool replicate)
SetLastLoadedAt(SCR_CampaignMilitaryBaseComponent base)
SetLastUnloadedAt(SCR_CampaignMilitaryBaseComponent base)
AwardXP() → bool  // should XP be awarded for this unload?
static GetSuppliesComponent(IEntity ent) → searches entity + all slots
```

`SUPPLY_TRUCK_UNLOAD_RADIUS = 25m` — max distance from depot to load/unload.

XP: `m_fSupplyOffloadAssistanceReward 0.5` — XP multiplier for unloading supplies you didn't load yourself.

---

## Supply Sources (Harbors & Airfields)

Source bases use `SCR_CampaignSourceBaseComponent`, a subclass of `SCR_CampaignMilitaryBaseComponent` with its own income and tick rules (see the flow above), and `m_eType SOURCE_BASE`. Each tick adds the supplies to the source base itself, up to the replenish ceiling.

```
$grp GenericEntity : "{0226331FB6A8249A}Prefabs/Systems/MilitaryBase/ConflictSourceBase_T3Harbor.et" {
 HarborNorth {
  coords 5803 2 3533
 }
}
```

Prefab tiers:
- `{8BEE4B0606893CDF}` `ConflictSourceBase_T1Harbor.et` — small
- `{0226331FB6A8249A}` `ConflictSourceBase_T3Harbor.et` — large
- `{1739B43A3702BB84}` `ConflictSourceBase_Airfield.et` — airfield

---

## Supply Script API

### Querying base supplies
```c
SCR_CampaignMilitaryBaseComponent base = ...;

// Get current supply scarcity (positive = needs resupply)
float scarcity = base.GetScarcityLevel();

// Is resupply needed?
bool needed = base.IsResupplyNeeded();

// Events
base.GetOnSuppliesArrivalInvoker(); // ScriptInvokerVoid, fires at the end of AddSupplies (income ticks and other AddSupplies calls), only when the amount is not 0 and the base's resource component has the supplies generator (to add) or consumer (to remove); an income tick that adds nothing (0 income or the base at its ceiling) and supply changes made outside AddSupplies do not fire it
base.GetOnSupplyLimitChanged();
base.GetOnReservedSupplyAmountChanged();
```

### Querying gamemode supply settings
```c
SCR_GameModeCampaign gm = SCR_GameModeCampaign.Cast(GetGame().GetGameMode());
int hqIncome  = gm.GetRegularSuppliesIncome();        // script default 40, 10 in GameMode_Campaign.et
int baseIncome = gm.GetRegularSuppliesIncomeBase();    // script default 4, 0 in GameMode_Campaign.et
int radioExtra = gm.GetRegularSuppliesIncomeExtra();   // script default 4, 1 in GameMode_Campaign.et, per friendly BASE-type base in range that receives HQ radio traffic, up to 5; non-HQ bases with an income loop (not relays), auto regeneration only
int sourceIncome = gm.GetRegularSuppliesIncomeSource(); // 2500 default
int replenishCap = gm.GetSuppliesReplenishThreshold();  // 1000 default
```

---

## Supply Distribution Override (ConflictEscalation pattern)

Even distribution of harbor supplies across owned bases:

```c
modded class SCR_GameModeCampaign
{
    [Attribute("0", UIWidgets.CheckBox, "Distribute harbor supplies evenly")]
    protected bool m_bSupplyHarborDistributionEnabled;

    [Attribute("50", UIWidgets.EditBox, "Supplies per harbor distribution tick")]
    protected int m_iSupplyHarborDistributionAmount;

    bool GetSupplyHarborDistributionEnabled() { return m_bSupplyHarborDistributionEnabled; }
    int GetSupplyHarborDistributionAmount() { return m_iSupplyHarborDistributionAmount; }
}
```

---

## Scenario Design Guidelines

Numbers are script defaults unless a prefab is named; `GameMode_Campaign.et:358-365` sets HQ income 10, regular base income 0, radio extra 1, HQ start 1000, other bases' start 75 to 250 and auto regeneration on.

| Base type | Starting supplies | Max cap | Income/tick | Notes |
|---|---|---|---|---|
| MOB / HQ | 600 (gamemode default) | storage in range (unverified) | `m_iRegularSuppliesIncome` (40, 10 in `GameMode_Campaign.et`) with auto regeneration on; with it off, 250 per 300s from the vanilla MOB prefab | Set the start with `m_iHQStartingSupplies` or the header's `m_iStartingHQSupplies` (`m_iSupplies` is not read) |
| Regular base | 100–500 (randomized) | storage in range (unverified) | `GameMode_Campaign.et`: 0 plus the radio extra (auto regeneration on). Script defaults: 0 (auto regeneration off; 4 when on) | |
| Major base | 100–500 | storage in range (unverified) | HQ income (`m_iRegularSuppliesIncome`) as a supply hub, else as a regular base | |
| Harbor (T3) | n/a | storage in range (unverified) | 1000 per 600s (vanilla T3 prefab; game mode fallback 2500 per 300s) | Source base: income goes into the harbor itself, up to the 1000 ceiling |
| Control point | 100–500 | storage in range (unverified) | as a regular base | Lightweight, no supply hub |

Max cap: `GetSuppliesMax()` returns the summed max of the stored supply containers that the base's `SCR_ResourceConsumer` reaches (`SCR_CampaignMilitaryBaseComponent.c:2029-2045`; `m_fResourceRange` 150 in `ConflictBase_Base.et:60`, 100 in `ConflictMilitaryBase.et:61`). The base prefabs hold no supply container of their own, so the cap depends on what is built or placed in range; this KB has no verified number per base type. The obsolete `m_iSuppliesMax` (500 in `ConflictBase_Base.et:24`, 3000 in `ConflictBase_MOB.et:9`, 5000 in `ConflictSourceBase.et:6`) is not read.

**Balance tips from production mods:**
- Start MOBs low (production mods use 500) through `m_iHQStartingSupplies` or the header's `m_iStartingHQSupplies`, not `m_iSupplies`, to force players to manage supply chains from day 1
- Quick replenish (below 200 supplies) multiplies a base's income, but only for a base that passes the check before each tick
- Radio coverage over friendly bases adds +4/tick by script default (1 in `GameMode_Campaign.et`) per friendly BASE-type base in range that receives HQ radio traffic (up to 5; relays and source bases are not counted) to non-HQ bases with an income loop (not relays), only with auto regeneration on
- Source bases make harbors strategically important — place them at map extremes
