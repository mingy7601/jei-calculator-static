/**
 * hooks.ts — React state declarations extracted from App.tsx.
 *
 * This module centralizes all useState hooks so the component file
 * stays focused on JSX rendering and layout logic.
 */

import { useState, useMemo } from "react";

import { loadState } from "./state-persist";
import type {
  TreeNode,
  LayoutNode,
  LeafGroup,
  AltOption,
  ItemsData,
  Transform,
  RecipeMap,
} from "./types";

// ─── State declarations ─────────────────────────────────────────────────────

/**
 * Returns all React state hooks used by the App component.
 * Each useState is declared here so App.tsx only imports the hook.
 */
export function useAppState() {
  // Load persisted state from localStorage on mount
  const saved = useMemo(() => loadState(), []);

  // Recipe override map: itemId → recipeId (used to pick alternative recipes)
  const [overrides, setOverrides] = useState<Record<string, number>>(
    saved?.overrides ?? {}
  );

  // Alternatives panel state (positioned near the clicked node)
  const [altPanel, setAltPanel] = useState<{
    nodeId: string;
    realItemId: string;
    x: number;
    y: number;
    options: AltOption[];
  } | null>(null);

  // Loading indicator for alternative recipe loading
  const [altLoading, setAltLoading] = useState(false);

  // Root tree node (null while loading)
  const [treeRoot, setTreeRoot] = useState<TreeNode | null>(null);

  // Summed leaf ingredients (sidebar raw materials)
  const [items, setItems] = useState<ItemsData>({});

  // Fully loaded recipe map (all shards)
  const [loadedRecipes, setLoadedRecipes] = useState<RecipeMap>({});

  // Set of node IDs whose children are tree-expanded (visible)
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set());

  // Set of node IDs whose image card panel is expanded
  const [cardExpanded, setCardExpanded] = useState<Set<string>>(new Set());

  // Currently selected node ID (null = nothing selected)
  const [selected, setSelected] = useState<string | null>(saved?.selected ?? null);

  // Leaf groups keyed by itemId (for sidebar cycling through instances)
  const [leafGroups, setLeafGroups] = useState<Record<string, LeafGroup>>({});

  // Track which sidebar item is currently "active" (showing which instance)
  const [activeLeafItemId, setActiveLeafItemId] = useState<string | null>(null);

  // Highlight search input value
  const [highlightSearch, setHighlightSearch] = useState("");

  // Set of node IDs that match the current highlight search
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());

  // Filtered list of matching LayoutNodes for highlight cycling
  const [highlightMatchList, setHighlightMatchList] = useState<LayoutNode[]>([]);

  // Current index into highlightMatchList
  const [highlightIdx, setHighlightIdx] = useState(-1);

  // Pan + zoom transform matrix
  const [transform, setTransform] = useState<Transform>({ x: 48, y: 56, k: 1 });

  // Search input value (user's query)
  const [searchQuery, setSearchQuery] = useState(saved?.searchQuery ?? "");

  // Loading indicator for tree operations
  const [isLoading, setIsLoading] = useState(false);

  // Passived items treated as leaf nodes (no recipe expansion)
  const [passivedSet, setPassivedSet] = useState<Set<string>>(new Set());

  // Passived list stored as string[] (for rendering the panel)
  const [passivedList, setPassivedList] = useState<string[]>([]);

  // Passived dropdown visibility (replaces showPassivedPanel)
  const [passivedDropdownOpen, setPassivedDropdownOpen] = useState(false);

  // Search input value for passived autocomplete
  const [passivedSearchQuery, setPassivedSearchQuery] = useState("");

  // Filtered autocomplete suggestions for passived search
  const [passivedSuggestions, setPassivedSuggestions] = useState<
    { name: string; id: string }[]
  >([]);

  // Keyboard navigation index into passived suggestions
  const [passivedSuggestionIdx, setPassivedSuggestionIdx] = useState(-1);

  // Draft list of item IDs — not applied until "Reload" is clicked
  const [passivedPendingList, setPassivedPendingList] = useState<string[]>([]);

  // Whether pending changes differ from the committed passived list
  const [passivedHasChanges, setPassivedHasChanges] = useState(false);

  // Whether the user is actively panning the canvas
  const [panActive, setPanActive] = useState(false);

  // ID of the node currently under the mouse cursor
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Autocomplete dropdown state for the main search bar
  const [autoCompleteOpen, setAutoCompleteOpen] = useState(false);
  const [autoCompleteItems, setAutoCompleteItems] = useState<
    { name: string; id: string }[]
  >([]);
  const [autoCompleteIdx, setAutoCompleteIdx] = useState(-1);

  return {
    saved,
    overrides, setOverrides,
    altPanel, setAltPanel,
    altLoading, setAltLoading,
    treeRoot, setTreeRoot,
    items, setItems,
    loadedRecipes, setLoadedRecipes,
    treeExpanded, setTreeExpanded,
    cardExpanded, setCardExpanded,
    selected, setSelected,
    leafGroups, setLeafGroups,
    activeLeafItemId, setActiveLeafItemId,
    highlightSearch, setHighlightSearch,
    highlightedIds, setHighlightedIds,
    highlightMatchList, setHighlightMatchList,
    highlightIdx, setHighlightIdx,
    transform, setTransform,
    searchQuery, setSearchQuery,
    isLoading, setIsLoading,
    passivedSet, setPassivedSet,
    passivedList, setPassivedList,
    passivedDropdownOpen, setPassivedDropdownOpen,
    passivedSearchQuery, setPassivedSearchQuery,
    passivedSuggestions, setPassivedSuggestions,
    passivedSuggestionIdx, setPassivedSuggestionIdx,
    passivedPendingList, setPassivedPendingList,
    passivedHasChanges, setPassivedHasChanges,
    panActive, setPanActive,
    hoveredNodeId, setHoveredNodeId,
    autoCompleteOpen, setAutoCompleteOpen,
    autoCompleteItems, setAutoCompleteItems,
    autoCompleteIdx, setAutoCompleteIdx,
  };
}
