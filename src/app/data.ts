/**
 * data.ts — Lazy shard loader for static recipe data.
 *
 * Shards live at /data/r_{modName}.json (e.g. /data/r_minecraft.json).
 * Each shard is fetched at most once and cached in memory for the session.
 *
 * Minified recipe keys:
 *   id  → recipe id (number)
 *   c   → category string
 *   cn  → category_name string
 *   ip  → image_path string
 *   o   → outputs  [{ id, name?, qty }]
 *   in  → inputs   [{ id, name?, qty }]
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MiniRecipe {
  id: number;
  c: string;   // category
  cn: string;  // category_name
  ip: string;  // image_path
  o: OutputSlot[];
  in: InputSlot[];
}

export interface OutputSlot {
  id: string;
  name?: string;
  qty: number;
}

export interface InputSlot {
  id: string;
  name?: string;
  qty: number;
}

/** Expanded recipe — matches the shape your tree.ts functions expect */
export interface Recipe {
  id: number;
  category: string;
  category_name: string;
  image_path: string;
  outputs: OutputSlot[];
  inputs: InputSlot[];
}

export type RecipeMap = Record<string, Recipe[]>;

export interface EmcEntry {
  name: string;
  emc: number;
}

export type EmcMap = Record<string, EmcEntry>;

export interface Manifest {
  totalItems: number;
  shards: string[];
  emcCount: number;
  nameToId: Record<string, string>;
}

// ── Internal state ────────────────────────────────────────────────────────────

/** Base URL where your /data/ folder is served from*/
const DATA_BASE = "/data";

let manifest: Manifest | null = null;
let emcMap: EmcMap | null = null;

// Shard cache: modName → expanded recipes for all items in that shard
const shardCache = new Map<string, RecipeMap>();
// In-flight fetch deduplication
const inFlight = new Map<string, Promise<RecipeMap>>();

// ── Manifest ──────────────────────────────────────────────────────────────────

export async function getManifest(): Promise<Manifest> {
  if (manifest) return manifest;
  const res = await fetch(`${DATA_BASE}/manifest.json`);
  if (!res.ok) throw new Error(`Failed to load manifest: ${res.status}`);
  manifest = (await res.json()) as Manifest;
  return manifest;
}

// ── EMC ───────────────────────────────────────────────────────────────────────

export async function getEmcMap(): Promise<EmcMap> {
  if (emcMap) return emcMap;
  const res = await fetch(`${DATA_BASE}/emc.json`);
  if (!res.ok) throw new Error(`Failed to load emc.json: ${res.status}`);
  emcMap = (await res.json()) as EmcMap;
  return emcMap;
}

// ── Shard loading ─────────────────────────────────────────────────────────────

function shardKeyForId(itemId: string): string {
  // "item:minecraft:stone:0" → "minecraft"
  // "fluid:water"            → "fluid"
  const parts = itemId.split(":");
  return parts.length >= 2 ? parts[1] : (itemId[0] ?? "misc");
}

function expandMini(mini: MiniRecipe[]): Recipe[] {
  return mini.map((m) => ({
    id: m.id,
    category: m.c,
    category_name: m.cn,
    image_path: m.ip,
    outputs: m.o,
    inputs: m.in,
  }));
}

async function loadShard(modName: string): Promise<RecipeMap> {
  // Deduplicate concurrent requests for the same shard
  const existing = inFlight.get(modName);
  if (existing) return existing;

  const promise = (async (): Promise<RecipeMap> => {
    const res = await fetch(`${DATA_BASE}/r_${modName}.json`);
    if (!res.ok) throw new Error(`Shard r_${modName}.json not found (${res.status})`);
    const raw = (await res.json()) as Record<string, MiniRecipe[]>;

    const expanded: RecipeMap = {};
    for (const [itemId, miniList] of Object.entries(raw)) {
      expanded[itemId] = expandMini(miniList);
    }

    shardCache.set(modName, expanded);
    inFlight.delete(modName);
    return expanded;
  })();

  inFlight.set(modName, promise);
  return promise;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get all recipes for a single item, lazy-loading its shard if needed.
 * Returns [] if no recipes exist for the item.
 */
export async function getRecipes(itemId: string): Promise<Recipe[]> {
  const mod = shardKeyForId(itemId);

  let shard = shardCache.get(mod);
  if (!shard) {
    // Check manifest to avoid 404s for unknown mods
    const mf = await getManifest();
    if (!mf.shards.includes(mod)) return [];
    shard = await loadShard(mod);
  }

  return shard[itemId] ?? [];
}

/**
 * Pre-warm multiple shards in parallel.
 * Call this after resolving the root item to pre-load likely dependencies.
 */
export async function preWarmShards(itemIds: string[]): Promise<void> {
  const mods = [...new Set(itemIds.map(shardKeyForId))];
  const mf = await getManifest();
  const toLoad = mods.filter((m) => mf.shards.includes(m) && !shardCache.has(m));
  await Promise.all(toLoad.map(loadShard));
}

/**
 * Resolve a user query (name or item_id) → display name.
 * e.g. "melter" → "item:nuclearcraft:melter_idle"
 */
export async function resolveItemId(query: string): Promise<string> {
  const mf = await getManifest();
  return mf.nameToId[query.toLowerCase()] ?? query;
}

/**
 * Build a RecipeMap snapshot of all currently-loaded shards.
 * The tree functions need synchronous access once shards are loaded.
 */
export function getLoadedRecipes(): RecipeMap {
  const merged: RecipeMap = {};
  for (const shard of shardCache.values()) {
    Object.assign(merged, shard);
  }
  return merged;
}

// ── Passived list ─────────────────────────────────────────────────────────────

const PASSIVED_CONFIG_URL = `${DATA_BASE}/passived.json`;

/**
 * Load the passived items list.
 *
 * Strategy:
 *   1. If the user has a saved list in localStorage, return that.
 *   2. Otherwise, load the default list from the config JSON file.
 *   3. If neither exists, return an empty list.
 *
 * The config file acts as the initial default. Once the user modifies the
 * list via the UI, their changes are persisted to localStorage and take
 * precedence over the config.
 */
export async function getPassivedList(): Promise<Set<string>> {
  // Check localStorage first — user has customized the list
  try {
    const raw = localStorage.getItem("jei-calc:passived");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed);
      }
    }
  } catch {
    // ignore malformed localStorage data
  }

  // Fall back to config defaults
  try {
    const res = await fetch(PASSIVED_CONFIG_URL);
    if (res.ok) {
      const configItems = (await res.json()) as string[];
      return new Set(configItems);
    }
  } catch {
    // config not available — return empty set
  }

  return new Set();
}

/**
 * Save the full passived list to localStorage.
 * Called when the user adds or removes items via the UI.
 */
export function savePassivedList(items: string[]): void {
  try {
    localStorage.setItem("jei-calc:passived", JSON.stringify(items));
  } catch {
    // ignore
  }
}

/** Load the user's passived list from localStorage (no fallback). */
export function loadPassivedList(): string[] {
  try {
    const raw = localStorage.getItem("jei-calc:passived");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    // ignore
  }
  return [];
}
