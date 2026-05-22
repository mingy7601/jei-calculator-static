/**
 * state-persist.ts — Persist app state to localStorage across sessions.
 *
 * Stores only: search query, selected node, and recipe overrides.
 * Saved synchronously on key actions + on page unload.
 *
 * Key: "jei-calc:state"
 */

// ── Storage key ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "jei-calc:state";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PersistedState {
  v: number;
  searchQuery: string;
  selected: string | null;
  overrides: Record<string, number>;
}

const CURRENT_VERSION = 1;

// ── Serialisation ─────────────────────────────────────────────────────────────

function serialize(state: PersistedState): string {
  return JSON.stringify({ ...state, v: CURRENT_VERSION });
}

function deserialize(raw: string | null): PersistedState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.v !== "number" || parsed.v > CURRENT_VERSION) return null;
    return {
      v: CURRENT_VERSION,
      searchQuery: (typeof parsed.searchQuery === "string" && parsed.searchQuery.length > 0)
        ? parsed.searchQuery
        : "",
      selected: (typeof parsed.selected === "string" && parsed.selected.length > 0)
        ? parsed.selected
        : null,
      overrides:
        parsed.overrides && typeof parsed.overrides === "object"
          ? parsed.overrides
          : {},
    };
  } catch {
    return null;
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────

export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return deserialize(raw);
  } catch {
    return null;
  }
}

// ── Save (sync) ───────────────────────────────────────────────────────────────

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(state));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

// ── Clear persisted state ─────────────────────────────────────────────────────

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
