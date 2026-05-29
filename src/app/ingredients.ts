/**
 * sumLeafIngredients(node) walks a TreeNode and accumulates quantities
 * for every leaf (nodes with no inputs). Returns a map sorted by qty desc.
 */

import type { TreeNode } from "./tree";

export interface IngredientEntry {
  name: string;
  qty: number;
}

export type IngredientsMap = Record<string, IngredientEntry>;

export function sumLeafIngredients(node: TreeNode): IngredientsMap {
  const totals: Record<string, IngredientEntry> = {};
  walk(node, totals);

  // Sort by qty descending
  return Object.fromEntries(
    Object.entries(totals).sort(([, a], [, b]) => b.qty - a.qty)
  );
}

function walk(node: TreeNode, totals: Record<string, IngredientEntry>): void {
  const inputs = node.inputs;

  if (!inputs?.length) {
    // Leaf node
    const itemId = node.item ?? "unknown";
    let name = node.name ?? itemId;

    // Prefer the name from outputs if available
    for (const output of node.outputs ?? []) {
      if (output.id === itemId && output.name) {
        name = output.name;
        break;
      }
    }

    const qty = typeof node.qty === "number" ? node.qty : 1;

    if (totals[itemId]) {
      totals[itemId].qty += qty;
    } else {
      totals[itemId] = { name, qty };
    }
  } else {
    for (const child of inputs) {
      walk(child, totals);
    }
  }
}
