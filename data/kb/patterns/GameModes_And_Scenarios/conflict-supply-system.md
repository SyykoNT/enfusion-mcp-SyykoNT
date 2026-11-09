# Conflict Supply System

The supply system is the economic backbone of all Conflict scenarios. Supplies fund building, spawning, and base establishment. Understanding the flow is essential for designing balanced scenarios.

---

## Architecture

The modern supply system uses `SCR_ResourceComponent` internally. The older `SCR_CampaignSuppliesComponent` still exists on vehicles and depots but is marked `[Obsolete]` — do not use it for new logic. Query supply values through `SCR_CampaignMilitaryBaseComponent` and the gamemode getters.

---

## Supply Income Flow

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

HQ (m_bIsHQ)
    → income: m_iRegularSuppliesIncome (40); the base's own m_iRegularSuppliesIncomeBase, if not -1, replaces it only while auto regeneration is off
    → tick: the game mode's m_iSuppliesArrivalInterval (5s) while auto regeneration is on, unless the HQ is also a supply hub; otherwise the base's own m_iSuppliesArrivalInterval if not -1, else m_iSuppliesArrivalIntervalSource (300s)
    → vanilla ConflictBase_MOB.et sets m_iRegularSuppliesIncomeBase 250 and m_iSuppliesArrivalInterval 300, so a vanilla MOB that is the HQ gets 250 every 300s while auto regeneration is off
    → no radio extra (the game skips it for HQs); no replenish ceiling, only its storage max

Supply hub (m_bIsSupplyHub, not an HQ)
    → income: same rule as an HQ (m_iRegularSuppliesIncome, or its own m_iRegularSuppliesIncomeBase if not -1 while auto regeneration is off)
    → tick: the base's own m_iSuppliesArrivalInterval if set, else 300s; never the game mode's 5s
    → radio extra like any non-HQ base, only while m_bSuppliesAutoRegenerationEnabled is on

Regular base (BASE type, not an HQ or supply hub): income only while m_bSuppliesAutoRegenerationEnabled is on, else 0
    → every 5s (game mode m_iSuppliesArrivalInterval): +4 supplies (game mode m_iRegularSuppliesIncomeBase; the per-base value is not read)
    → radio extra: +4/tick (m_iRegularSuppliesIncomeExtra) for each friendly BASE-type base in this base's radio range that receives HQ radio traffic, up to 5

Quick replenish (below m_iQuickSuppliesReplenishThreshold, 200; every base type)
    → the income (not the radio extra) × m_fQuickSuppliesReplenishMultiplier (2.0), capped at what brings the base to 200, never below the normal income

Replenish ceiling: m_iSuppliesReplenishThreshold (1000)
    → every base except an HQ stops taking income at this level; every base also stops at its storage max
```

---

## Gamemode Supply Attributes (`SCR_GameModeCampaign`)

### Income
| Attribute | Default | Description |
|---|---|---|
| `m_iRegularSuppliesIncome` | `40` | Supplies replenished periodically in HQs and supply hubs |
| `m_iRegularSuppliesIncomeBase` | `4` | Income per tick for a regular base (not an HQ, supply hub or source base), only while `m_bSuppliesAutoRegenerationEnabled` is on (default off); otherwise a regular base gets 0. Supply hubs take `m_iRegularSuppliesIncome`; source bases take their own value, else `m_iRegularSuppliesIncomeSource` |
| `m_iRegularSuppliesIncomeExtra` | `4` | Bonus per tick for each friendly `BASE`-type base in radio range that receives HQ radio traffic (up to 5; relays and source bases are not counted); every non-HQ base gets it (supply hubs and source bases included), only while `m_bSuppliesAutoRegenerationEnabled` is on |
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

**Note:** Production mods typically set `m_iSupplies 500` on MOB entities (not 3000). The `3000` max cap is just the ceiling, not the starting amount.

### Map Display
| Attribute | Default | Description |
|---|---|---|
| `m_iSupplyDepotIconThreshold` | `1200` | Distance to show standalone depots on map |

---

## Per-Base Supply Overrides (`SCR_CampaignMilitaryBaseComponent`)

These override the gamemode defaults for individual bases:

| Property | Default | Description |
|---|---|---|
| `m_iRegularSuppliesIncomeBase` | `-1` | Per-base income. Read for an HQ or supply hub only while auto regeneration is off (-1 = use `m_iRegularSuppliesIncome`), and always for a source base (-1 = use `m_iRegularSuppliesIncomeSource`); never read for a regular base |
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
| Private | 65 |
| Corporal | 100 |
| Sergeant | 135 |
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
base.GetOnSuppliesArrivalInvoker(); // ScriptInvokerVoid, fires at the end of AddSupplies (income ticks and other supply changes)
base.GetOnSupplyLimitChanged();
base.GetOnReservedSupplyAmountChanged();
```

### Querying gamemode supply settings
```c
SCR_GameModeCampaign gm = SCR_GameModeCampaign.Cast(GetGame().GetGameMode());
int hqIncome  = gm.GetRegularSuppliesIncome();        // 40 default
int baseIncome = gm.GetRegularSuppliesIncomeBase();    // 4 default
int radioExtra = gm.GetRegularSuppliesIncomeExtra();   // 4 per friendly BASE-type base in range, non-HQ bases, auto regeneration only
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

| Base type | Starting supplies | Max cap | Income/tick | Notes |
|---|---|---|---|---|
| MOB / HQ | 600 (gamemode default) | 3000 | 40 with auto regeneration on; with it off, 250 per 300s from the vanilla MOB prefab | Set `m_iSupplies 500` in layer for balance |
| Regular base | 100–500 (randomized) | ~1000 | 0 (4 only while auto regeneration is on) | |
| Major base | 100–500 | ~1000 | 40 as a supply hub, else as a regular base | |
| Harbor (T3) | n/a | n/a | 1000 per 600s (vanilla T3 prefab; game mode fallback 2500 per 300s) | Source base: income goes into the harbor itself, up to the 1000 ceiling |
| Control point | 100–500 | ~1000 | 0 (4 only while auto regeneration is on) | Lightweight, no supply hub |

**Balance tips from production mods:**
- MOBs at 500 starting (not 3000) — forces players to manage supply chains from day 1
- Quick replenish (below 200 supplies) multiplies a base's income, but only for a base that passes the check before each tick
- Radio coverage over friendly bases adds +4/tick per friendly BASE-type base in range that receives HQ radio traffic (up to 5; relays and source bases are not counted) to non-HQ bases, only with auto regeneration on
- Source bases make harbors strategically important — place them at map extremes
