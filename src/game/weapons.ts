import { PALETTE } from '../view/neon.ts';

/**
 * Weapons are pure data. Both the swing solver and the renderer read the same
 * table, so adding one is a row here rather than a branch in the sim.
 */

export type WeaponId = 'fist' | 'dagger' | 'spear' | 'hammer' | 'shard' | 'bomb';

export interface ProjectileDef {
  speed: number;
  radius: number;
  /** Seconds before it falls out of the air on its own. */
  life: number;
  /** Radius of the explosion on impact, or 0 for a direct hit only. */
  blast: number;
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  kind: 'melee' | 'throw';
  /** Attacks before it breaks. -1 for bare hands, which never run out. */
  uses: number;
  cooldown: number;
  /** Delay between the input and the hit landing. */
  windup: number;
  /** How long the sweep is drawn. */
  swing: number;
  /** Melee reach from the player's centre. */
  range: number;
  /** Half-width of the swing wedge, radians. */
  arc: number;
  blockDamage: number;
  playerDamage: number;
  knockback: number;
  color: string;
  projectile?: ProjectileDef;
  /** Relative odds of this weapon coming out of a block. */
  dropWeight: number;
  /** How badly the CPU wants this. Compared against what it already holds. */
  aiValue: number;
  /**
   * Distance the CPU tries to hold. Melee weapons fight at the edge of their
   * reach; throwables want space so the shot has time to land.
   */
  aiStandoff: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  // The baseline every other weapon is read against.
  fist: {
    id: 'fist',
    name: 'FISTS',
    kind: 'melee',
    uses: -1,
    cooldown: 0.4,
    windup: 0.07,
    swing: 0.18,
    range: 48,
    arc: 0.92,
    blockDamage: 1,
    playerDamage: 1,
    knockback: 210,
    color: PALETTE.text,
    dropWeight: 0,
    aiValue: 0,
    aiStandoff: 38,
  },

  // Fast and short: wins a corner ambush, loses to anything with reach.
  dagger: {
    id: 'dagger',
    name: 'DAGGER',
    kind: 'melee',
    uses: 24,
    cooldown: 0.17,
    windup: 0.04,
    swing: 0.12,
    range: 42,
    arc: 0.62,
    blockDamage: 1,
    playerDamage: 1,
    knockback: 90,
    color: PALETTE.dagger,
    dropWeight: 30,
    aiValue: 52,
    aiStandoff: 34,
  },

  // Pokes from outside fist range; the narrow arc punishes a miss.
  spear: {
    id: 'spear',
    name: 'SPEAR',
    kind: 'melee',
    uses: 18,
    cooldown: 0.52,
    windup: 0.1,
    swing: 0.2,
    range: 92,
    arc: 0.32,
    blockDamage: 1,
    playerDamage: 2,
    knockback: 270,
    color: PALETTE.spear,
    dropWeight: 24,
    aiValue: 64,
    aiStandoff: 78,
  },

  // Siege tool: one swing clears a block, so it rewrites the cover on a map.
  hammer: {
    id: 'hammer',
    name: 'HAMMER',
    kind: 'melee',
    uses: 10,
    cooldown: 0.78,
    windup: 0.16,
    swing: 0.26,
    range: 58,
    arc: 1.12,
    blockDamage: 3,
    playerDamage: 2,
    knockback: 520,
    color: PALETTE.hammer,
    dropWeight: 14,
    aiValue: 46,
    aiStandoff: 48,
  },

  // The only way to threaten across the arena before the zone closes.
  shard: {
    id: 'shard',
    name: 'SHARD',
    kind: 'throw',
    uses: 8,
    cooldown: 0.3,
    windup: 0.05,
    swing: 0.14,
    range: 0,
    arc: 0,
    blockDamage: 1,
    playerDamage: 1,
    knockback: 150,
    color: PALETTE.shard,
    projectile: { speed: 620, radius: 6, life: 1.1, blast: 0 },
    dropWeight: 22,
    aiValue: 70,
    aiStandoff: 215,
  },

  // Clears cover and punishes anyone hiding behind it.
  bomb: {
    id: 'bomb',
    name: 'BOMB',
    kind: 'throw',
    uses: 3,
    cooldown: 0.95,
    windup: 0.12,
    swing: 0.22,
    range: 0,
    arc: 0,
    blockDamage: 3,
    playerDamage: 2,
    knockback: 430,
    color: PALETTE.bomb,
    projectile: { speed: 380, radius: 9, life: 1.35, blast: 82 },
    dropWeight: 10,
    aiValue: 75,
    aiStandoff: 165,
  },
};

/** Everything a broken block can actually drop, in a fixed order. */
export const DROPPABLE: readonly WeaponId[] = (
  Object.keys(WEAPONS) as WeaponId[]
).filter((id) => WEAPONS[id].dropWeight > 0);

const TOTAL_WEIGHT = DROPPABLE.reduce((sum, id) => sum + WEAPONS[id].dropWeight, 0);

/** Pick a weapon from `roll` in 0..1. Pure, so the sim stays deterministic. */
export function rollWeapon(roll: number): WeaponId {
  let acc = roll * TOTAL_WEIGHT;
  for (const id of DROPPABLE) {
    acc -= WEAPONS[id].dropWeight;
    if (acc <= 0) return id;
  }
  return DROPPABLE[DROPPABLE.length - 1]!;
}
