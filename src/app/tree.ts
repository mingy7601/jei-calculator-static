/**
 * tree.ts — TypeScript port of tree.py
 *
 * All functions are synchronous and take a pre-loaded RecipeMap.
 * Load shards via data.ts before calling buildTree.
 */

import type { Recipe, RecipeMap, EmcMap } from "./data";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TreeNode {
  item: string;
  name: string;
  qty?: number;
  source?: "base" | "cycle" | "limit" | "emc" | "passived" | "unknown";
  step?: number;
  category?: string;
  category_name?: string;
  image_path?: string;
  inputs?: TreeNode[];
  outputs?: { id: string; name?: string; qty: number }[];
}

// ── Machine priority ──────────────────────────────────────────────────────────

const MACHINE_PRIORITY = [
  "nuclearcraft_manufactory",
  "thermalexpansion.furnace",
  "minecraft.crafting",
];

function machinePriority(recipe: Recipe): number {
  const idx = MACHINE_PRIORITY.indexOf(recipe.category);
  return idx === -1 ? MACHINE_PRIORITY.length : idx;
}

function outputQty(recipe: Recipe, itemId: string): number {
  for (const o of recipe.outputs) {
    if (o.id === itemId) return o.qty ?? 1;
  }
  return 0;
}

// ── Cycle detection ───────────────────────────────────────────────────────────

/** Memoized wouldCycle cache: "inputId:targetId" → boolean */
let cycleCache = new Map<string, boolean>();

function cycleCacheKey(inputId: string, targetId: string): string {
  return inputId + "\0" + targetId;
}

/**
 * Returns true if there is NO viable (non-cyclic) recipe for inputId
 * that doesn't eventually require targetId.
 * Mirrors the Python would_cycle logic exactly.
 */
export function wouldCycle(
  inputId: string,
  targetId: string,
  recipes: RecipeMap,
  depth = 0,
  maxDepth = 2
): boolean {
  if (inputId === targetId) return true;
  if (depth >= maxDepth) return false;

  const cacheKey = cycleCacheKey(inputId, targetId);
  const cached = cycleCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const options = recipes[inputId];
  if (!options?.length) {
    cycleCache.set(cacheKey, false);
    return false;
  }

  const viable = options.filter(
    (r) =>
      !r.inputs.some((inp) =>
        wouldCycle(inp.id, targetId, recipes, depth + 1, maxDepth)
      )
  );

  const result = viable.length === 0;
  cycleCache.set(cacheKey, result);
  return result;
}

/** Clear the cycle detection cache (call between different tree builds) */
export function clearCycleCache(): void {
  cycleCache.clear();
}

// ── Build tree ────────────────────────────────────────────────────────────────

export function buildTree(
  item: string,
  recipes: RecipeMap,
  step = 0,
  maxSteps = 5,
  opts: {
    name?: string;
    visited?: ReadonlySet<string>;
    overrides?: Record<string, number>;
    emcValues?: EmcMap;
    /** Items treated as leaf nodes — no further expansion */
    passived?: ReadonlySet<string>;
    /** Memoization cache to prevent exponential blowup on DAGs */
    memo?: Map<string, TreeNode>;
  } = {}
): TreeNode {
  // Clear cycle cache for each new tree build
  clearCycleCache();

  const {
    name,
    visited = new Set<string>(),
    overrides = {},
    emcValues = {},
    passived = new Set<string>(),
    memo = new Map<string, TreeNode>(),
  } = opts;

  if (visited.has(item)) {
    return { item, name: name ?? item, source: "cycle" };
  }
  if (step >= maxSteps) {
    return { item, name: name ?? item, source: "limit" };
  }

  // ── DAG memoization by (item, step) to prevent exponential blowup ──
  // For a given item at a given step, the result is deterministic regardless
  // of visited set (visited only affects cycle detection limited to depth 2).
  const memoKey = `${item}\0${step}`;
  const cached = memo.get(memoKey);
  if (cached) return cached;

  // ── Passived check ──
  // If the item is in the passived set, treat it as a leaf node
  // regardless of whether recipes exist for it.
  if (passived.has(item)) {
    const result = { item, name: name ?? item, source: "passived" };
    memo.set(memoKey, result);
    return result;
  }

  const options = recipes[item];
  if (!options?.length) {
    const result = { item, name: name ?? item, source: "base" };
    memo.set(memoKey, result);
    return result;
  }

  const childVisited = new Set(visited).add(item);

  // Filter to non-cyclic recipes only
  let viable = options.filter(
    (r) => !r.inputs.some((inp) => wouldCycle(inp.id, item, recipes))
  );

  if (!viable.length) {
    const result = { item, name: name ?? item, source: "cycle" };
    memo.set(memoKey, result);
    return result;
  }

  // Sort: highest output qty first, then machine priority
  viable = [...viable].sort((a, b) => {
    const qtyDiff = outputQty(b, item) - outputQty(a, item);
    if (qtyDiff !== 0) return qtyDiff;
    return machinePriority(a) - machinePriority(b);
  });

  // Apply override
  const overrideId = overrides[item];
  if (overrideId != null) {
    const preferred = viable.find((r) => r.id === overrideId);
    if (preferred) {
      viable = [preferred, ...viable.filter((r) => r.id !== overrideId)];
    }
  }

  const recipe = viable[0];

  const result = {
    item,
    name: name ?? item,
    step,
    category: recipe.category,
    category_name: recipe.category_name,
    image_path: recipe.image_path,
    outputs: recipe.outputs,
    inputs: recipe.inputs.map((inp) => {
      const hasEmc = !!emcValues[inp.id];
      const child: TreeNode = hasEmc
        ? { item: inp.id, name: inp.name ?? inp.id, source: "emc" }
        : buildTree(inp.id, recipes, step + 1, maxSteps, {
            name: inp.name,
            visited: childVisited,
            overrides,
            emcValues,
            passived,
            memo,
          });
      return { ...child, qty: inp.qty ?? 1 };
    }),
  };

  // Cache the final result
  memo.set(memoKey, result);
  return result;
}

// ── Collect all item ids referenced in a tree ─────────────────────────────────
export function collectItemIds(node: TreeNode, out = new Set<string>()): Set<string> {
  out.add(node.item);
  node.inputs?.forEach((c) => collectItemIds(c, out));
  return out;
}
