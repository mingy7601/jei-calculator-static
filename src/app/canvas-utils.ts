/**
 * canvas-utils.ts — Canvas rendering utilities.
 *
 * Contains all functions for drawing on the canvas:
 *   - Coordinate transforms (screen ↔ canvas)
 *   - Grid, edges, and node rendering
 *   - Hit detection for interactive elements
 *
 * These functions are pure (no React state) and can be called from the
 * useLayoutEffect draw loop in the component.
 */

import type { LayoutNode, Transform, NodeHitBoxes } from "./types";
import { NODE_W, NODE_H_BASE, NODE_H_IMAGE } from "./layout";

// ─── Visual tokens (canvas colors, dark theme) ──────────────────────────────

export const CANVAS_BG = "#0d0d14";
export const CANVAS_GRID = "rgba(255,255,255,0.035)";
export const CANVAS_EDGE = "rgba(255,255,255,0.085)";
export const CANDS_EDGE_HL = "rgba(34,211,238,0.55)";
export const CANVAS_EDGE_SEL = "#22d3ee";
export const NODE_BORDER = "rgba(255,255,255,0.07)";
export const NODE_BORDER_SEL = "rgba(34,211,238,0.42)";
export const NODE_BORDER_HL = "#22d3ee";
export const NODE_RADIUS = 10;

// ─── Transform helpers (screen ↔ canvas coordinates) ────────────────────────

/**
 * Converts screen coordinates (mouse position) to canvas space.
 * Accounts for the current pan/zoom transform.
 */
export function screenToCanvas(tx: Transform, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - tx.x) / tx.k,
    y: (sy - tx.y) / tx.k,
  };
}

/**
 * Converts canvas coordinates to screen coordinates.
 * Used to position HTML overlays relative to canvas nodes.
 */
export function canvasToScreen(tx: Transform, cx: number, cy: number): { x: number; y: number } {
  return {
    x: cx * tx.k + tx.x,
    y: cy * tx.k + tx.y,
  };
}

// ─── Grid rendering ──────────────────────────────────────────────────────────

/**
 * Draws a subtle dot grid pattern across the canvas background.
 * The grid scales with zoom and shifts with pan.
 */
export function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, tx: Transform) {
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

// ─── Edge rendering ──────────────────────────────────────────────────────────

/**
 * Draws a cubic Bézier curve between two points.
 * Uses different styles for selected and highlighted edges.
 *
 * @param x1, y1 — Start point (canvas coords)
 * @param x2, y2 — End point (canvas coords)
 * @param isHl   — Whether to highlight this edge (search match)
 * @param isSel  — Whether this edge connects to a selected node
 */
export function drawEdge(
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

/**
 * Converts a hex color string to an rgba string with the given alpha.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Hit detection ───────────────────────────────────────────────────────────

/**
 * Computes the screen-space bounding boxes for interactive elements
 * within a node card (expand triangle, alternatives button, toggle strip).
 */
export function getNodeHitBoxes(
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
    altDoubleArrow: node.type === "passived"
      ? null
      : {
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

/**
 * Checks if a point is inside a circle.
 */
export function isPointInCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  return (px - cx) ** 2 + (py - cy) ** 2 <= r ** 2;
}

/**
 * Checks if a point is inside a rectangle.
 */
export function isPointInRect(px: number, py: number, rx: number, ry: number, rw: number, rh: number): boolean {
  return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
}

// ─── Node rendering ──────────────────────────────────────────────────────────

/**
 * Draws a single node card on the canvas, including:
 *   - Background and border (with selection/hover states)
 *   - Type indicator dot
 *   - Label (with truncation)
 *   - Alternatives button (⇅)
 *   - Meta badge
 *   - Children count
 *   - Expand/collapse chevron
 *   - Image panel (if card expanded)
 *   - Toggle strip with chevron at bottom
 */
export function drawNode(
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
  const isPassived = node.type === "passived";
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

  // ── Show alternatives button (⇅) — hidden for passived nodes ──
  let altBtnW = 28;
  let altBtnH = 16;
  let altBtnX = x + 14;
  let altBtnY = y + 38;

  if (!isPassived) {
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
  }

  // ── Meta badge (to the right of alternatives button) ──
  if (node.meta) {
    const badgeText = node.meta;
    const badgeW = ctx.measureText(badgeText).width + 10;
    const badgeH = 16;
    const badgeX = isPassived ? altBtnX : altBtnX + altBtnW + 6;
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
