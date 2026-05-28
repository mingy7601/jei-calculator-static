/**
 * App.tsx — canvas-rendered node viewer
 *
 * Performance architecture:
 *   1. Canvas layer — all edges + node rectangles drawn on a single <canvas>
 *      (O(n) draw calls instead of O(n) DOM nodes)
 *   2. HTML overlay — only the hovered/selected node rendered as HTML
 *   3. Pan + zoom — transform matrix with scroll-wheel zoom
 *   4. Viewport culling — only draw visible nodes on canvas
 *   5. Lazy tree loading — only build visible subtree initially, expand on demand
 */

import { useEffect, useRef, useCallback, useMemo, useLayoutEffect } from "react";
import { useAppState } from "./hooks";
import { Search, Loader2 } from "lucide-react";
import { Toaster, toast } from "sonner";
import { PassivedDropdown } from "./components/PassivedDropdown";

import { getManifest, getEmcMap, getRecipes, preWarmShards, resolveItemId, getLoadedRecipes, getPassivedList, savePassivedList, getManifestData, type RecipeMap, type EmcMap } from "./data";
import { buildTree, wouldCycle, collectItemIds, type TreeNode as RawTreeNode } from "./tree";
import { sumLeafIngredients } from "./ingredients";
import { loadState, saveState, clearState } from "./state-persist";
import type { NodeType, TreeNode, LayoutNode, LeafGroup, AltOption, ItemsData, Transform, NodeHitBoxes, Edge } from "./types";
import { buildLayout, NODE_W, NODE_H_BASE, NODE_H_IMAGE, COL_GAP, ROW_GAP, cardH, subtreeH } from "./layout";
import { CANVAS_BG, CANVAS_GRID, CANVAS_EDGE, CANDS_EDGE_HL, CANVAS_EDGE_SEL, NODE_BORDER, NODE_BORDER_SEL, NODE_BORDER_HL, NODE_RADIUS, screenToCanvas, canvasToScreen, drawGrid, drawEdge, hexToRgba, getNodeHitBoxes, isPointInCircle, isPointInRect, drawNode } from "./canvas-utils";

// ─── Visual tokens ─────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<NodeType, { dot: string; badge: string; text: string; label: string; bg: string }> = {
  root:      { dot: "#22d3ee", badge: "rgba(34,211,238,0.12)",  text: "#22d3ee", label: "root",        bg: "rgba(34,211,238,0.06)" },
  module:    { dot: "#34d399", badge: "rgba(52,211,153,0.12)",  text: "#34d399", label: "Crafting",     bg: "rgba(52,211,153,0.06)" },
  component: { dot: "#fb923c", badge: "rgba(251,146,60,0.12)",  text: "#fb923c", label: "MAX STEP",     bg: "rgba(251,146,60,0.06)" },
  resource:  { dot: "#94a3b8", badge: "rgba(148,163,184,0.09)", text: "#94a3b8", label: "Raw Resource", bg: "rgba(148,163,184,0.04)" },
  emc:       { dot: "#a855f7", badge: "rgba(168,85,247,0.12)",  text: "#a855f7", label: "EMC",          bg: "rgba(168,85,247,0.06)" },
  passived:  { dot: "#facc15", badge: "rgba(250,204,21,0.12)",  text: "#facc15", label: "Passived",     bg: "rgba(250,204,21,0.06)" },
  cycle:     { dot: "#ef4444", badge: "rgba(239,68,68,0.12)",   text: "#ef4444", label: "Cycle",        bg: "rgba(239,68,68,0.04)" },
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

let uidCounter = 0;

function assignUniqueIds(node: TreeNode): TreeNode {
  uidCounter = 0;
  return assignUniqueIdsInner(node);
}

function assignUniqueIdsInner(node: TreeNode): TreeNode {
  const uid = `node_${uidCounter++}`;
  return {
    ...node,
    itemId: node.id,
    id: uid,
    children: node.children?.map((child) => assignUniqueIdsInner(child)),
  };
}

function collectAllIds(node: TreeNode, out = new Set<string>()): Set<string> {
  if (node.children?.length) {
    out.add(node.id);
    node.children.forEach((c) => collectAllIds(c, out));
  }
  return out;
}

function countAll(node: TreeNode): number {
  return 1 + (node.children?.reduce((s, c) => s + countAll(c), 0) ?? 0);
}

// Walk the full tree (not just expanded parts) to find all nodes matching the query.
function searchFullTree(node: TreeNode | null, q: string, out: LayoutNode[] = []): LayoutNode[] {
  if (!node) return out;
  const labelMatch = node.label.toLowerCase().includes(q);
  const itemIdMatch = node.itemId && node.itemId.toLowerCase().includes(q);
  if (labelMatch || itemIdMatch) {
    out.push({ ...node, x: 0, y: 0, height: NODE_H_BASE });
  }
  if (node.children) {
    for (const c of node.children) {
      searchFullTree(c, q, out);
    }
  }
  return out;
}

// Walk the full tree (not just expanded parts) to find the first node matching targetItemId,
// then collect all ancestor node IDs so the tree can be expanded to show it.
function collectAncestorIdsToExpand(treeRoot: TreeNode, targetItemId: string): string[] {
  const ancestors: string[] = [];
  function walk(n: TreeNode): boolean {
    if ((n.itemId ?? n.id) === targetItemId) { ancestors.push(n.id); return true; }
    if (n.children) {
      for (const c of n.children) {
        if (walk(c)) { ancestors.push(n.id); return true; }
      }
    }
    return false;
  }
  walk(treeRoot);
  return ancestors;
}

// ─── Convert raw TreeNode → display TreeNode ──────────────────────────────────


function rawToDisplay(node: RawTreeNode, isRoot = false): TreeNode {
  const itemId = node.item ?? "unknown";
  const source = node.source;

  let nodeType: NodeType;
  if (isRoot) {
    nodeType = "root";
  } else if (source === "emc") {
    nodeType = "emc";
  } else if (source === "passived") {
    nodeType = "passived";
  } else if (source === "cycle") {
    nodeType = "cycle";
  } else if (source === "base" || source === "unknown") {
    nodeType = "resource";
  } else if (!node.inputs?.length) {
    nodeType = "component";
  } else {
    nodeType = "module";
  }

  const outputName = node.outputs?.find((o) => o.id === itemId)?.name;
  const label = outputName ?? node.name ?? itemId;
  const qty = node.qty ?? 1;
  const qtyStr = Number.isInteger(qty) ? String(qty) : qty.toFixed(1);
  const displayLabel = `${label} x ${qtyStr}`;

  const meta = nodeType === "emc" ? "emc" : (nodeType === "passived" ? "passived" : (nodeType === "cycle" ? "cycle" : (node.category_name ?? "N/A")));
  const imageUrl = node.image_path ? `/static/${node.image_path}` : undefined;

  const result: TreeNode = {
    id: itemId,
    label: displayLabel,
    type: nodeType,
    meta,
    imageUrl,
    qty,
  };

  if (node.inputs?.length) {
    result.children = node.inputs.map((child) => rawToDisplay(child, false));
  }

  return result;
}

