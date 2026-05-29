/**
 * tree.ts
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
    maxNodes = 1000000,
    _nodeCount = { count: 0 },
    maxDepth = 20,
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

  // Only filter out recipes that directly require the current item as an input
  // (a self-loop: A's recipe needs A).  Every other cycle is caught naturally:
  // when recursion reaches an ancestor, visited.has(item) fires at the top of
  // that call and returns a cycle leaf *there*, so the leaf node in the tree is
  // always the ancestor item itself rather than an intermediate node.
  //
  //   Direct self-loop (A → [A, ...]): filtered here; if all recipes self-loop,
  //     A becomes a cycle leaf immediately.
  //
  //   Reversible (A → B → A): B's recipe requiring A is not filtered (A ≠ B).
  //     Recursion into A hits visited.has("A") and returns a cycle leaf for A.
  //     If B also has a non-cycling recipe it is preferred by best-recipe
  //     selection, but the looping recipe is still valid and kept as a fallback.
  //
  //   Long loop (A → B → C → A): C's recipe requiring A is not filtered.
  //     Recursion into A hits visited.has("A") and returns a cycle leaf for A —
  //     the leaf is A, one step deeper, exactly as desired.
  let viable = options.filter(
    (r) => !r.inputs.some((inp) => inp.id === item)
  );

  // If every recipe for this item requires itself as a direct input,
  // return a cycle leaf immediately
  if (!viable.length) {
    const result: TreeNode = { item, name: name ?? item, source: "cycle" };
    memo.set(memoKey, result);
    return result;
  }

  // Find best recipe in O(n) — only need the top one
  const overrideId = overrides[item];
  let best: Recipe = viable[0];
  for (let i = 1; i < viable.length; i++) {
    const r = viable[i];
    const rQty = outputQty(r, item);
    const bQty = outputQty(best, item);
    if (rQty > bQty) {
      best = r;
    } else if (rQty === bQty && machinePriority(r) < machinePriority(best)) {
      best = r;
    }
  }
  // Apply override: if user picked a different recipe, use it first
  if (overrideId != null && overrideId !== best.id) {
    const preferredIdx = viable.findIndex((r) => r.id === overrideId);
    if (preferredIdx > 0) {
      // Move override to front; best stays second
      viable[0] = viable[preferredIdx];
      viable[preferredIdx] = best;
      best = viable[0];
    }
  }

  const recipe = best;

  _nodeCount.count++;

  // Check node budget before expanding inputs
  if (_nodeCount.count >= maxNodes) {
    const result: TreeNode = { item, name: name ?? item, step, source: "limit" };
    memo.set(memoKey, result);
    return result;
  }

  // Equal-split budget: every input gets at least one node before any
  // single branch can exhaust the total budget.  This ensures all inputs
  // are processed even when the tree is large.
  const remaining = maxNodes - _nodeCount.count;
  const share = Math.max(1, Math.floor(remaining / recipe.inputs.length));

  const inputs: TreeNode[] = [];
  for (const inp of recipe.inputs) {
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
          maxNodes: _nodeCount.count + share,
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
