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
  source?: "base" | "cycle" | "limit" | "emc" | "passived" | "unknown" | "reroute";
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
 * Two-tier cycle detection return values:
 *   0 — no cycle detected
 *   1 — immediate loop (depth 1): e.g. A → child_recipe → A
 *       → should be rerouted (try alternative recipe)
 *   2+ — deferred loop (depth ≥ 2): e.g. A → B → C → A
 *       → treat the second occurrence as a leaf node
 *
 * With maxDepth=1, only immediate loops are detected here.
 * Deferred loops (depth ≥ 2) are caught by visited.has() in buildTree
 * when the recursive call reaches the ancestor item.
 */
export function wouldCycle(
  inputId: string,
  targetId: string,
  recipes: RecipeMap,
  depth = 0,
  maxDepth = 1,
  visited?: ReadonlySet<string>,
  _nodeCount?: { count: number },
  maxNodes?: number
): number {
  // Recursion stack check — catches cycles within the current build path
  if (visited?.has(inputId)) return depth + 1;
  // Direct self-reference
  if (inputId === targetId) return 1;
  // Depth limit — stop searching for longer cycles
  if (depth >= maxDepth) return 0;
  // Node budget exhausted — stop to prevent stall
  if (_nodeCount && maxNodes && _nodeCount.count >= maxNodes) return 0;

  const cacheKey = cycleCacheKey(inputId, targetId);
  const cached = cycleCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const options = recipes[inputId];
  if (!options?.length) {
    cycleCache.set(cacheKey, 0);
    return 0;
  }

  const viable = options.filter(
    (r) =>
      !r.inputs.some((inp) =>
        wouldCycle(inp.id, targetId, recipes, depth + 1, maxDepth, visited, _nodeCount, maxNodes)
      )
  );

  const result = viable.length === 0 ? 1 : 0;
  cycleCache.set(cacheKey, result);
  return result;
}

// ── Build tree ────────────────────────────────────────────────────────────────

export function buildTree(
  item: string,
  recipes: RecipeMap,
  step = 0,
  opts: {
    name?: string;
    visited?: ReadonlySet<string>;
    overrides?: Record<string, number>;
    emcValues?: EmcMap;
    /** Items treated as leaf nodes — no further expansion */
    passived?: ReadonlySet<string>;
    /** Memoization cache to prevent exponential blowup on DAGs */
    memo?: Map<string, TreeNode>;
    /** Maximum total nodes to generate before stopping (default 100000) */
    maxNodes?: number;
    /** Shared mutable counter for tracking total nodes */
    _nodeCount?: { count: number };
    /** Hard depth limit to prevent infinite recursion (default 20) */
    maxDepth?: number;
  } = {}
): TreeNode {
  const {
    name,
    visited = new Set<string>(),
    overrides = {},
    emcValues = {},
    passived = new Set<string>(),
    memo = new Map<string, TreeNode>(),
    maxNodes = 100000,
    _nodeCount = { count: 0 },
    maxDepth = 10,
  } = opts;

  if (visited.has(item)) {
    return { item, name: name ?? item, source: "cycle" } as TreeNode;
  }
  if (step >= maxDepth) {
    return { item, name: name ?? item, source: "limit" } as TreeNode;
  }
  if (_nodeCount.count >= maxNodes) {
    return { item, name: name ?? item, source: "limit" } as TreeNode;
  }

  // ── DAG memoization by (item, step) to prevent exponential blowup ──
  // Only valid when visited is empty (no recursion stack context).
  // When visited is non-empty, the result depends on cycle detection context,
  // so we skip memoization to avoid incorrect cached results.
  const memoKey = `${item}\0${step}`;
  const cached = visited.size === 0 ? memo.get(memoKey) : undefined;
  if (cached) return cached;

  // ── Passived check ──
  // If the item is in the passived set, treat it as a leaf node
  // regardless of whether recipes exist for it.
  if (passived.has(item)) {
    const result: TreeNode = { item, name: name ?? item, source: "passived" };
    memo.set(memoKey, result);
    return result;
  }

  const options = recipes[item];
  if (!options?.length) {
    const result: TreeNode = { item, name: name ?? item, source: "base" };
    memo.set(memoKey, result);
    return result;
  }

  const childVisited = new Set(visited).add(item);

  // Two-tier cycle filtering:
  //   depth 1 (immediate loop): reroute — filter out this recipe, try alternatives
  //   depth > 1 (deferred loop): leaf — the second occurrence becomes a leaf node
  // We check each recipe's inputs: if any input would cause a cycle at depth 1,
  // the recipe is excluded (reroute). If depth > 1, the input will be expanded
  // but the second occurrence will be caught by visited.has() in buildTree.
  let viable = options.filter(
    (r) => !r.inputs.some((inp) => {
      const cycleDepth = wouldCycle(inp.id, item, recipes, 0, maxDepth, visited, _nodeCount, maxNodes);
      // depth 1 = immediate loop → reroute (exclude recipe)
      // depth > 1 = deferred loop → keep recipe (second occurrence becomes leaf)
      return cycleDepth === 1;
    })
  );

  // If no viable recipes remain after rerouting all immediate loops,
  // return a cycle leaf node (the item itself is the cycle root)
  if (!viable.length) {
    const result: TreeNode = { item, name: name ?? item, source: "cycle" };
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

  _nodeCount.count++;

  // Check node budget before expanding inputs
  if (_nodeCount.count >= maxNodes) {
    const result: TreeNode = { item, name: name ?? item, step, source: "limit" };
    memo.set(memoKey, result);
    return result;
  }

  const inputs: TreeNode[] = [];
  for (const inp of recipe.inputs) {
    // Re-check budget before each input
    if (_nodeCount.count >= maxNodes) break;
    const hasEmc = !!emcValues[inp.id];
    const child: TreeNode = hasEmc
      ? { item: inp.id, name: inp.name ?? inp.id, source: "emc" }
      : buildTree(inp.id, recipes, step + 1, {
          name: inp.name,
          visited: childVisited,
          overrides,
          emcValues,
          passived,
          memo,
          _nodeCount,
          maxNodes,
          maxDepth,
        });
    inputs.push({ ...child, qty: inp.qty ?? 1 });
  }

  const result: TreeNode = {
    item,
    name: name ?? item,
    step,
    category: recipe.category,
    category_name: recipe.category_name,
    image_path: recipe.image_path,
    outputs: recipe.outputs,
    inputs,
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
