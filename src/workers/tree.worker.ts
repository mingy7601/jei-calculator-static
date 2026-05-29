/**
 * tree.worker.ts — Web Worker for tree building.
 *
 * Receives RecipeMap + EmcMap on init, then handles buildTree / wouldCycle / collectIds
 * via postMessage. All tree.ts logic runs off the main thread.
 *
 * NOTE: RecipeMap is sent on each buildTree call (not cached in worker) to avoid
 * a huge init message that can crash module workers with very large RecipeMaps.
 */

import * as T from "../app/tree";
import type { RecipeMap, EmcMap } from "../app/data";

let cachedRecipes: RecipeMap = {};
let cachedEmc: EmcMap = {};

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "init": {
        cachedRecipes = msg.recipes;
        cachedEmc = msg.emcValues;
        break;
      }
      case "buildTree": {
        // Use inline recipes if provided, otherwise fall back to cached
        const recipes = msg.recipes ?? cachedRecipes;
        const emc = msg.emcValues ?? cachedEmc;
        const tree = T.buildTree(msg.item, recipes, 0, {
          name: msg.name,
          overrides: msg.overrides,
          emcValues: emc,
          passived: new Set(msg.passived),
        });
        self.postMessage({ type: "tree", treeNode: tree, id: msg.id });
        break;
      }
      case "collectIds": {
        const ids = T.collectItemIds(msg.treeNode);
        self.postMessage({ type: "ids", ids: [...ids], id: msg.id });
        break;
      }
      default:
        self.postMessage({ type: "error", error: `Unknown message type: ${msg.type}`, id: msg.id });
    }
  } catch (err: any) {
    console.error("Worker error:", err);
    self.postMessage({ type: "error", error: err?.message ?? String(err), id: msg.id });
  }
};
