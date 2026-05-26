/**
 * types.ts — TypeScript types and interfaces used across the app.
 *
 * This file centralizes all type definitions so other modules can import
 * them without circular dependencies.
 */

import type { RecipeMap as RawRecipeMap, EmcMap as RawEmcMap } from "./data";
import type { TreeNode as RawTreeNode } from "./tree";

// ─── Node type system ───────────────────────────────────────────────────────

export type NodeType = "root" | "service" | "module" | "component" | "resource" | "emc" | "passived" | "cycle";

// ─── Tree node (display) ────────────────────────────────────────────────────

export interface TreeNode {
  id: string;
  itemId?: string;
  label: string;
  type: NodeType;
  meta?: string;
  imageUrl?: string;
  qty?: number;
  children?: TreeNode[];
}

// ─── Layout node (tree node + position) ─────────────────────────────────────

export interface LayoutNode extends TreeNode {
  x: number;
  y: number;
  height: number;
}

// ─── Leaf group (for sidebar cycling) ───────────────────────────────────────

export interface LeafGroup {
  itemId: string;
  leaves: LayoutNode[];
  selectedIndex: number;
}

// ─── Alternative recipe option ──────────────────────────────────────────────

export interface AltOption {
  recipe_id: number;
  category_name: string;
  image_url: string;
  inputs: { name: string; qty: number }[];
  outputs: { id: string; name: string; qty: number }[];
}

// ─── Items data (raw materials) ─────────────────────────────────────────────

export type ItemsData = Record<string, { name: string; qty: number }>;

// ─── Pan + zoom transform ───────────────────────────────────────────────────

export interface Transform {
  x: number;
  y: number;
  k: number; // zoom scale
}

// ─── Canvas renderer state ──────────────────────────────────────────────────

export interface CanvasRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
}

// ─── Interactive hit-boxes for a node ───────────────────────────────────────

export interface NodeHitBoxes {
  expandTriangle: { x: number; y: number; w: number; h: number } | null;
  altDoubleArrow: { x: number; y: number; w: number; h: number } | null;
  toggleStrip: { x: number; y: number; w: number; h: number } | null;
}

// ─── Edge (connection between two nodes) ─────────────────────────────────────

export interface Edge {
  fid: string; // from node id
  tid: string; // to node id
  isHighlighted: boolean;
}

// ─── Re-exported types from dependencies ────────────────────────────────────

export type RecipeMap = RawRecipeMap;
export type EmcMap = RawEmcMap;
export type { RawTreeNode } from "./tree";
