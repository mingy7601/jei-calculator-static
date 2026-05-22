/**
 * App.tsx — canvas-rendered version
 *
 * Performance architecture:
 *   1. Canvas layer — all edges + node rectangles drawn on a single <canvas>
 *      (O(n) draw calls instead of O(n) DOM nodes)
 *   2. HTML overlay — only the hovered/selected node rendered as HTML
 *      (keeps image panels, text selection, and click interaction working)
 *   3. Pan + zoom — transform matrix with scroll-wheel zoom
 *   4. Viewport culling — only draw visible nodes on canvas
 *   5. Lazy tree loading — only build visible subtree initially, expand on demand
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useLayoutEffect,
} from "react";
import { Search, Loader2 } from "lucide-react";
import { Toaster, toast } from "sonner";

import {
  getManifest,
  getEmcMap,
  getRecipes,
  preWarmShards,
  resolveItemId,
  getLoadedRecipes,
  getPassivedList,
  savePassivedList,
  loadPassivedList,
  type RecipeMap,
  type EmcMap,
} from "./data";
import { buildTree, wouldCycle, collectItemIds, type TreeNode as RawTreeNode } from "./tree";
import { sumLeafIngredients } from "./ingredients";
import { loadState, saveState, clearState } from "./state-persist";

// ─── Types ────────────────────────────────────────────────────────────────────

type NodeType = "root" | "service" | "module" | "component" | "resource" | "emc" | "passived";

interface TreeNode {
  id: string;
  itemId?: string;
  label: string;
  type: NodeType;
  meta?: string;
  imageUrl?: string;
  qty?: number;
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

const NODE_W = 300;
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

// ─── Transform helpers (pan + zoom) ──────────────────────────────────────────

interface Transform {
  x: number;
  y: number;
  k: number; // zoom scale
}

function screenToCanvas(tx: Transform, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - tx.x) / tx.k,
    y: (sy - tx.y) / tx.k,
  };
}

function canvasToScreen(tx: Transform, cx: number, cy: number): { x: number; y: number } {
  return {
    x: cx * tx.k + tx.x,
    y: cy * tx.k + tx.y,
  };
}

// ─── Visual tokens ─────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<NodeType, { dot: string; badge: string; text: string; label: string; bg: string }> = {
  root:      { dot: "#22d3ee", badge: "rgba(34,211,238,0.12)",  text: "#22d3ee", label: "root",        bg: "rgba(34,211,238,0.06)" },
  service:   { dot: "#a78bfa", badge: "rgba(167,139,250,0.12)", text: "#a78bfa", label: "service",     bg: "rgba(167,139,250,0.06)" },
  module:    { dot: "#34d399", badge: "rgba(52,211,153,0.12)",  text: "#34d399", label: "Crafting",     bg: "rgba(52,211,153,0.06)" },
  component: { dot: "#fb923c", badge: "rgba(251,146,60,0.12)",  text: "#fb923c", label: "MAX STEP",     bg: "rgba(251,146,60,0.06)" },
  resource:  { dot: "#94a3b8", badge: "rgba(148,163,184,0.09)", text: "#94a3b8", label: "Raw Resource", bg: "rgba(148,163,184,0.04)" },
  emc:       { dot: "#a855f7", badge: "rgba(168,85,247,0.12)",  text: "#a855f7", label: "EMC",          bg: "rgba(168,85,247,0.06)" },
  passived:  { dot: "#facc15", badge: "rgba(250,204,21,0.12)",  text: "#facc15", label: "Passived",     bg: "rgba(250,204,21,0.06)" },
};

// Canvas color tokens (dark theme)
const CANVAS_BG = "#0d0d14";
const CANVAS_GRID = "rgba(255,255,255,0.035)";
const CANVAS_EDGE = "rgba(255,255,255,0.085)";
const CANDS_EDGE_HL = "rgba(34,211,238,0.55)";
const CANVAS_EDGE_SEL = "#22d3ee";
const NODE_BORDER = "rgba(255,255,255,0.07)";
const NODE_BORDER_SEL = "rgba(34,211,238,0.42)";
const NODE_BORDER_HL = "#22d3ee";
const NODE_RADIUS = 10;

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

const MAX_STEPS = 10;
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

  const meta = nodeType === "emc" ? "emc" : (nodeType === "passived" ? "passived" : (node.category_name ?? "N/A"));
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
  const shallowTree = buildTree(itemId, recipes, 0, MAX_STEPS, { name: rootName, overrides, emcValues, passived });
  const allIds = Array.from(collectItemIds(shallowTree));

  await preWarmShards(allIds);

  const fullRecipes = getLoadedRecipes();
  const rawTree = buildTree(itemId, fullRecipes, 0, MAX_STEPS, { name: rootName, overrides, emcValues, passived });

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

// ─── Canvas renderer ──────────────────────────────────────────────────────────

interface CanvasRenderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
}

function initCanvas(canvas: HTMLCanvasElement): CanvasRenderer {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, width: rect.width, height: rect.height, dpr };
}

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, tx: Transform) {
  const gridSize = 28 * tx.k;
  const offsetX = tx.x % gridSize;
  const offsetY = tx.y % gridSize;

  ctx.fillStyle = CANVAS_GRID;
  for (let x = offsetX; x < w; x += gridSize) {
    for (let y = offsetY; y < h; y += gridSize) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  x1: number, y1: number,
  x2: number, y2: number,
  isHl: boolean,
  isSel: boolean
) {
  const mx = (x1 + x2) / 2;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.bezierCurveTo(mx, y1, mx, y2, x2, y2);

  if (isSel) {
    ctx.strokeStyle = CANVAS_EDGE_SEL;
    ctx.lineWidth = 2;
  } else if (isHl) {
    ctx.strokeStyle = CANDS_EDGE_HL;
    ctx.lineWidth = 1.5;
  } else {
    ctx.strokeStyle = CANVAS_EDGE;
    ctx.lineWidth = 1;
  }
  ctx.stroke();
}

// ─── Hex → rgba helper ───────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Interactive element hit-boxes for a node ────────────────────────────────

interface NodeHitBoxes {
  expandTriangle: { x: number; y: number; w: number; h: number } | null;
  altDoubleArrow: { x: number; y: number; w: number; h: number } | null;
  toggleStrip: { x: number; y: number; w: number; h: number } | null;
}

function getNodeHitBoxes(
  node: LayoutNode,
  tx: Transform
): NodeHitBoxes {
  const s = canvasToScreen(tx, node.x, node.y);
  const sw = NODE_W * tx.k;
  const sh = node.height * tx.k;

  const expandY = s.y + 18;

  return {
    expandTriangle: {
      x: s.x + sw - 40 * tx.k,
      y: expandY - 10 * tx.k,
      w: 24 * tx.k,
      h: 20 * tx.k,
    },
    altDoubleArrow: {
      x: s.x + 14 * tx.k,
      y: s.y + 38 * tx.k,
      w: 28 * tx.k,
      h: 16 * tx.k,
    },
    toggleStrip: {
      x: s.x,
      y: s.y + sh - 22 * tx.k,
      w: sw,
      h: 22 * tx.k,
    },
  };
}

function isPointInCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r ** 2;
}

function isPointInRect(px: number, py: number, rx: number, ry: number, rw: number, rh: number): boolean {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

// ─── Canvas node renderer ────────────────────────────────────────────────────

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: LayoutNode,
  isSelected: boolean,
  isHovered: boolean,
  isTreeEx: boolean,
  isCardEx: boolean,
  borderColor: string,
  bgColor: string,
  dotColor: string
) {
  const x = node.x;
  const y = node.y;
  const w = NODE_W;
  const h = node.height;

  // ── Background ──
  ctx.fillStyle = isSelected
    ? "rgba(34,211,238,0.045)"
    : bgColor;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fill();

  // ── Border ──
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = isSelected || isHovered ? 1.5 : 1;
  ctx.stroke();

  // ── Type dot ──
  ctx.fillStyle = dotColor;
  ctx.beginPath();
  ctx.arc(x + 14, y + 18, 3, 0, Math.PI * 2);
  ctx.fill();

  // ── Label ──
  ctx.fillStyle = isSelected || isHovered ? dotColor : "rgba(255,255,255,0.9)";
  ctx.font = "500 13px Inter, sans-serif";
  ctx.textBaseline = "middle";
  const label = node.label;
  const maxW = w - 60;
  let displayLabel = label;
  if (ctx.measureText(label).width > maxW) {
    while (
      ctx.measureText(displayLabel + "…").width > maxW &&
      displayLabel.length > 0
    ) {
      displayLabel = displayLabel.slice(0, -1);
    }
    displayLabel += "…";
  }
  ctx.fillText(displayLabel, x + 24, y + 18);

  // ── Show alternatives button (⇅) ──
  const altBtnW = 28;
  const altBtnH = 16;
  const altBtnX = x + 14;
  const altBtnY = y + 38;

  // Button background
  ctx.fillStyle = hexToRgba(dotColor, 0.12);
  ctx.beginPath();
  ctx.roundRect(altBtnX, altBtnY, altBtnW, altBtnH, 4);
  ctx.fill();

  // Button border
  ctx.strokeStyle = hexToRgba(dotColor, 0.2);
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.roundRect(altBtnX, altBtnY, altBtnW, altBtnH, 4);
  ctx.stroke();

  // Double-arrow symbol
  ctx.fillStyle = dotColor;
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("⇅", altBtnX + altBtnW / 2, altBtnY + altBtnH / 2);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // ── Meta badge (to the right of alternatives button) ──
  if (node.meta) {
    const badgeText = node.meta;
    const badgeW = ctx.measureText(badgeText).width + 10;
    const badgeH = 16;
    const badgeX = altBtnX + altBtnW + 6;
    const badgeY = altBtnY;

    ctx.fillStyle = hexToRgba(dotColor, 0.12);
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 3);
    ctx.fill();

    ctx.fillStyle = dotColor;
    ctx.font = "500 11x 'JetBrains Mono', monospace";
    ctx.fillText(badgeText, badgeX + 4, badgeY + 12);
  }

  // ── Children count ──
  if (node.children?.length) {
    const childText = `${node.children.length} children`;
    const textW = ctx.measureText(childText).width;
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "400 10px 'JetBrains Mono', monospace";
    ctx.fillText(childText, x + w - textW - 14, y + 48);
  }

  // ── Expand/collapse indicator ──
  if (node.children?.length) {
    const triCx = x + w - 28;
    const triCy = y + 18;
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    if (isTreeEx) {
      // Expanded: chevron down
      ctx.moveTo(triCx - 4, triCy - 2);
      ctx.lineTo(triCx, triCy + 2);
      ctx.lineTo(triCx + 4, triCy - 2);
    } else {
      // Collapsed: chevron right
      ctx.moveTo(triCx - 2, triCy - 4);
      ctx.lineTo(triCx + 2, triCy);
      ctx.lineTo(triCx - 2, triCy + 4);
    }
    ctx.closePath();
    ctx.fill();
  }

  // ── Image panel (if expanded) ──
  if (isCardEx) {
    const imgY = y + NODE_H_BASE;
    const imgH = NODE_H_IMAGE;

    // Separator line
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, imgY);
    ctx.lineTo(x + w, imgY);
    ctx.stroke();

    // Image background
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(x, imgY, w, imgH);
  }

  // ── Toggle strip at bottom ──
  const stripH = 22;
  const stripY = y + h - stripH;

  // Separator line
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, stripY);
  ctx.lineTo(x + w, stripY);
  ctx.stroke();

  // Chevron down icon
  const chevCx = x + w / 2;
  const chevCy = stripY + stripH / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  if (isCardEx) {
    // Up chevron when expanded
    ctx.moveTo(chevCx - 5, chevCy + 2);
    ctx.lineTo(chevCx, chevCy - 2);
    ctx.lineTo(chevCx + 5, chevCy + 2);
  } else {
    // Down chevron when collapsed
    ctx.moveTo(chevCx - 5, chevCy - 2);
    ctx.lineTo(chevCx, chevCy + 2);
    ctx.lineTo(chevCx + 5, chevCy - 2);
  }
  ctx.stroke();
}

// ─── Main component ───────────────────────────────────────────────────────────

const VIEWPORT_PAD = 120;

export default function App() {
  // ── Load persisted state on mount ────────────────────────────────────────
  const saved = useMemo(() => loadState(), []);

  const [overrides, setOverrides] = useState<Record<string, number>>(
    saved?.overrides ?? {}
  );
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

  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set());
  const [cardExpanded, setCardExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(saved?.selected ?? null);

  const [leafGroups, setLeafGroups] = useState<Record<string, LeafGroup>>({});

  // Track which sidebar item is currently "active" (showing which instance)
  const [activeLeafItemId, setActiveLeafItemId] = useState<string | null>(null);

  // Highlight search
  const [highlightSearch, setHighlightSearch] = useState("");
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const [highlightMatchList, setHighlightMatchList] = useState<LayoutNode[]>([]);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const lastSearchQuery = useRef("");

  // Pan + zoom transform
  const [transform, setTransform] = useState<Transform>({ x: 48, y: 56, k: 1 });

  const [searchQuery, setSearchQuery] = useState(saved?.searchQuery ?? "");
  const [isLoading, setIsLoading] = useState(false);

  // ── Passived list ───────────────────────────────────────────────────────
  const [passivedSet, setPassivedSet] = useState<Set<string>>(new Set());
  const [passivedList, setPassivedList] = useState<string[]>([]);
  const [showPassivedPanel, setShowPassivedPanel] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isPanning = useRef(false);
  const dragOrigin = useRef({ mx: 0, my: 0, px: 0, py: 0 });
  const rafId = useRef<number | null>(null);
  const pendingTransform = useRef<Transform>({ x: 48, y: 56, k: 1 });
  const [panActive, setPanActive] = useState(false);

  // Hover state
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // ── Persist state to localStorage ────────────────────────────────────────
  const persistState = useCallback(() => {
    saveState({
      v: 1,
      searchQuery,
      overrides,
      selected,
    });
  }, [searchQuery, overrides, selected]);

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
      setTransform({ x: 48, y: 56, k: 1 });
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
    async (newPassived: Set<string>) => {
      const q = searchQuery.trim();
      if (!q) return;
      setIsLoading(true);
      try {
        const { displayTree, rawTree, recipes } = await loadTree(q, overrides, newPassived);
        const unique = assignUniqueIds(displayTree);
        setTreeRoot(unique);
        setTreeExpanded(collectAllIds(unique));
        setCardExpanded(new Set());
        setSelected(null);
        setActiveLeafItemId(null);
        setTransform({ x: 48, y: 56, k: 1 });
        setLoadedRecipes(recipes);
        setItems(sumLeafIngredients(rawTree));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to reload tree");
      } finally {
        setIsLoading(false);
      }
    },
    [searchQuery, overrides]
  );

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
            rebuildTreeWithPassived(new Set(next));
          } else {
            const next = [...passivedList, realItemId];
            setPassivedList(next);
            savePassivedList(next);
            setPassivedSet(new Set(next));
            toast.success(`"${realItemId}" added to passived — children hidden`);
            rebuildTreeWithPassived(new Set(next));
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

      setTransform({
        x: (containerRef.current?.clientWidth || window.innerWidth) / 2 - targetNode.x,
        y: (containerRef.current?.clientHeight || window.innerHeight) / 2 - targetNode.y,
        k: transform.k,
      });
      setSelected(targetNode.id);
    },
    [leafGroupsMerged, treeRoot, leafCountPerItem, transform]
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

      // If query changed since last search, recompute matches
      if (q !== lastSearchQuery.current) {
        lastSearchQuery.current = q;
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
        setTransform({
          x: (containerRef.current?.clientWidth || window.innerWidth) / 2 - matches[0].x,
          y: (containerRef.current?.clientHeight || window.innerHeight) / 2 - matches[0].y,
          k: transform.k,
        });
        setSelected(matches[0].id);
        setActiveLeafItemId(null);
        return;
      }

      if (highlightMatchList.length > 0) {
        const nextIdx = (highlightIdx + 1) % highlightMatchList.length;
        setHighlightIdx(nextIdx);
        const target = highlightMatchList[nextIdx];
        setTransform({
          x: (containerRef.current?.clientWidth || window.innerWidth) / 2 - target.x,
          y: (containerRef.current?.clientHeight || window.innerHeight) / 2 - target.y,
          k: transform.k,
        });
        setSelected(target.id);
        setActiveLeafItemId(null);
        return;
      }

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
        setTransform({
          x: (containerRef.current?.clientWidth || window.innerWidth) / 2 - matches[0].x,
          y: (containerRef.current?.clientHeight || window.innerHeight) / 2 - matches[0].y,
          k: transform.k,
        });
        setSelected(matches[0].id);
        setActiveLeafItemId(null);
      }
    },
    [nodes, highlightMatchList, highlightIdx, transform]
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
              <div className="relative flex-1 min-w-0 max-w-md">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    // Persist search query as user types
                    persistState();
                  }}
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
              <span className="text-xs text-muted-foreground tabular-nums mr-1" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                {Math.round(transform.k * 100)}%
              </span>
              <button
                onClick={() => setTransform({ x: 48, y: 56, k: 1 })}
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
              <button
                onClick={() => setShowPassivedPanel((p) => !p)}
                className={`text-xs px-2.5 py-1 rounded border border-border hover:text-foreground hover:border-white/20 transition-colors ${
                  showPassivedPanel ? "text-yellow-400 border-yellow-400/30" : "text-muted-foreground"
                }`}
                title="Manage passived items (leaf nodes that won't be expanded)"
              >
                ⚡ Passived ({passivedList.length})
              </button>
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

          {/* ── Passived panel ── */}
          {showPassivedPanel && (
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: "60px",
                transform: "translateX(-50%)",
                width: 340,
                zIndex: 60,
                background: "#0e0e1a",
                border: "1px solid rgba(250,204,21,0.25)",
                borderRadius: 10,
                boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
                fontFamily: "'JetBrains Mono', monospace",
                overflow: "hidden",
              }}
            >
              <div className="px-3 py-2 border-b border-border flex items-center justify-between" style={{ background: "rgba(250,204,21,0.06)" }}>
                <span className="text-[11px] font-medium text-yellow-400">Passived Items</span>
                <button
                  onClick={() => setShowPassivedPanel(false)}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  ✕
                </button>
              </div>
              <div className="p-3">
                <div className="text-[10px] text-muted-foreground mb-2">
                  Passived items are treated as leaf nodes — no recipe expansion occurs for them. Changes are saved to localStorage.
                </div>
                {/* Add new item */}
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    id="passived-input"
                    placeholder="Item ID to add…"
                    className="flex-1 h-7 px-2 text-[11px] rounded border border-border bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-yellow-400/40 transition-colors"
                    style={{ fontFamily: "'JetBrains Mono', monospace" }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const input = e.currentTarget;
                        const val = input.value.trim();
                        if (val && !passivedList.includes(val)) {
                          const next = [...passivedList, val];
                          setPassivedList(next);
                          savePassivedList(next);
                          setPassivedSet(new Set(next));
                          input.value = "";
                          toast.success(`"${val}" added to passived — children hidden`);
                          rebuildTreeWithPassived(new Set(next));
                        }
                      }
                    }}
                  />
                  <button
                    onClick={() => {
                      const input = document.getElementById("passived-input") as HTMLInputElement;
                      const val = input.value.trim();
                      if (val && !passivedList.includes(val)) {
                        const next = [...passivedList, val];
                        setPassivedList(next);
                        savePassivedList(next);
                        setPassivedSet(new Set(next));
                        input.value = "";
                        toast.success(`"${val}" added to passived — children hidden`);
                        rebuildTreeWithPassived(new Set(next));
                      }
                    }}
                    className="h-7 px-3 text-[11px] rounded border border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/10 transition-colors"
                  >
                    Add
                  </button>
                </div>
                {/* Current passived list */}
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {passivedList.length === 0 ? (
                    <div className="text-[10px] text-muted-foreground text-center py-2">No passived items</div>
                  ) : (
                    passivedList.map((item) => (
                      <div
                        key={item}
                        className="flex items-center justify-between gap-2 px-2 py-1 rounded text-[11px]"
                        style={{ background: "rgba(250,204,21,0.06)" }}
                      >
                        <span className="text-foreground truncate">{item}</span>
                        <button
                          onClick={() => {
                            const next = passivedList.filter((i) => i !== item);
                            setPassivedList(next);
                            savePassivedList(next);
                            setPassivedSet(new Set(next));
                            toast.success(`"${item}" removed from passived — children shown`);
                            rebuildTreeWithPassived(new Set(next));
                          }}
                          className="text-xs text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                          title="Remove"
                        >
                          ✕
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
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
