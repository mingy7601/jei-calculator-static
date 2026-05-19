/**
 * App.tsx — static version (no Flask backend)
 *
 * Performance improvements over previous version:
 *   1. Viewport culling   — only render nodes visible in the current pan window
 *   2. NodeCard memo      — individual cards skip re-render when props unchanged
 *   3. Pan throttle       — mousemove capped at ~60 fps via requestAnimationFrame
 *   4. Animation toggle   — AnimatePresence disabled when nodes >= 200
 *   5. Edge culling       — only draw edges where at least one endpoint is visible
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  memo,
} from "react";
import {
  ChevronRight,
  ChevronDown,
  Search,
  Loader2,
  ImageOff,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Toaster, toast } from "sonner";

import {
  getManifest,
  getEmcMap,
  getRecipes,
  preWarmShards,
  resolveItemId,
  getLoadedRecipes,
  type RecipeMap,
  type EmcMap,
} from "./data";
import { buildTree, wouldCycle, collectItemIds, type TreeNode as RawTreeNode } from "./tree";
import { sumLeafIngredients } from "./ingredients";

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeType = "root" | "module" | "component" | "resource" | "emc";

interface TreeNode {
  id: string;
  itemId?: string;
  label: string;
  type: NodeType;
  meta?: string;
  imageUrl?: string;
  children?: TreeNode[];
}

interface LeafGroup {
  itemId: string;
  leaves: LayoutNode[];
  selectedIndex: number;
}

interface AltOption {
  recipe_id: number;
  category_name: string;
  image_url: string;
  inputs: { name: string; qty: number }[];
  outputs: { id: string; name: string; qty: number }[];
}

type ItemsData = Record<string, { name: string; qty: number }>;

// ─── Layout engine ─────────────────────────────────────────────────────────────

const NODE_W = 320;
const NODE_H_BASE = 80;
const NODE_H_IMAGE = 152;
const COL_GAP = 76;
const ROW_GAP = 12;

function cardH(id: string, cardExpanded: Set<string>): number {
  return cardExpanded.has(id) ? NODE_H_BASE + NODE_H_IMAGE : NODE_H_BASE;
}

interface LayoutNode extends TreeNode {
  x: number;
  y: number;
  height: number;
}

function subtreeH(node: TreeNode, treeEx: Set<string>, cardEx: Set<string>): number {
  const myH = cardH(node.id, cardEx);
  if (!node.children?.length || !treeEx.has(node.id)) return myH;
  const ch = node.children;
  const childTotal =
    ch.reduce((s, c) => s + subtreeH(c, treeEx, cardEx), 0) + (ch.length - 1) * ROW_GAP;
  return Math.max(myH, childTotal);
}

function buildLayout(
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

// ─── Visual tokens ─────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<NodeType, { dot: string; badge: string; text: string; label: string }> = {
  root:      { dot: "#22d3ee", badge: "rgba(34,211,238,0.12)",  text: "#22d3ee", label: "root"        },
  module:    { dot: "#34d399", badge: "rgba(52,211,153,0.12)",  text: "#34d399", label: "Crafting"     },
  component: { dot: "#fb923c", badge: "rgba(251,146,60,0.12)",  text: "#fb923c", label: "MAX STEP"     },
  resource:  { dot: "#94a3b8", badge: "rgba(148,163,184,0.09)", text: "#94a3b8", label: "Raw Resource" },
  emc:       { dot: "#a855f7", badge: "rgba(168,85,247,0.12)",  text: "#a855f7", label: "EMC"          }
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

// ─── Convert raw TreeNode → display TreeNode ──────────────────────────────────

const MAX_STEPS = 5; 
function rawToDisplay(node: RawTreeNode, isRoot = false): TreeNode {
  const itemId = node.item ?? "unknown";
  const source = node.source;

  let nodeType: NodeType;
  if (isRoot) {
    nodeType = "root";
  } else if (source === "emc") {
    nodeType = "emc";
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
  const displayLabel = `${label} ×${qtyStr}`;

  const meta = nodeType === "emc" ? "emc" : (node.category_name ?? "N/A");
  const imageUrl = node.image_path ? `/static/${node.image_path}` : undefined;

  const result: TreeNode = {
    id: itemId,
    label: displayLabel,
    type: nodeType,
    meta,
    imageUrl,
  };

  if (node.inputs?.length) {
    result.children = node.inputs.map((child) => rawToDisplay(child, false));
  }

  return result;
}

// ─── Load helpers ─────────────────────────────────────────────────────────────

async function loadTree(
  query: string,
  overrides: Record<string, number> = {}
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
  const shallowTree = buildTree(itemId, recipes, 0, MAX_STEPS, { name: rootName, overrides, emcValues });
  const allIds = Array.from(collectItemIds(shallowTree));

  await preWarmShards(allIds);

  const fullRecipes = getLoadedRecipes();
  const rawTree = buildTree(itemId, fullRecipes, 0, MAX_STEPS, { name: rootName, overrides, emcValues });

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

// ─── NodeCard (memoised) ──────────────────────────────────────────────────────
// Extracted so React.memo can skip re-renders for off-screen or unchanged nodes.

interface NodeCardProps {
  node: LayoutNode;
  isTreeEx: boolean;
  isCardEx: boolean;
  isSel: boolean;
  isHighlighted: boolean;
  isAltOpen: boolean;
  altLoading: boolean;
  useAnimations: boolean;
  onSelect: () => void;
  onToggleTree: (e: React.MouseEvent) => void;
  onToggleCard: (e: React.MouseEvent) => void;
  onAltClick: (e: React.MouseEvent) => void;
}

const NodeCard = memo(
  ({
    node,
    isTreeEx,
    isCardEx,
    isSel,
    isHighlighted,
    isAltOpen,
    altLoading,
    useAnimations,
    onSelect,
    onToggleTree,
    onToggleCard,
    onAltClick,
  }: NodeCardProps) => {
    const cfg = TYPE_CONFIG[node.type];
    const hasKids = !!node.children?.length;

    const inner = (
      <div
        className="w-full h-full flex flex-col rounded-lg overflow-hidden transition-shadow duration-150"
        style={{
          background: isSel
            ? "rgba(34,211,238,0.045)"
            : isHighlighted
            ? "rgba(34,211,238,0.08)"
            : "var(--card)",
          border: `1px solid ${
            isSel
              ? "rgba(34,211,238,0.42)"
              : isHighlighted
              ? "#22d3ee"
              : "rgba(255,255,255,0.07)"
          }`,
          boxShadow: isSel
            ? "inset 3px 0 0 rgba(34,211,238,0.65), 0 4px 24px rgba(0,0,0,0.45)"
            : isHighlighted
            ? "0 0 20px rgba(34,211,238,0.35), 0 0 40px rgba(34,211,238,0.12), 0 2px 12px rgba(0,0,0,0.3)"
            : "0 2px 12px rgba(0,0,0,0.3)",
          cursor: "pointer",
        }}
      >
        {/* Content row */}
        <div className="flex-1 flex flex-col justify-center px-3.5 pt-2.5 pb-2 min-h-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cfg.dot }} />
              <span className="text-[13px] font-medium text-foreground truncate leading-tight">
                {node.label}
              </span>
            </div>
            {hasKids && (
              <button
                data-node
                className="shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded hover:bg-white/5 transition-colors"
                style={{ color: isTreeEx ? cfg.dot : "rgba(255,255,255,0.28)" }}
                onClick={onToggleTree}
                aria-label={isTreeEx ? "Collapse children" : "Expand children"}
              >
                <ChevronRight
                  size={11}
                  style={{
                    transform: isTreeEx ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 0.2s ease",
                  }}
                />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 mt-2">
            {node.meta && (
              <span
                className="text-[10px] px-1.5 py-px rounded leading-none"
                style={{ background: cfg.badge, color: cfg.text, fontFamily: "'JetBrains Mono', monospace" }}
              >
                {node.meta}
              </span>
            )}
            {node.type !== "resource" && (
              <button
                data-node
                className="shrink-0 flex items-center justify-center w-[22px] h-[22px] rounded hover:bg-white/5 transition-colors text-muted-foreground hover:text-foreground"
                style={isAltOpen ? { color: "#22d3ee" } : {}}
                onClick={onAltClick}
                aria-label="Show alternative recipes"
                title="Alternatives"
              >
                {altLoading ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <span style={{ fontSize: 11 }}>⇄</span>
                )}
              </button>
            )}
            {hasKids && (
              <span
                className="text-[10px] text-muted-foreground leading-none"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {node.children!.length}&thinsp;children
              </span>
            )}
          </div>
        </div>

        {/* Image panel */}
        <AnimatePresence>
          {isCardEx && (
            <motion.div
              key="img"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="border-t border-border overflow-hidden"
              style={{ height: NODE_H_IMAGE }}
            >
              {node.imageUrl ? (
                <img
                  src={node.imageUrl}
                  alt={node.label}
                  className="w-full h-full object-contain"
                  draggable={false}
                />
              ) : (
                <div
                  className="w-full h-full flex flex-col items-center justify-center gap-2"
                  style={{ background: "rgba(255,255,255,0.02)" }}
                >
                  <ImageOff size={18} className="text-muted-foreground opacity-40" />
                  <span
                    className="text-[10px] text-muted-foreground opacity-50"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    no image
                  </span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Expand strip */}
        <button
          data-node
          className="shrink-0 flex items-center justify-center border-t border-border transition-colors duration-150 hover:bg-white/[0.03]"
          style={{ height: 22 }}
          onClick={onToggleCard}
          aria-label={isCardEx ? "Hide image" : "Show image"}
        >
          <ChevronDown
            size={10}
            className="text-muted-foreground"
            style={{
              transform: isCardEx ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.22s ease",
            }}
          />
        </button>
      </div>
    );

    // Shared positional style
    const posStyle: React.CSSProperties = {
      position: "absolute",
      left: 0,
      top: 0,
      width: NODE_W,
    };

    if (useAnimations) {
      return (
        <motion.div
          key={node.id}
          initial={{ opacity: 0, scale: 0.88, x: node.x, y: node.y, height: node.height }}
          animate={{ opacity: 1, scale: 1,   x: node.x, y: node.y, height: node.height }}
          exit={{ opacity: 0, scale: 0.88 }}
          transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
          style={posStyle}
          data-node
          onClick={onSelect}
        >
          {inner}
        </motion.div>
      );
    }

    return (
      <div
        key={node.id}
        style={{ ...posStyle, transform: `translate(${node.x}px, ${node.y}px)`, height: node.height }}
        data-node
        onClick={onSelect}
      >
        {inner}
      </div>
    );
  },
  // Custom equality — only re-render when something the card actually shows has changed
  (prev, next) =>
    prev.node.id         === next.node.id &&
    prev.node.x          === next.node.x &&
    prev.node.y          === next.node.y &&
    prev.node.height     === next.node.height &&
    prev.isTreeEx        === next.isTreeEx &&
    prev.isCardEx        === next.isCardEx &&
    prev.isSel           === next.isSel &&
    prev.isHighlighted   === next.isHighlighted &&
    prev.isAltOpen       === next.isAltOpen &&
    prev.altLoading      === next.altLoading &&
    prev.useAnimations   === next.useAnimations
);

// ─── Main component ───────────────────────────────────────────────────────────

const INIT_EXPANDED = new Set<string>(["root", "frontend", "gateway", "services", "data"]);
const VIEWPORT_PAD = 120;

export default function App() {
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [altPanel, setAltPanel] = useState<{
    nodeId: string;
    realItemId: string;
    x: number;
    y: number;
    options: AltOption[];
  } | null>(null);
  const [altLoading, setAltLoading] = useState(false);

  const [treeRoot, setTreeRoot] = useState<TreeNode | null>(null);
  const [items, setItems] = useState<ItemsData>({});
  const [loadedRecipes, setLoadedRecipes] = useState<RecipeMap>({});

  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(INIT_EXPANDED);
  const [cardExpanded, setCardExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  // Sidebar raw material → leaf node cycling
  const [leafGroups, setLeafGroups] = useState<Record<string, LeafGroup>>({});

  // Highlight search
  const [highlightSearch, setHighlightSearch] = useState("");
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const [highlightMatchList, setHighlightMatchList] = useState<LayoutNode[]>([]);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [pan, setPan] = useState({ x: 48, y: 56 });
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [viewportSize, setViewportSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  const isPanning = useRef(false);
  const dragOrigin = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  // for panel throttling
  const rafId = useRef<number | null>(null);
  const pendingPan = useRef({ x: 48, y: 56 });
  const [panActive, setPanActive] = useState(false);

  // Track viewport size for culling
  useEffect(() => {
    const onResize = () => setViewportSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Load manifest + default item on mount
  useEffect(() => {
    const defaultItem = "mythic machine case";
    setSearchQuery(defaultItem);
    setIsLoading(true);
    (async () => {
      try {
        await getManifest();
        const { displayTree, rawTree, recipes } = await loadTree(defaultItem);
        const unique = assignUniqueIds(displayTree);
        setTreeRoot(unique);
        setTreeExpanded(new Set([unique.id]));
        setLoadedRecipes(recipes);
        setItems(sumLeafIngredients(rawTree));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load tree");
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const nodes = useMemo(
    () => (treeRoot ? buildLayout(treeRoot, 0, 0, treeExpanded, cardExpanded) : []),
    [treeRoot, treeExpanded, cardExpanded]
  );
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // ── Performance flags ──────────────────────────────────────────────────────
  const useAnimations = nodes.length < 200;

  // ── Viewport culling ───────────────────────────────────────────────────────
  // Only render nodes whose bounding box overlaps the visible viewport.
  const visibleNodes = useMemo(() => {
    const { w, h } = viewportSize;
    return nodes.filter(
      (n) =>
        n.x + pan.x < w + VIEWPORT_PAD &&
        n.x + pan.x + NODE_W > -VIEWPORT_PAD &&
        n.y + pan.y < h + VIEWPORT_PAD &&
        n.y + pan.y + n.height > -VIEWPORT_PAD
    );
  }, [nodes, pan, viewportSize]);

  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  // ── Count leaves per item from the full tree (even when collapsed) ──────
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

  // ── Leaf groups for cycling (from expanded nodes only) ──────────────────
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

  // Merge with user state (selectedIndex)
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

  // ── Which raw materials are EMC-type? (from full tree, not just expanded) ─
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
          // Only draw edge if at least one endpoint is visible
          if (byId.has(c.id) && (visibleIds.has(n.id) || visibleIds.has(c.id))) {
            const isHighlighted = highlightedIds.has(n.id) || highlightedIds.has(c.id);
            result.push({ fid: n.id, tid: c.id, isHighlighted });
          }
        }
      }
    }
    return result;
  }, [nodes, byId, treeExpanded, visibleIds, highlightedIds]);

  const canvasW = nodes.reduce((m, n) => Math.max(m, n.x + NODE_W + 120), 600);
  const canvasH = nodes.reduce((m, n) => Math.max(m, n.y + n.height + 120), 400);
  const totalNodes = useMemo(() => (treeRoot ? countAll(treeRoot) : 0), [treeRoot]);

  // ── Callbacks ──────────────────────────────────────────────────────────────

  const toggleTree = useCallback((id: string) => {
    setTreeExpanded((p) => {
      const s = new Set(p);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }, []);

  const toggleCard = useCallback((id: string) => {
    setCardExpanded((p) => {
      const s = new Set(p);
      s.has(id) ? s.delete(id) : s.add(id);
      return s;
    });
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q || isLoading) return;
    setIsLoading(true);
    try {
      const { displayTree, rawTree, recipes } = await loadTree(q, {});
      const unique = assignUniqueIds(displayTree);
      setTreeRoot(unique);
      setTreeExpanded(new Set([unique.id]));
      setCardExpanded(new Set());
      setSelected(null);
      setPan({ x: 48, y: 56 });
      setLoadedRecipes(recipes);
      setItems(sumLeafIngredients(rawTree));
      setOverrides({});
      toast.success(`Loaded: ${displayTree.label}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load tree");
    } finally {
      setIsLoading(false);
    }
  };

  // ── Pan — throttled to one setState per animation frame ───────────────────

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-node]")) return;
      setAltPanel(null);
      isPanning.current = true;
      setPanActive(true);
      dragOrigin.current = { mx: e.clientX, my: e.clientY, px: pan.x, py: pan.y };
    },
    [pan]
  );

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    pendingPan.current = {
      x: dragOrigin.current.px + e.clientX - dragOrigin.current.mx,
      y: dragOrigin.current.py + e.clientY - dragOrigin.current.my,
    };
    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(() => {
        setPan({ ...pendingPan.current });
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
      // Flush any pending pan so final position is accurate
      setPan({ ...pendingPan.current });
    }
  }, []);

  // ── Alt panel ──────────────────────────────────────────────────────────────

  const handleAltClick = useCallback(
    async (e: React.MouseEvent, node: LayoutNode) => {
      e.stopPropagation();
      if (altPanel?.nodeId === node.id) {
        setAltPanel(null);
        return;
      }
      setAltLoading(true);
      setAltPanel(null);
      try {
        const realId = node.itemId ?? node.id;
        await getRecipes(realId);
        const recipes = getLoadedRecipes();
        const options = getAlternatives(realId, recipes);
        setAltPanel({ nodeId: node.id, realItemId: realId, x: node.x + NODE_W + 8, y: node.y, options });
      } catch {
        toast.error("Failed to load alternatives");
      } finally {
        setAltLoading(false);
      }
    },
    [altPanel]
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
      // If no leaves exist for this item in the full tree, nothing to do
      if (!treeRoot || (leafCountPerItem.get(itemId) ?? 0) === 0) return;

      const group = leafGroupsMerged[itemId];
      const hasVisibleLeaves = group && group.leaves.length > 0;

      // If leaves aren't visible (tree collapsed), expand the path to the first leaf
      if (!hasVisibleLeaves) {
        const firstLeaf = findFirstLeaf(treeRoot, itemId);
        if (firstLeaf) {
          const ancestors = new Set<string>();
          function walk(n: TreeNode) {
            if (n.id === firstLeaf.id) { ancestors.add(n.id); return true; }
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
        }
        return; // Will re-enter after tree expands
      }

      const nextIndex = (group.selectedIndex + 1) % group.leaves.length;
      setLeafGroups((prev) => ({
        ...prev,
        [itemId]: { ...group, selectedIndex: nextIndex },
      }));

      const targetNode = group.leaves[nextIndex];

      // Expand all ancestor nodes on the path to the target leaf
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

      // Center the node in the viewport: screenPos = nodePos + pan
      // We want screenPos = viewportSize / 2, so pan = viewportSize/2 - nodePos
      setPan({
        x: viewportSize.w / 2 - targetNode.x,
        y: viewportSize.h / 2 - targetNode.y,
      });
      setSelected(targetNode.id);
    },
    [leafGroupsMerged, viewportSize, treeRoot, leafCountPerItem]
  );

  // ── Find first leaf with matching itemId in a tree ──────────────────────
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
        const { displayTree, rawTree, recipes } = await loadTree(searchQuery, newOverrides);
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
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to reload tree");
      } finally {
        setIsLoading(false);
      }
    },
    [overrides, searchQuery, altPanel, treeExpanded, cardExpanded, byId]
  );

  // ── Highlight search (applied on Enter, cycles on subsequent Enter) ────
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

      // If we already have a match list, cycle to next match
      if (highlightMatchList.length > 0) {
        const nextIdx = (highlightIdx + 1) % highlightMatchList.length;
        setHighlightIdx(nextIdx);
        const target = highlightMatchList[nextIdx];
        setPan({
          x: viewportSize.w / 2 - target.x,
          y: viewportSize.h / 2 - target.y,
        });
        return;
      }

      // Compute new matches
      const matches: LayoutNode[] = [];
      for (const n of nodes) {
        if (
          n.label.toLowerCase().includes(q) ||
          (n.itemId && n.itemId.toLowerCase().includes(q))
        ) {
          matches.push(n);
        }
      }
      setHighlightMatchList(matches);
      setHighlightedIds(new Set(matches.map((n) => n.id)));
      setHighlightIdx(0);

      if (matches.length > 0) {
        setPan({
          x: viewportSize.w / 2 - matches[0].x,
          y: viewportSize.h / 2 - matches[0].y,
        });
      }
    },
    [nodes, highlightMatchList, highlightIdx, viewportSize]
  );

  const handleHighlightClear = useCallback(() => {
    setHighlightSearch("");
    setHighlightedIds(new Set());
    setHighlightMatchList([]);
    setHighlightIdx(-1);
  }, []);

  const clearHighlightSearch = useCallback(() => {
    setHighlightSearch("");
    setHighlightedIds(new Set());
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

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
        <div className="flex-1 flex flex-col min-w-0">

          {/* ── Toolbar ── */}
          <header className="shrink-0 flex items-center gap-3 border-b border-border px-4 h-12">
            <div className="flex items-center gap-2 shrink-0">
              <span className="w-2 h-2 rounded-full" style={{ background: "#22d3ee", boxShadow: "0 0 8px rgba(34,211,238,0.7)" }} />
              <span className="text-sm font-semibold tracking-tight whitespace-nowrap">Crafting Calculator</span>
            </div>

            <div className="w-px h-5 bg-border shrink-0" />

            <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 min-w-0">
              <div className="relative flex-1 min-w-0 max-w-md">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search or enter an ID to load as root…"
                  disabled={isLoading}
                  className="w-full h-7 pl-8 pr-3 text-xs rounded border border-border bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[rgba(34,211,238,0.4)] focus:ring-1 focus:ring-[rgba(34,211,238,0.15)] transition-colors disabled:opacity-50"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                />
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
              {(
                [
                  { label: "Hide images", fn: () => setCardExpanded(new Set()) },
                  { label: "Expand all",  fn: () => treeRoot && setTreeExpanded(collectAllIds(treeRoot)) },
                  { label: "Collapse all",fn: () => treeRoot && setTreeExpanded(new Set([treeRoot.id])) },
                  { label: "Reset view",  fn: () => setPan({ x: 48, y: 56 }) },
                ] as const
              ).map(({ label, fn }) => (
                <button key={label} onClick={fn} className="text-xs px-2.5 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors">
                  {label}
                </button>
              ))}
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
              type="text"
              value={highlightSearch}
              onChange={(e) => setHighlightSearch(e.target.value)}
              onKeyDown={handleHighlightKeyDown}
              placeholder="Press Enter to highlight nodes…"
              className="flex-1 h-5 px-2 text-[11px] rounded border border-border bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[rgba(34,211,238,0.4)] transition-colors"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            />
            {highlightedIds.size > 0 && (
              <>
                <span className="text-[10px] text-muted-foreground tabular-nums" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                  {highlightedIds.size} match{highlightedIds.size !== 1 ? "es" : ""}
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
            >
              {/* Dot grid */}
              <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>
                <defs>
                  <pattern id="dotgrid" width={28} height={28} x={pan.x % 28} y={pan.y % 28} patternUnits="userSpaceOnUse">
                    <circle cx={1} cy={1} r={1} fill="rgba(255,255,255,0.045)" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#dotgrid)" />
              </svg>

              {/* Pan layer */}
              <div style={{ position: "absolute", transform: `translate(${pan.x}px, ${pan.y}px)`, width: canvasW, height: canvasH }}>
                {/* SVG edges */}
                <svg style={{ position: "absolute", inset: 0, width: canvasW, height: canvasH, overflow: "visible", pointerEvents: "none" }} aria-hidden>
                  {edges.map(({ fid, tid, isHighlighted }) => {
                    const f = byId.get(fid);
                    const t = byId.get(tid);
                    if (!f || !t) return null;
                    const x1 = f.x + NODE_W;
                    const y1 = f.y + f.height / 2;
                    const x2 = t.x;
                    const y2 = t.y + t.height / 2;
                    const mx = (x1 + x2) / 2;
                    const isActive = selected === fid || selected === tid;
                    const strokeColor = isActive
                      ? "#22d3ee"
                      : isHighlighted
                      ? "rgba(34,211,238,0.55)"
                      : "rgba(255,255,255,0.085)";
                    const strokeWidth = isActive ? 2 : isHighlighted ? 1.5 : 1;
                    return (
                      <path
                        key={`${fid}-${tid}`}
                        d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                        fill="none"
                        stroke={strokeColor}
                        strokeWidth={strokeWidth}
                      />
                    );
                  })}
                </svg>

                {/* Alt panel */}
                {altPanel && (
                  <div
                    data-node
                    style={{
                      position: "absolute", left: altPanel.x, top: altPanel.y,
                      width: Math.ceil(altPanel.options.length / 8) * 260, zIndex: 50,
                      background: "#0e0e1a", border: "1px solid rgba(255,255,255,0.10)",
                      borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
                      fontFamily: "'JetBrains Mono', monospace", overflow: "hidden",
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

                {/* Nodes */}
                {useAnimations ? (
                  <AnimatePresence>
                    {visibleNodes.map((node) => (
                      <NodeCard
                        key={node.id}
                        node={node}
                        isTreeEx={treeExpanded.has(node.id)}
                        isCardEx={cardExpanded.has(node.id)}
                        isSel={selected === node.id}
                        isHighlighted={highlightedIds.has(node.id)}
                        isAltOpen={altPanel?.nodeId === node.id}
                        altLoading={altLoading && altPanel === null}
                        useAnimations={useAnimations}
                        onSelect={() => setSelected(selected === node.id ? null : node.id)}
                        onToggleTree={(e) => { e.stopPropagation(); toggleTree(node.id); }}
                        onToggleCard={(e) => { e.stopPropagation(); toggleCard(node.id); }}
                        onAltClick={(e) => handleAltClick(e, node)}
                      />
                    ))}
                  </AnimatePresence>
                ) : (
                  <>
                    {visibleNodes.map((node) => (
                      <NodeCard
                        key={node.id}
                        node={node}
                        isTreeEx={treeExpanded.has(node.id)}
                        isCardEx={cardExpanded.has(node.id)}
                        isSel={selected === node.id}
                        isHighlighted={highlightedIds.has(node.id)}
                        isAltOpen={altPanel?.nodeId === node.id}
                        altLoading={altLoading && altPanel === null}
                        useAnimations={useAnimations}
                        onSelect={() => setSelected(selected === node.id ? null : node.id)}
                        onToggleTree={(e) => { e.stopPropagation(); toggleTree(node.id); }}
                        onToggleCard={(e) => { e.stopPropagation(); toggleCard(node.id); }}
                        onAltClick={(e) => handleAltClick(e, node)}
                      />
                    ))}
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── Status bar ── */}
          <footer className="shrink-0 flex items-center justify-between border-t border-border px-5 h-7 text-[11px] text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            <div className="flex items-center gap-3">
              <span className="tabular-nums">x:{Math.round(-pan.x)}&nbsp;&nbsp;y:{Math.round(-pan.y)}</span>
              {selected && byId.has(selected) && (
                <>
                  <span className="opacity-30">·</span>
                  <span style={{ color: "#22d3ee" }}>{byId.get(selected)!.label}</span>
                  <span style={{ color: TYPE_CONFIG[byId.get(selected)!.type].dot }} className="opacity-70">
                    {TYPE_CONFIG[byId.get(selected)!.type].label}
                  </span>
                </>
              )}
            </div>
            <span>drag to pan&nbsp;&nbsp;·&nbsp;&nbsp;click to select&nbsp;&nbsp;·&nbsp;&nbsp;▸ children&nbsp;&nbsp;·&nbsp;&nbsp;∨ image</span>
          </footer>
        </div>

        {/* ── Sidebar ── */}
        <div className="shrink-0 flex flex-col border-l border-border" style={{ width: 460, background: "#0a0a0f" }}>
          <div className="shrink-0 h-12 flex items-center px-4 border-b border-border">
            <span className="w-1.5 h-1.5 rounded-full mr-2" style={{ background: "#94a3b8" }} />
            <span className="text-lg font-semibold tracking-tight">Raw Materials</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {Object.keys(items).length === 0 ? (
              <div className="text-center text-xs text-muted-foreground py-8">No materials loaded</div>
            ) : (
              <div className="space-y-1.5">
                {Object.entries(items)
                  .sort(([, a], [, b]) => b.qty - a.qty)
                  .map(([key, item]) => {
                    const group = leafGroupsMerged[key];
                    const leafCount = leafCountPerItem.get(key) ?? 0;
                    const cycleIdx = group ? group.selectedIndex : -1;
                    const hasEmc = emcItems.has(key);
                    return (
                    <div
                      key={key}
                      className="flex items-center px-3 py-2 rounded-lg border border-border cursor-pointer hover:bg-white/[0.03] transition-colors"
                      style={{ background: "var(--card)" }}
                      onClick={() => handleLeafClick(key)}
                    >
                      <span className="text-xs text-foreground truncate flex-1 min-w-0 mr-2" title={item.name}>{item.name}</span>
                      <span className="text-[10px] shrink-0 px-1 py-px rounded" style={{ background: "rgba(148,163,184,0.1)", color: "#94a3b8", fontFamily: "'JetBrains Mono', monospace" }}>
                        ×{item.qty % 1 === 0 ? item.qty.toFixed(0) : item.qty.toFixed(1)}
                      </span>
                      {leafCount > 0 && (
                        <span
                          className="text-[10px] shrink-0 px-1 py-px rounded"
                          style={{ background: "rgba(34,211,238,0.1)", color: "#22d3ee", fontFamily: "'JetBrains Mono', monospace" }}
                          title="Click to cycle through nodes"
                        >
                          {group ? `${cycleIdx + 1}/${leafCount}` : `1/${leafCount}`}
                        </span>
                      )}
                      <span
                        className="text-[10px] shrink-0 px-1 py-px rounded"
                        style={{
                          background: hasEmc ? "rgba(168,85,247,0.15)" : "rgba(255,255,255,0.03)",
                          color: hasEmc ? "#a855f7" : "transparent",
                          fontFamily: "'JetBrains Mono', monospace",
                        }}
                        title={hasEmc ? "Has EMC value" : undefined}
                      >
                        emc
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="shrink-0 h-7 flex items-center px-4 border-t border-border text-[11px] text-muted-foreground" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            {Object.keys(items).length} material{Object.keys(items).length !== 1 ? "s" : ""}
          </div>
        </div>
      </div>
    </>
  );
}