// ─── Load helpers ─────────────────────────────────────────────────────────────

async function loadTree(
  query: string,
  overrides: Record<string, number> = {},
  passived: ReadonlySet<string> = new Set()
): Promise<{ displayTree: TreeNode; rawTree: RawTreeNode; recipes: RecipeMap; emcValues: EmcMap }> {
  const [itemId, emcValues] = await Promise.all([
    resolveItemId(query),
    getEmcMap(),
  ]);

  const rootRecipes = await getRecipes(itemId);
  const rootName = (() => {
    if (!rootRecipes.length) return query;
    const best = rootRecipes.reduce((a, b) =>
      (b.outputs.find((o) => o.id === itemId)?.qty ?? 0) >
      (a.outputs.find((o) => o.id === itemId)?.qty ?? 0)
        ? b : a
    );
    return best.outputs.find((o) => o.id === itemId)?.name ?? query;
  })();

  const recipes = getLoadedRecipes();
  const shallowTree = buildTree(itemId, recipes, 0, { name: rootName, overrides, emcValues, passived });
  const allIds = Array.from(collectItemIds(shallowTree));

  await preWarmShards(allIds);

  const fullRecipes = getLoadedRecipes();
  const rawTree = buildTree(itemId, fullRecipes, 0, { name: rootName, overrides, emcValues, passived });

  return { displayTree: rawToDisplay(rawTree, true), rawTree, recipes: fullRecipes, emcValues };
}

function getAlternatives(itemId: string, recipes: RecipeMap): AltOption[] {
  const options = recipes[itemId] ?? [];
  return options
    .filter((r) => !r.inputs.some((inp) => wouldCycle(inp.id, itemId, recipes)))
    .map((r) => ({
      recipe_id: r.id,
      category_name: r.category_name,
      image_url: r.image_path ? `/static/${r.image_path}` : "",
      inputs: r.inputs.map((i) => ({ name: i.name ?? i.id, qty: i.qty ?? 1 })),
      outputs: r.outputs.map((o) => ({ id: o.id, name: o.name ?? o.id, qty: o.qty ?? 1 })),
    }));
}

// ─── Main component ───────────────────────────────────────────────────────────

const VIEWPORT_PAD = 120;

