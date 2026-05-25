/**
 * layout.ts — Layout engine for the canvas-rendered tree.
 *
 * Calculates positions (x, y) and heights for each node in the tree,
 * respecting expand/collapse state and card (image panel) expand state.
 *
 * Layout algorithm:
 *   - Nodes are placed in columns by depth
 *   - Children are stacked vertically within a column
 *   - Each node is vertically centered relative to its subtree
 */

import type { TreeNode, LayoutNode } from "./types";

// ─── Dimensions ──────────────────────────────────────────────────────────────

export const NODE_W = 300;
export const NODE_H_BASE = 80;
export const NODE_H_IMAGE = 152;
export const COL_GAP = 76;
export const ROW_GAP = 12;

// ─── Height helpers ──────────────────────────────────────────────────────────

/**
 * Returns the rendered height of a node's card.
 * Expanded cards include the image panel; collapsed cards show only the header.
 */
export function cardH(id: string, cardExpanded: Set<string>): number {
  return cardExpanded.has(id) ? NODE_H_BASE + NODE_H_IMAGE : NODE_H_BASE;
}

/**
 * Recursively computes the total height of a subtree, including gaps between
 * children. Returns the maximum of the node's own height and the combined
 * height of its children.
 */
export function subtreeH(node: TreeNode, treeEx: Set<string>, cardEx: Set<string>): number {
  const myH = cardH(node.id, cardEx);
  if (!node.children?.length || !treeEx.has(node.id)) return myH;
  const ch = node.children;
  const childTotal =
    ch.reduce((s, c) => s + subtreeH(c, treeEx, cardEx), 0) + (ch.length - 1) * ROW_GAP;
  return Math.max(myH, childTotal);
}

// ─── Layout builder ──────────────────────────────────────────────────────────

/**
 * Recursively assigns (x, y) positions to every node in the tree,
 * producing a flat array of LayoutNode objects.
 *
 * @param node     — The current tree node
 * @param depth    — Column index (0 = root column)
 * @param yTop     — Top Y position for this node's subtree
 * @param treeEx   — Set of node IDs that are tree-expanded (children visible)
 * @param cardEx   — Set of node IDs that are card-expanded (image panel visible)
 * @param out      — Accumulator array for layout nodes
 * @returns        — Flat array of all layout nodes
 */
export function buildLayout(
  node: TreeNode,
  depth: number,
  yTop: number,
  treeEx: Set<string>,
  cardEx: Set<string>,
  out: LayoutNode[] = []
): LayoutNode[] {
  const myH = cardH(node.id, cardEx);
  const totalH = subtreeH(node, treeEx, cardEx);
  const x = depth * (NODE_W + COL_GAP);
  const y = yTop + (totalH - myH) / 2;
  out.push({ ...node, x, y, height: myH });

  if (node.children && treeEx.has(node.id)) {
    let cy = yTop;
    for (const child of node.children) {
      buildLayout(child, depth + 1, cy, treeEx, cardEx, out);
      cy += subtreeH(child, treeEx, cardEx) + ROW_GAP;
    }
  }
  return out;
}