export default function App() {
  // ── State declarations (extracted to hooks.ts) ──────────────────────────
  const {
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
    centeringKey, setCenteringKey,
    transform, setTransform,
    searchQuery, setSearchQuery,
    autoCompleteOpen, setAutoCompleteOpen,
    autoCompleteItems, setAutoCompleteItems,
    autoCompleteIdx, setAutoCompleteIdx,
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
  } = useAppState();

  const lastSearchQuery = useRef("");
  const lastTreeRootId = useRef<string | null>(null);

  const autoCompleteRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isPanning = useRef(false);
  const dragOrigin = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const rafId = useRef<number | null>(null);
  const pendingTransform = useRef<Transform>({ x: 48, y: 56, k: 1 });
  const pendingCenterNodeId = useRef<string | null>(null);
  const autoCompleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Sync passivedPendingList when committed list changes (initial load / right-click) ──
  useEffect(() => {
    setPassivedPendingList(passivedList);
  }, [passivedList]);

  // ── Detect whether pending list differs from committed list ──
  useEffect(() => {
    const sortedPending = [...passivedPendingList].sort();
    const sortedCommitted = [...passivedList].sort();
    setPassivedHasChanges(
      sortedPending.length !== sortedCommitted.length ||
        sortedPending.some((v, i) => v !== sortedCommitted[i])
    );
  }, [passivedPendingList, passivedList]);

  // ── Persist state to localStorage ────────────────────────────────────────
  const persistState = useCallback(() => {
    saveState({
      v: 1,
      searchQuery,
      overrides,
      selected,
    });
  }, [searchQuery, overrides, selected]);

  // ── Autocomplete logic ───────────────────────────────────────────────────
  const MAX_SUGGESTIONS = 8;

  const filterSuggestions = useCallback(
    (query: string) => {
      if (!query || query.length < 1) {
        setAutoCompleteItems([]);
        setAutoCompleteOpen(false);
        setAutoCompleteIdx(-1);
        return;
      }
      const q = query.toLowerCase();
      // Read name→id mapping from the manifest (loaded by getManifest on mount)
      const mf = getManifestData();
      if (!mf) {
        setAutoCompleteItems([]);
        setAutoCompleteOpen(false);
        setAutoCompleteIdx(-1);
        return;
      }
      const nameToId = mf.nameToId;
      const results: { name: string; id: string }[] = [];
      for (const [name, id] of Object.entries(nameToId)) {
        if (name.includes(q)) {
          results.push({ name, id });
          if (results.length >= MAX_SUGGESTIONS) break;
        }
      }
      setAutoCompleteItems(results);
      setAutoCompleteOpen(results.length > 0);
      setAutoCompleteIdx(-1);
    },
    []
  );

  // Debounced autocomplete filter — fires 150ms after typing stops
  const handleSearchInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setSearchQuery(val);
      persistState();
      if (autoCompleteTimer.current) clearTimeout(autoCompleteTimer.current);
      autoCompleteTimer.current = setTimeout(() => filterSuggestions(val), 150);
    },
    [setSearchQuery, persistState, filterSuggestions]
  );

  // Close autocomplete on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        autoCompleteRef.current &&
        !autoCompleteRef.current.contains(e.target as Node)
      ) {
        setAutoCompleteOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Keyboard navigation for autocomplete
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (autoCompleteOpen && autoCompleteItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAutoCompleteIdx((prev) =>
            prev < autoCompleteItems.length - 1 ? prev + 1 : 0
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAutoCompleteIdx((prev) =>
            prev > 0 ? prev - 1 : autoCompleteItems.length - 1
          );
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (autoCompleteIdx >= 0 && autoCompleteItems[autoCompleteIdx]) {
            const sel = autoCompleteItems[autoCompleteIdx];
            setSearchQuery(sel.name);
            setAutoCompleteOpen(false);
            setAutoCompleteIdx(-1);
            // Submit the form to load the tree
            const form = e.currentTarget.closest("form");
            form?.requestSubmit();
          } else {
            // No selection — just submit as-is
            const form = e.currentTarget.closest("form");
            form?.requestSubmit();
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAutoCompleteOpen(false);
          return;
        }
      }
      // Otherwise let the event propagate normally
    },
    [autoCompleteOpen, autoCompleteItems, autoCompleteIdx, setSearchQuery]
  );

  // Select a suggestion by click
  const handleSuggestionClick = useCallback(
    (name: string) => {
      setSearchQuery(name);
      setAutoCompleteOpen(false);
      setAutoCompleteIdx(-1);
    },
    [setSearchQuery]
  );

  // Save on page unload as safety net (inline to avoid stale closure)
  useEffect(() => {
    const onSave = () => {
      saveState({
        v: 1,
        searchQuery,
        overrides,
        selected,
      });
    };
    window.addEventListener("beforeunload", onSave);
    return () => window.removeEventListener("beforeunload", onSave);
  }, [searchQuery, overrides, selected]);

  // Track viewport size for culling
  useEffect(() => {
    const onResize = () => {
      if (canvasRef.current) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvasRef.current.getBoundingClientRect();
        canvasRef.current.width = rect.width * dpr;
        canvasRef.current.height = rect.height * dpr;
        const ctx = canvasRef.current.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Wheel zoom listener (non-passive to allow preventDefault)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const zoomLevels = [0.25, 0.5, 1.0];
      const currentIdx = zoomLevels.indexOf(Math.round(pendingTransform.current.k * 100) / 100);
      const dir = e.deltaY > 0 ? -1 : 1;
      const newIdx = Math.max(0, Math.min(zoomLevels.length - 1, currentIdx + dir));
      const newK = zoomLevels[newIdx];

      // Zoom toward cursor
      const ratio = newK / pendingTransform.current.k;
      const newPx = mx - (mx - pendingTransform.current.x) * ratio;
      const newPy = my - (my - pendingTransform.current.y) * ratio;

      pendingTransform.current = { x: newPx, y: newPy, k: newK };
      setTransform({ ...pendingTransform.current });
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [treeRoot]);

  // Load manifest + default item (or restored search query + overrides) on mount
  useEffect(() => {
    const savedQuery = saved?.searchQuery;
    const savedOverrides = saved?.overrides ?? {};
    const item = (savedQuery && savedQuery.length > 0) ? savedQuery : "mythic machine case";
    // Restore search query so the search bar shows the correct value
    setSearchQuery(item);
    // Restore overrides so alternatives are applied
    setOverrides(savedOverrides);
    setIsLoading(true);
    (async () => {
      try {
        await getManifest();
        // Load passived list before building the tree so it's available
        const passived = await getPassivedList();
        setPassivedSet(passived);
        setPassivedList(Array.from(passived));
        const { displayTree, rawTree, recipes } = await loadTree(item, savedOverrides, passived);
        const unique = assignUniqueIds(displayTree);
        setTreeRoot(unique);
        setTreeExpanded(collectAllIds(unique));
        setLoadedRecipes(recipes);
        setItems(sumLeafIngredients(rawTree));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load tree");
      } finally {
        setIsLoading(false);
      }
    })();
  }, [saved]);

  const nodes = useMemo(
    () => (treeRoot ? buildLayout(treeRoot, 0, 0, treeExpanded, cardExpanded) : []),
    [treeRoot, treeExpanded, cardExpanded]
  );
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const nodesRef = useRef(nodes);
  useLayoutEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // ── Center and select node after deferred expansion ─────────────────────
  useEffect(() => {
    const targetId = pendingCenterNodeId.current;
    if (!targetId) return;
    pendingCenterNodeId.current = null;

    const target = byId.get(targetId);
    if (!target) return;

    const cw = containerRef.current?.clientWidth ?? window.innerWidth;
    const ch = containerRef.current?.clientHeight ?? window.innerHeight;
    setTransform({
      x: cw / 2 - target.x - NODE_W / 2,
      y: ch / 2 - target.y - target.height / 2,
      k: pendingTransform.current.k,
    });
    pendingTransform.current = { x: cw / 2 - target.x - NODE_W / 2, y: ch / 2 - target.y - target.height / 2, k: pendingTransform.current.k };
  }, [nodes, byId, setTransform, centeringKey]);



  // ── Viewport culling ───────────────────────────────────────────────────────
  const visibleNodes = useMemo(() => {
    const w = containerRef.current?.clientWidth || window.innerWidth;
    const h = containerRef.current?.clientHeight || window.innerHeight;
    return nodes.filter(
      (n) => {
        const s = canvasToScreen(transform, n.x, n.y);
        return (
          s.x < w + VIEWPORT_PAD &&
          s.x + NODE_W * transform.k > -VIEWPORT_PAD &&
          s.y < h + VIEWPORT_PAD &&
          s.y + n.height * transform.k > -VIEWPORT_PAD
        );
      }
    );
  }, [nodes, transform]);

  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const leafCountPerItem = useMemo(() => {
    if (!treeRoot) return new Map<string, number>();
    const counts = new Map<string, number>();
    function walk(n: TreeNode) {
      if (!n.children?.length) {
        const iid = n.itemId ?? n.id;
        counts.set(iid, (counts.get(iid) ?? 0) + 1);
      } else {
        for (const c of n.children) walk(c);
      }
    }
    walk(treeRoot);
    return counts;
  }, [treeRoot]);

  const leafGroupsComputed = useMemo(() => {
    const groups = new Map<string, LayoutNode[]>();
    for (const n of nodes) {
      const isLeaf = !n.children?.length;
      if (isLeaf) {
        const iid = n.itemId ?? n.id;
        if (!groups.has(iid)) groups.set(iid, []);
        groups.get(iid)!.push(n);
      }
    }
    const result: Record<string, LeafGroup> = {};
    for (const [itemId, leaves] of groups) {
      result[itemId] = { itemId, leaves, selectedIndex: 0 };
    }
    return result;
  }, [nodes]);

  const leafGroupsMerged = useMemo(() => {
    const merged = { ...leafGroups };
    for (const [itemId, group] of Object.entries(leafGroupsComputed)) {
      if (!merged[itemId]) {
        merged[itemId] = { ...group, selectedIndex: 0 };
      } else {
        merged[itemId] = { ...group, selectedIndex: merged[itemId].selectedIndex };
      }
    }
    return merged;
  }, [leafGroupsComputed, leafGroups]);

  const emcItems = useMemo(() => {
    const set = new Set<string>();
    if (!treeRoot) return set;
    function walk(n: TreeNode) {
      if (n.type === "emc") {
        set.add(n.itemId ?? n.id);
      }
      n.children?.forEach(walk);
    }
    walk(treeRoot);
    return set;
  }, [treeRoot]);

  const edges = useMemo(() => {
    const result: { fid: string; tid: string; isHighlighted: boolean }[] = [];
    for (const n of nodes) {
      if (n.children && treeExpanded.has(n.id)) {
        for (const c of n.children) {
          if (byId.has(c.id) && (visibleIds.has(n.id) || visibleIds.has(c.id))) {
            const isHl = highlightedIds.has(n.id) || highlightedIds.has(c.id);
            result.push({ fid: n.id, tid: c.id, isHighlighted: isHl });
          }
        }
      }
    }
    return result;
  }, [nodes, byId, treeExpanded, visibleIds, highlightedIds]);

  const totalNodes = useMemo(() => (treeRoot ? countAll(treeRoot) : 0), [treeRoot]);

  // ── Canvas draw loop ───────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, w, h);

    // Grid
    drawGrid(ctx, w, h, transform);

    // Edges
    for (const { fid, tid, isHighlighted } of edges) {
      const f = byId.get(fid);
      const t = byId.get(tid);
      if (!f || !t) continue;
      const x1 = f.x + NODE_W;
      const y1 = f.y + f.height / 2;
      const x2 = t.x;
      const y2 = t.y + t.height / 2;
      const s1 = canvasToScreen(transform, x1, y1);
      const s2 = canvasToScreen(transform, x2, y2);
      const isSel = selected === fid || selected === tid;
      drawEdge(ctx, s1.x, s1.y, s2.x, s2.y, isHighlighted, isSel);
    }

    // Visible nodes
    for (const node of visibleNodes) {
      const s = canvasToScreen(transform, node.x, node.y);
      const sw = NODE_W * transform.k;
      const sh = node.height * transform.k;
      const isSelected = selected === node.id;
      const isHovered = hoveredNodeId === node.id;
      const isTreeEx = treeExpanded.has(node.id);
      const isHighlighted = highlightedIds.has(node.id);
      const cfg = TYPE_CONFIG[node.type];
      let borderColor: string;
      let bgColor: string;
      const isPassived = node.type === "passived";
      if (isSelected) {
        borderColor = NODE_BORDER_SEL;
        bgColor = "rgba(34,211,238,0.045)";
      } else if (isHovered) {
        borderColor = NODE_BORDER_HL;
        bgColor = "rgba(34,211,238,0.08)";
      } else if (isHighlighted) {
        borderColor = NODE_BORDER_HL;
        bgColor = "rgba(34,211,238,0.06)";
      } else if (isPassived) {
        borderColor = "rgba(250,204,21,0.55)";
        bgColor = "var(--card)";
      } else {
        borderColor = NODE_BORDER;
        bgColor = "var(--card)";
      }

      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.scale(transform.k, transform.k);

      drawNode(
        ctx,
        { ...node, x: 0, y: 0, height: node.height },
        isSelected,
        isHovered,
        isTreeEx,
        cardExpanded.has(node.id),
        borderColor,
        bgColor,
        cfg.dot
      );

      ctx.restore();
    }
  }, [nodes, edges, visibleNodes, transform, selected, hoveredNodeId, treeExpanded, highlightedIds, byId]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q || isLoading) return;
    setIsLoading(true);
    try {
      const { displayTree, rawTree, recipes } = await loadTree(q, overrides, passivedSet);
      const unique = assignUniqueIds(displayTree);
      setTreeRoot(unique);
      setTreeExpanded(collectAllIds(unique));
      setCardExpanded(new Set());
      setSelected(null);
      setActiveLeafItemId(null);
      setLeafGroups({});
      pendingCenterNodeId.current = unique.id;
      setLoadedRecipes(recipes);
      setItems(sumLeafIngredients(rawTree));
      toast.success(`Loaded: ${displayTree.label}`);
      // Persist after tree load
      persistState();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load tree");
    } finally {
      setIsLoading(false);
    }
  };

  // ── Pan ────────────────────────────────────────────────────────────────────

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-node]")) return;
      setAltPanel(null);
      isPanning.current = true;
      setPanActive(true);
      dragOrigin.current = { mx: e.clientX, my: e.clientY, px: transform.x, py: transform.y };
    },
    [transform]
  );

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    pendingTransform.current = {
      x: dragOrigin.current.px + e.clientX - dragOrigin.current.mx,
      y: dragOrigin.current.py + e.clientY - dragOrigin.current.my,
      k: pendingTransform.current.k,
    };
    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(() => {
        setTransform({ ...pendingTransform.current });
        rafId.current = null;
      });
    }
  }, []);

  const onMouseUp = useCallback(() => {
    isPanning.current = false;
    setPanActive(false);
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
      const final = { ...pendingTransform.current };
      setTransform(final);
    }
  }, []);

  // ── Rebuild tree with a given passived set ─────────────────────────────
  const rebuildTreeWithPassived = useCallback(
    async (newPassived: Set<string>, centerItemId?: string) => {
      const q = searchQuery.trim();
      if (!q) return;
      setIsLoading(true);
      try {
        const { displayTree, rawTree, recipes } = await loadTree(q, overrides, newPassived);
        const unique = assignUniqueIds(displayTree);
        const allExpanded = collectAllIds(unique);
        setTreeRoot(unique);
        setTreeExpanded(allExpanded);
        setCardExpanded(new Set());
        setActiveLeafItemId(null);
        setLeafGroups({});
        setLoadedRecipes(recipes);
        setItems(sumLeafIngredients(rawTree));

        // Compute layout synchronously so we can center before any render
        if (centerItemId) {
          const layout = buildLayout(unique, 0, 0, allExpanded, new Set());
          const target = layout.find((n) => (n.itemId ?? n.id) === centerItemId);
          if (target) {
            const vw = containerRef.current?.clientWidth || window.innerWidth;
            const vh = containerRef.current?.clientHeight || window.innerHeight;
            setTransform({
              x: vw / 2 - target.x - NODE_W / 2,
              y: vh / 2 - target.y - target.height / 2,
              k: pendingTransform.current.k,
            });
            setSelected(target.id);
          } else {
            setTransform({ x: 48, y: 56, k: 1 });
            setSelected(null);
          }
        } else {
          setTransform({ x: 48, y: 56, k: 1 });
          setSelected(null);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to reload tree");
      } finally {
        setIsLoading(false);
      }
    },
    [searchQuery, overrides]
  );

  // ── Reload handler: apply pending passived changes to the tree ──
  const handlePassivedReload = useCallback(async () => {
    if (!passivedHasChanges) return;
    setIsLoading(true);
    try {
      savePassivedList(passivedPendingList);
      setPassivedSet(new Set(passivedPendingList));
      setPassivedList(passivedPendingList);
      await rebuildTreeWithPassived(new Set(passivedPendingList));
      toast.success("Passived list applied — tree reloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reload tree");
    } finally {
      setIsLoading(false);
    }
  }, [passivedHasChanges, passivedPendingList, rebuildTreeWithPassived]);

  // ── Right-click → toggle node in passived ─────────────────────────────
  const onCanvasContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Find which node was right-clicked
      for (const node of visibleNodes) {
        const s = canvasToScreen(transform, node.x, node.y);
        const sw = NODE_W * transform.k;
        const sh = node.height * transform.k;
        if (mx >= s.x && mx <= s.x + sw && my >= s.y && my <= s.y + sh) {
          const realItemId = node.itemId ?? node.id;
          const isInPassived = passivedList.includes(realItemId);
          if (isInPassived) {
            const next = passivedList.filter((id) => id !== realItemId);
            setPassivedList(next);
            savePassivedList(next);
            setPassivedSet(new Set(next));
            toast.success(`"${realItemId}" removed from passived — children shown`);
            rebuildTreeWithPassived(new Set(next), realItemId);
          } else {
            const next = [...passivedList, realItemId];
            setPassivedList(next);
            savePassivedList(next);
            setPassivedSet(new Set(next));
            toast.success(`"${realItemId}" added to passived — children hidden`);
            rebuildTreeWithPassived(new Set(next), realItemId);
          }
          return;
        }
      }
    },
    [visibleNodes, transform, passivedList, rebuildTreeWithPassived]
  );

  // ── Canvas click handler ──────────────────────────────────────────────────
  const onCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Check each visible node for interactive element hits
      for (const node of visibleNodes) {
        const boxes = getNodeHitBoxes(node, transform);

        // Expand triangle hit → toggle tree expand
        if (
          boxes.expandTriangle &&
          isPointInRect(mx, my, boxes.expandTriangle.x, boxes.expandTriangle.y, boxes.expandTriangle.w, boxes.expandTriangle.h)
        ) {
          setTreeExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(node.id)) next.delete(node.id);
            else next.add(node.id);
            return next;
          });
          return;
        }

        // Show alternatives double-arrow hit → show alternatives panel
        if (
          boxes.altDoubleArrow &&
          node.type !== "passived" &&
          isPointInRect(mx, my, boxes.altDoubleArrow.x, boxes.altDoubleArrow.y, boxes.altDoubleArrow.w, boxes.altDoubleArrow.h)
        ) {
          const realItemId = node.itemId ?? node.id;
          const options = getAlternatives(realItemId, loadedRecipes);
          if (options.length > 0) {
            const panelCols = Math.ceil(options.length / 8);
            const panelW = panelCols * 260;
            setAltPanel({
              nodeId: node.id,
              realItemId,
              x: node.x - panelW,
              y: node.y + 38 + 16,
              options,
            });
          }
          return;
        }

        // Toggle strip hit → toggle card expand (show image)
        if (
          boxes.toggleStrip &&
          isPointInRect(mx, my, boxes.toggleStrip.x, boxes.toggleStrip.y, boxes.toggleStrip.w, boxes.toggleStrip.h)
        ) {
          setCardExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(node.id)) next.delete(node.id);
            else next.add(node.id);
            return next;
          });
          return;
        }

        // Node body hit → select
        const s = canvasToScreen(transform, node.x, node.y);
        const sw = NODE_W * transform.k;
        const sh = node.height * transform.k;
        if (mx >= s.x && mx <= s.x + sw && my >= s.y && my <= s.y + sh) {
          setSelected(node.id);
          // Persist selected node
          persistState();
          return;
        }
      }

      // Clicked on empty canvas → deselect
      setSelected(null);
    },
    [visibleNodes, transform, loadedRecipes]
  );

  function collectDescendantItemIds(
    node: TreeNode,
    targetItemId: string,
    found = false,
    out = new Set<string>()
  ): Set<string> {
    if (found) out.add(node.itemId ?? node.id);
    const isTarget = (node.itemId ?? node.id) === targetItemId;
    node.children?.forEach((c) => collectDescendantItemIds(c, targetItemId, found || isTarget, out));
    return out;
  }

  // ── Sidebar raw material click → cycle through leaf nodes ────────────────
  const handleLeafClick = useCallback(
    (itemId: string) => {
      if (!treeRoot || (leafCountPerItem.get(itemId) ?? 0) === 0) return;

      const group = leafGroupsMerged[itemId];
      const hasVisibleLeaves = group && group.leaves.length > 0;

      if (!hasVisibleLeaves) {
        const firstLeaf = findFirstLeaf(treeRoot, itemId);
        if (firstLeaf) {
          const ancestors = new Set<string>();
          const targetId = firstLeaf.id;
          function walk(n: TreeNode) {
            if (n.id === targetId) { ancestors.add(n.id); return true; }
            if (n.children) {
              for (const c of n.children) {
                if (walk(c)) { ancestors.add(n.id); return true; }
              }
            }
            return false;
          }
          walk(treeRoot);
          setTreeExpanded((prev) => {
            const next = new Set(prev);
            for (const a of ancestors) next.add(a);
            return next;
          });
          // Defer centering until the layout is recalculated after tree expansion
          pendingCenterNodeId.current = firstLeaf.id;
          setSelected(firstLeaf.id);
        }
        return;
      }

      const nextIndex = (group.selectedIndex + 1) % group.leaves.length;
      setLeafGroups((prev) => ({
        ...prev,
        [itemId]: { ...group, selectedIndex: nextIndex },
      }));

      const targetNode = group.leaves[nextIndex];
      const ancestors = new Set<string>();
      function walk(n: TreeNode) {
        if (n.id === targetNode.id) { ancestors.add(n.id); return true; }
        if (n.children) {
          for (const c of n.children) {
            if (walk(c)) { ancestors.add(n.id); return true; }
          }
        }
        return false;
      }
      walk(treeRoot);
      setTreeExpanded((prev) => {
        const next = new Set(prev);
        for (const a of ancestors) next.add(a);
        return next;
      });

      const canvas = canvasRef.current;
      const cw = canvas?.clientWidth ?? (containerRef.current?.clientWidth ?? window.innerWidth);
      const ch = canvas?.clientHeight ?? (containerRef.current?.clientHeight ?? window.innerHeight);
      setTransform({
        x: cw / 2 - targetNode.x,
        y: ch / 2 - targetNode.y,
        k: transform.k,
      });
      pendingTransform.current = { x: cw / 2 - targetNode.x, y: ch / 2 - targetNode.y, k: transform.k };
      setSelected(targetNode.id);
    },
    [leafGroupsMerged, treeRoot, leafCountPerItem, transform, canvasRef]
  );

  function findFirstLeaf(node: TreeNode, targetItemId: string): TreeNode | null {
    if ((node.itemId ?? node.id) === targetItemId && !node.children?.length) {
      return node;
    }
    if (node.children) {
      for (const c of node.children) {
        const found = findFirstLeaf(c, targetItemId);
        if (found) return found;
      }
    }
    return null;
  }

  const handleSelectAlt = useCallback(
    async (itemId: string, recipeId: number) => {
      const newOverrides = { ...overrides, [altPanel!.realItemId]: recipeId };
      setOverrides(newOverrides);
      setAltPanel(null);
      setIsLoading(true);
      try {
        const { displayTree, rawTree, recipes } = await loadTree(searchQuery, newOverrides, passivedSet);
        const uniqueTree = assignUniqueIds(displayTree);
        setTreeRoot(uniqueTree);
        setLoadedRecipes(recipes);
        setItems(sumLeafIngredients(rawTree));

        const changedItemId = altPanel!.realItemId;
        const descendantItemIds = collectDescendantItemIds(uniqueTree, changedItemId);

        const prevExpandedItemIds = new Set(
          [...treeExpanded].map((uid) => byId.get(uid)?.itemId).filter((iid): iid is string => !!iid)
        );
        const prevCardExpandedItemIds = new Set(
          [...cardExpanded].map((uid) => byId.get(uid)?.itemId).filter((iid): iid is string => !!iid)
        );

        const newExpanded = new Set<string>();
        const newCardExpanded = new Set<string>();

        function walk(node: TreeNode) {
          const iid = node.itemId ?? node.id;
          if (iid === (uniqueTree.itemId ?? uniqueTree.id)) {
            newExpanded.add(node.id);
          } else if (prevExpandedItemIds.has(iid) && !descendantItemIds.has(iid)) {
            newExpanded.add(node.id);
          }
          if (prevCardExpandedItemIds.has(iid) && !descendantItemIds.has(iid)) {
            newCardExpanded.add(node.id);
          }
          node.children?.forEach(walk);
        }
        walk(uniqueTree);

        setTreeExpanded(newExpanded);
        setCardExpanded(newCardExpanded);
        setSelected(null);
        // Persist overrides after selecting alternative
        persistState();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to reload tree");
      } finally {
        setIsLoading(false);
      }
    },
    [overrides, searchQuery, altPanel, treeExpanded, cardExpanded, byId]
  );

  // ── Highlight search ───────────────────────────────────────────────────────

  // Shared logic: search the full tree, set highlight state, expand ancestors,
  // and trigger centering. Returns true if matches were found.
  const performHighlightSearch = useCallback(
    (q: string) => {
      const matches = searchFullTree(treeRoot, q);
      setHighlightMatchList(matches);
      setHighlightedIds(new Set(matches.map((n) => n.id)));
      setHighlightIdx(0);

      if (matches.length === 0) {
        toast.info(`No matches for "${q}"`);
        return false;
      }

      lastSearchQuery.current = q;
      lastTreeRootId.current = treeRoot?.id ?? null;

      const ancestors = collectAncestorIdsToExpand(treeRoot!, matches[0].itemId ?? matches[0].id);
      setTreeExpanded((prev) => new Set([...prev, ...ancestors]));
      pendingCenterNodeId.current = matches[0].id;
      setCenteringKey((prev) => prev + 1);
      setSelected(matches[0].id);
      setActiveLeafItemId(null);
      return true;
    },
    [treeRoot, setCenteringKey]
  );

  const handleHighlightKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      const raw = e.currentTarget.value;
      const q = raw.trim().toLowerCase();
      setHighlightSearch(raw.trim());

      if (!q) {
        setHighlightedIds(new Set());
        setHighlightMatchList([]);
        setHighlightIdx(-1);
        return;
      }

      // Check if the query AND tree are the same as last time
      const isSameSearch =
        q === lastSearchQuery.current &&
        (treeRoot?.id ?? null) === lastTreeRootId.current;

      if (isSameSearch && highlightMatchList.length > 0) {
        // Cycle to next match
        const nextIdx = (highlightIdx + 1) % highlightMatchList.length;
        setHighlightIdx(nextIdx);
        const target = highlightMatchList[nextIdx];
        const ancestors = collectAncestorIdsToExpand(treeRoot!, target.itemId ?? target.id);
        setTreeExpanded((prev) => new Set([...prev, ...ancestors]));
        pendingCenterNodeId.current = target.id;
        setCenteringKey((prev) => prev + 1);
        setSelected(target.id);
        setActiveLeafItemId(null);
        return;
      }

      // New search or tree changed — perform full re-search
      performHighlightSearch(q);
    },
    [treeRoot, highlightMatchList, highlightIdx, performHighlightSearch]
  );

  const handleHighlightClear = useCallback(() => {
    setHighlightSearch("");
    setHighlightedIds(new Set());
    setHighlightMatchList([]);
    setHighlightIdx(-1);
    setActiveLeafItemId(null);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  // Find hovered node data for HTML overlay
  const hoveredNode = hoveredNodeId ? byId.get(hoveredNodeId) : null;
  const selectedNode = selected ? byId.get(selected) : null;

  return (
    <>
      <Toaster
        theme="dark"
        toastOptions={{
          style: {
            background: "#111120",
            border: "1px solid rgba(255,255,255,0.09)",
            color: "#dde2ea",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
          },
        }}
      />

      <div className="size-full flex bg-background text-foreground overflow-hidden" style={{ fontFamily: "'Inter', sans-serif" }}>
        <div className="flex-1 flex flex-col min-w-0" ref={containerRef}>

          {/* ── Toolbar ── */}
          <header className="shrink-0 flex items-center gap-3 border-b border-border px-4 h-12">
            <div className="flex items-center gap-2 shrink-0">
              <span className="w-2 h-2 rounded-full" style={{ background: "#22d3ee", boxShadow: "0 0 8px rgba(34,211,238,0.7)" }} />
              <span className="text-sm font-semibold tracking-tight whitespace-nowrap">Crafting Calculator</span>
            </div>

            <div className="w-px h-5 bg-border shrink-0" />

            <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 min-w-0">
              <div className="relative flex-1 min-w-0 max-w-md" ref={autoCompleteRef}>
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={handleSearchInputChange}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search or enter an ID to load as root…"
                  disabled={isLoading}
                  className="w-full h-7 pl-8 pr-3 text-xs rounded border border-border bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[rgba(34,211,238,0.4)] focus:ring-1 focus:ring-[rgba(34,211,238,0.15)] transition-colors disabled:opacity-50"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                />
                {autoCompleteOpen && autoCompleteItems.length > 0 && (
                  <div
                    className="absolute top-full left-0 right-0 mt-0.5 z-50 rounded border border-border bg-[#0e0e1a] shadow-lg overflow-hidden"
                    style={{ maxHeight: `${MAX_SUGGESTIONS * 28 + 2}px`, overflowY: "auto" }}
                  >
                    {autoCompleteItems.map((item, idx) => (
                      <button
                        key={item.id}
                        onClick={() => handleSuggestionClick(item.name)}
                        className={`w-full text-left px-2 py-0.5 text-xs truncate transition-colors ${
                          idx === autoCompleteIdx
                            ? "bg-[rgba(34,211,238,0.12)] text-cyan-300"
                            : "text-muted-foreground hover:bg-white/5"
                        }`}
                        style={{ fontFamily: "'JetBrains Mono', monospace", lineHeight: "28px" }}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="submit"
                disabled={isLoading || !searchQuery.trim()}
                className="shrink-0 h-7 px-3 text-xs rounded border border-border text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors disabled:opacity-40 disabled:pointer-events-none flex items-center gap-1.5"
              >
                {isLoading ? (<><Loader2 size={11} className="animate-spin" />Loading</>) : "Load"}
              </button>
            </form>

            <div className="flex items-center gap-2 shrink-0 ml-auto">
              <span className="text-xs text-muted-foreground tabular-nums mr-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {visibleNodes.length} visible / {nodes.length} expanded / {totalNodes} total
              </span>
              <span className="text-xs text-muted-foreground tabular-nums mr-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {Math.round(transform.k * 100)}%
              </span>
              <button
                onClick={() => {
                  if (!treeRoot) return;
                  setSelected(treeRoot.id);
                  setTreeExpanded(new Set([treeRoot.id]));
                  pendingCenterNodeId.current = treeRoot.id;
                }}
                name= "resetView"
                className="text-xs px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors"
              >
                Reset view
              </button>
              {(
                [
                  { label: "Hide images", fn: () => setCardExpanded(new Set()) },
                  { label: "Expand all",  fn: () => treeRoot && setTreeExpanded(collectAllIds(treeRoot)) },
                  { label: "Collapse all",fn: () => treeRoot && setTreeExpanded(new Set([treeRoot.id])) },
                ] as const
              ).map(({ label, fn }) => (
                <button key={label} onClick={fn} className="text-xs px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors">
                  {label}
                </button>
              ))}
              <button
                onClick={() => {
                  // Only clear overrides (alternative recipes), keep search query and tree
                  setOverrides({});
                  saveState({
                    v: 1,
                    searchQuery: saved?.searchQuery ?? "",
                    overrides: {},
                    selected: null,
                  });
                  toast.info("Alternative recipes cleared — tree preserved");
                }}
                className="text-xs px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors"
                title="Clear alternative recipes only (search query and tree are preserved)"
              >
                Clear saved
              </button>
              <div className="relative">
                <button
                  onClick={() => setPassivedDropdownOpen((p) => !p)}
                  className={`text-xs px-2.5 py-1 rounded border border-border hover:text-foreground hover:border-white/20 transition-colors ${
                    passivedDropdownOpen ? "text-yellow-400 border-yellow-400/30" : "text-muted-foreground"
                  }`}
                  title="Manage passived items (leaf nodes that won't be expanded)"
                >
                  ⚡ Passived ({passivedPendingList.length})
                </button>
                <PassivedDropdown
                  passivedPendingList={passivedPendingList}
                  setPassivedPendingList={setPassivedPendingList}
                  passivedHasChanges={passivedHasChanges}
                  setPassivedHasChanges={setPassivedHasChanges}
                  passivedSearchQuery={passivedSearchQuery}
                  setPassivedSearchQuery={setPassivedSearchQuery}
                  passivedSuggestions={passivedSuggestions}
                  setPassivedSuggestions={setPassivedSuggestions}
                  passivedSuggestionIdx={passivedSuggestionIdx}
                  setPassivedSuggestionIdx={setPassivedSuggestionIdx}
                  passivedDropdownOpen={passivedDropdownOpen}
                  setPassivedDropdownOpen={setPassivedDropdownOpen}
                  onReload={handlePassivedReload}
                />
              </div>
            </div>
          </header>

          {/* ── Legend ── */}
          <div className="shrink-0 flex items-center gap-5 px-4 h-8 border-b border-border">
            {(Object.entries(TYPE_CONFIG) as [NodeType, (typeof TYPE_CONFIG)[NodeType]][]).map(([type, { dot, label }]) => (
              <div key={type} className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: dot }} />
                <span className="text-[11px] text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>{label}</span>
              </div>
            ))}
          </div>

          {/* ── Highlight Search ── */}
          <div className="shrink-0 flex items-center gap-2 px-4 h-9 border-b border-border">
            <Search size={11} className="text-muted-foreground shrink-0" />
            <input
              name="nodeSearchBar"
              type="text"
              value={highlightSearch}
              onChange={(e) => setHighlightSearch(e.target.value)}
              onKeyDown={handleHighlightKeyDown}
              placeholder="Press Enter to highlight nodes…"
              className="flex-1 h-5 px-2 text-[11px] rounded border border-border bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[rgba(34,211,238,0.4)] transition-colors"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            />
            {highlightMatchList.length > 0 && (
              <>
                <span className="text-[10px] text-muted-foreground tabular-nums" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {highlightIdx + 1}/{highlightMatchList.length} matches
                </span>
                <button
                  onClick={handleHighlightClear}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
                  title="Clear highlight"
                >
                  ✕
                </button>
              </>
            )}
          </div>

          {/* ── Canvas ── */}
          {treeRoot === null ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              <Loader2 size={16} className="animate-spin mr-2" />
              Loading...
            </div>
          ) : (
            <div
              className="flex-1 relative overflow-hidden select-none"
              style={{ cursor: panActive ? "grabbing" : "grab" }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onContextMenu={onCanvasContextMenu}
            >
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full"
                style={{ touchAction: "none" }}
                onClick={onCanvasClick}
              />

              {/* HTML overlay for hovered/selected node with image */}
              {overlayRef.current && (hoveredNode || selectedNode) && (
                <div
                  ref={overlayRef}
                  className="pointer-events-none absolute"
                  style={{
                    left: 0,
                    top: 0,
                    width: NODE_W,
                    zIndex: 10,
                  }}
                >
                  {/* Position will be set via transform below */}
                </div>
              )}

              {/* Alt panel */}
              {altPanel && (
                <div
                  data-node
                  style={{
                    position: "absolute",
                    left: altPanel.x * transform.k + transform.x,
                    top: altPanel.y * transform.k + transform.y,
                    width: Math.ceil(altPanel.options.length / 8) * 260 * transform.k,
                    zIndex: 50,
                    background: "#0e0e1a",
                    border: "1px solid rgba(255,255,255,0.10)",
                    borderRadius: 10,
                    boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
                    fontFamily: "'JetBrains Mono', monospace",
                    overflow: "hidden",
                    transform: `scale(${transform.k})`,
                    transformOrigin: "left top",
                    pointerEvents: "auto",
                  }}
                >
                  <div className="px-3 py-2 border-b border-border text-[11px] text-muted-foreground">
                    {altPanel.options.length} alternative{altPanel.options.length !== 1 ? "s" : ""}
                  </div>
                  {altPanel.options.length === 0 ? (
                    <div className="px-3 py-4 text-[11px] text-muted-foreground text-center">No alternatives available</div>
                  ) : (
                    <div className="flex">
                      {Array.from({ length: Math.ceil(altPanel.options.length / 8) }, (_, col) =>
                        altPanel.options.slice(col * 8, col * 8 + 8)
                      ).map((chunk, col) => (
                        <div key={col} className="flex flex-col" style={{ width: 260, borderLeft: col > 0 ? "1px solid rgba(255,255,255,0.07)" : undefined }}>
                          {chunk.map((opt) => {
                            const isActive = overrides[altPanel.realItemId] === opt.recipe_id;
                            return (
                              <button
                                key={opt.recipe_id}
                                data-node
                                onClick={() => handleSelectAlt(altPanel.nodeId, opt.recipe_id)}
                                className="flex flex-col gap-1 px-3 py-2.5 text-left border-b border-border last:border-0 hover:bg-white/[0.04] transition-colors"
                                style={isActive ? { background: "rgba(34,211,238,0.07)" } : {}}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] font-medium text-foreground truncate">{opt.category_name}</span>
                                  {isActive && <span className="text-[10px] shrink-0" style={{ color: "#22d3ee" }}>active</span>}
                                </div>
                                <div className="text-[10px] text-muted-foreground truncate">
                                  {opt.inputs.map((i) => `${i.name} ×${i.qty}`).join(", ")}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}



          {/* ── Status bar ── */}
          <footer
            className="shrink-0 flex items-center justify-between border-t border-border px-5 h-7 text-[11px] text-muted-foreground"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            <div className="flex items-center gap-3">
              <span className="tabular-nums">
                x:{Math.round(-transform.x)}&nbsp;&nbsp;y:
                {Math.round(-transform.y)}
              </span>
              {selected && byId.has(selected) && (
                <>
                  <span className="opacity-30">·</span>
                  <span style={{ color: "#22d3ee" }}>
                    {byId.get(selected)!.label}
                  </span>
                  <span
                    style={{
                      color:
                        TYPE_CONFIG[byId.get(selected)!.type].dot,
                    }}
                    className="opacity-70"
                  >
                    {TYPE_CONFIG[byId.get(selected)!.type].label}
                  </span>
                </>
              )}
            </div>
            <span>
              drag to pan&nbsp;&nbsp;·&nbsp;&nbsp;scroll to zoom&nbsp;&nbsp;·&nbsp;&nbsp;▸
              children&nbsp;&nbsp;·&nbsp;&nbsp;∨ image
            </span>
          </footer>
        </div>

        {/* ── Sidebar ── */}
        <div
          className="shrink-0 flex flex-col border-l border-border"
          style={{ width: 280, background: "#0a0a0f" }}
        >
          <div className="shrink-0 h-8 flex items-center px-3 border-b border-border">
            <span
              className="text-[11px] font-medium text-muted-foreground tracking-tight"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              RAW MATERIALS
            </span>
          </div>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {Object.keys(items).length === 0 ? (
              <div className="text-center text-[10px] text-muted-foreground py-6">
                No materials
              </div>
            ) : (
              <div className="space-y-px">
                {Object.entries(items)
                  .sort(([, a], [, b]) => b.qty - a.qty)
                  .map(([key, item]) => {
                    const isActive = activeLeafItemId === key;
                    const group = leafGroupsMerged[key];
                    const instanceLabel = group && group.leaves.length > 1
                      ? ` (${group.selectedIndex + 1}/${group.leaves.length})`
                      : "";
                    return (
                      <div
                        key={key}
                        onClick={() => {
                          handleLeafClick(key);
                          setActiveLeafItemId(key);
                        }}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                          isActive
                            ? "bg-cyan-500/10 border border-cyan-500/20"
                            : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <span
                          className="text-[11px] text-foreground truncate flex-1 min-w-0"
                          title={item.name}
                        >
                          {item.name}
                        </span>
                        <span
                          className="text-[10px] tabular-nums shrink-0"
                          style={{
                            color: isActive ? "#22d3ee" : "#94a3b8",
                            fontFamily: "'JetBrains Mono', monospace",
                          }}
                        >
                          {item.qty % 1 === 0
                            ? item.qty.toFixed(0)
                            : item.qty.toFixed(1)}
                          {instanceLabel}
                        </span>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}