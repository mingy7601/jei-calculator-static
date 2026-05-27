/**
 * PassivedDropdown.tsx — Dropdown for managing passived items.
 *
 * Replaces the old floating panel with a compact dropdown positioned
 * directly beneath the "⚡ Passived" button in the toolbar.
 *
 * Features:
 *   - Search bar with autocomplete (display-name matching)
 *   - Pending list uses display names instead of raw IDs
 *   - Changes are NOT applied until "Reload" is clicked
 */

import { useRef, useCallback, useEffect, useMemo } from "react";
import { Search, Plus, X, RotateCcw } from "lucide-react";
import { getManifestData } from "../data";

interface PassivedDropdownProps {
  passivedPendingList: string[];
  setPassivedPendingList: React.Dispatch<React.SetStateAction<string[]>>;
  passivedHasChanges: boolean;
  setPassivedHasChanges: (v: boolean) => void;
  passivedSearchQuery: string;
  setPassivedSearchQuery: (v: string) => void;
  passivedSuggestions: { name: string; id: string }[];
  setPassivedSuggestions: (v: { name: string; id: string }[]) => void;
  passivedSuggestionIdx: number;
  setPassivedSuggestionIdx: React.Dispatch<React.SetStateAction<number>>;
  passivedDropdownOpen: boolean;
  setPassivedDropdownOpen: (v: boolean) => void;
  onReload?: () => void;
}

// ─── Reverse lookup: itemId → displayName ──────────────────────────────────────

function getItemDisplayName(itemId: string): string {
  const mf = getManifestData();
  if (!mf) return itemId;
  // nameToId maps display name → id, so we need to invert
  for (const [name, id] of Object.entries(mf.nameToId)) {
    if (id === itemId) return name;
  }
  return itemId;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PassivedDropdown({
  passivedPendingList,
  setPassivedPendingList,
  passivedHasChanges,
  setPassivedHasChanges,
  passivedSearchQuery,
  setPassivedSearchQuery,
  passivedSuggestions,
  setPassivedSuggestions,
  passivedSuggestionIdx,
  setPassivedSuggestionIdx,
  passivedDropdownOpen,
  setPassivedDropdownOpen,
  onReload,
}: PassivedDropdownProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!passivedDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setPassivedDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [passivedDropdownOpen, setPassivedDropdownOpen]);

  // Focus input when dropdown opens
  useEffect(() => {
    if (passivedDropdownOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [passivedDropdownOpen]);

  // Compute dropdown height to reach the bottom of the screen
  const dropdownStyle = useMemo(() => {
    if (!passivedDropdownOpen || !wrapperRef.current) return {};
    const rect = wrapperRef.current.getBoundingClientRect();
    const topEdge = rect.bottom;
    const viewportH = window.innerHeight;
    const height = Math.max(200, viewportH - topEdge);
    return { height };
  }, [passivedDropdownOpen]);

  // Filter suggestions based on search query
  const filterSuggestions = useCallback(
    (query: string) => {
      if (!query || query.length < 1) {
        setPassivedSuggestions([]);
        setPassivedSuggestionIdx(-1);
        return;
      }
      const q = query.toLowerCase();
      const mf = getManifestData();
      if (!mf) {
        setPassivedSuggestions([]);
        setPassivedSuggestionIdx(-1);
        return;
      }
      const nameToId = mf.nameToId;
      const results: { name: string; id: string }[] = [];
      for (const [name, id] of Object.entries(nameToId)) {
        if (name.includes(q)) {
          results.push({ name, id });
          if (results.length >= 8) break;
        }
      }
      setPassivedSuggestions(results);
      setPassivedSuggestionIdx(-1);
    },
    []
  );

  // Debounced search handler
  const handleSearchChange = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const val = input.value;
    setPassivedSearchQuery(val);
    if (searchDebounceTimerRef.current) clearTimeout(searchDebounceTimerRef.current);
    searchDebounceTimerRef.current = setTimeout(() => filterSuggestions(val), 150);
  }, [filterSuggestions]);

  // Keyboard navigation for suggestions
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!passivedDropdownOpen || passivedSuggestions.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPassivedSuggestionIdx((prev) =>
          prev < passivedSuggestions.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPassivedSuggestionIdx((prev) =>
          prev > 0 ? prev - 1 : passivedSuggestions.length - 1
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const sel =
          passivedSuggestionIdx >= 0 && passivedSuggestions[passivedSuggestionIdx]
            ? passivedSuggestions[passivedSuggestionIdx]
            : passivedSuggestions[0];
        if (sel) {
          handleSuggestionClick(sel.id);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPassivedDropdownOpen(false);
        return;
      }
    },
    [
      passivedDropdownOpen,
      passivedSuggestions,
      passivedSuggestionIdx,
      setPassivedSuggestionIdx,
      setPassivedDropdownOpen,
    ]
  );

  // Add or remove item from pending list based on suggestion click
  const handleSuggestionClick = useCallback(
    (itemId: string) => {
      setPassivedSearchQuery("");
      if (inputRef.current) inputRef.current.value = "";
      setPassivedSuggestions([]);
      setPassivedSuggestionIdx(-1);

      setPassivedPendingList((prev) => {
        const exists = prev.includes(itemId);
        let next: string[];
        if (exists) {
          // Already in list — remove it
          next = prev.filter((id) => id !== itemId);
        } else {
          // Not in list — add it
          next = [...prev, itemId];
        }
        return next;
      });
    },
    []
  );

  // Remove item from pending list
  const handleRemoveFromPending = useCallback(
    (itemId: string) => {
      setPassivedPendingList((prev) => prev.filter((id) => id !== itemId));
    },
    []
  );

  // Check if an item is already in the pending list
  const isInPendingList = useCallback(
    (itemId: string) => passivedPendingList.includes(itemId),
    [passivedPendingList]
  );

  // Clear all passived items from the pending list
  const handleClearPassives = useCallback(() => {
    setPassivedPendingList([]);
  }, []);

  // Sort passived items alphabetically by display name
  const sortedPendingItems = useMemo(() => {
    return [...passivedPendingList].sort((a, b) => {
      const nameA = getItemDisplayName(a);
      const nameB = getItemDisplayName(b);
      return nameA.localeCompare(nameB);
    });
  }, [passivedPendingList]);

  return (
    <div ref={wrapperRef} className="relative">
      {/* Dropdown panel */}
      {passivedDropdownOpen && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            width: 340,
            zIndex: 60,
            background: "#0e0e1a",
            border: "1px solid rgba(250,204,21,0.25)",
            borderRadius: "0 0 10px 10px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.55)",
            fontFamily: "'JetBrains Mono', monospace",
            overflow: "hidden",
            ...dropdownStyle,
          }}
        >
          {/* ── Search bar with autocomplete ── */}
          <div className="p-3 pb-2">
            <div className="relative">
              <Search
                size={12}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
              />
              <input
                ref={inputRef}
                type="text"
                value={passivedSearchQuery}
                onChange={handleSearchChange}
                onKeyDown={handleKeyDown}
                placeholder="Search items to add…"
                className="w-full h-7 pl-7 pr-2 text-[11px] rounded border border-border bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-yellow-400/40 transition-colors"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              />
            </div>

            {/* Autocomplete suggestions */}
            {passivedSuggestions.length > 0 && (
              <div
                className="absolute top-full left-0 right-0 mt-0.5 z-50 rounded border border-border bg-[#0e0e1a] shadow-lg overflow-hidden"
                style={{ maxHeight: "226px", overflowY: "auto" }}
              >
                {passivedSuggestions.map((item, idx) => {
                  const exists = isInPendingList(item.id);
                  return (
                    <button
                      key={item.id}
                      onClick={() => handleSuggestionClick(item.id)}
                      className={`w-full text-left px-2 py-0.5 text-xs truncate transition-colors flex items-center justify-between gap-2 ${
                        idx === passivedSuggestionIdx
                          ? "bg-[rgba(34,211,238,0.12)] text-cyan-300"
                          : "text-muted-foreground hover:bg-white/5"
                      }`}
                      style={{ fontFamily: "'JetBrains Mono', monospace", lineHeight: "28px" }}
                    >
                      <span className="truncate">
                        {item.name}{" "}
                        <span className="opacity-50">({item.id})</span>
                      </span>
                      {exists ? (
                        <X size={11} className="shrink-0 text-yellow-400/60" />
                      ) : (
                        <Plus size={11} className="shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Header ── */}
          <div
            className="px-3 py-2 border-b border-border flex items-center justify-between"
            style={{ background: "rgba(250,204,21,0.06)" }}
          >
            <span className="text-[11px] font-medium text-yellow-400">
              Passived Items ({passivedPendingList.length})
            </span>
            <button
              name="clearPassives"
              onClick={handleClearPassives}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              CLEAR
            </button>
          </div>

          {/* ── Pending list ── */}
          <div className="p-3 pt-2">
            <div className="text-[10px] text-muted-foreground mb-2">
              Passived items are treated as leaf nodes — no recipe expansion.
              Changes apply when you click Reload.
            </div>

            {passivedPendingList.length === 0 ? (
              <div className="text-[10px] text-muted-foreground text-center py-2">
                No passived items
              </div>
            ) : (
              <div className="space-y-1 overflow-y-auto mb-3">
                {sortedPendingItems.map((itemId) => {
                  const displayName = getItemDisplayName(itemId);
                  return (
                    <div
                      key={itemId}
                      className="flex items-center justify-between gap-2 px-2 py-1 rounded text-[11px]"
                      style={{ background: "rgba(250,204,21,0.06)" }}
                    >
                      <span className="text-foreground truncate" title={itemId}>
                        {displayName}{" "}
                      </span>
                      <button
                        onClick={() => handleRemoveFromPending(itemId)}
                        className="text-xs text-muted-foreground hover:text-red-400 transition-colors shrink-0"
                        title="Remove from pending list"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Reload button (only when there are changes) ── */}
            {passivedHasChanges && onReload && (
              <button
                onClick={onReload}
                className="w-full h-7 flex items-center justify-center gap-1.5 text-[11px] rounded border border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/10 transition-colors"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                <RotateCcw size={12} />
                Reload ({passivedPendingList.length} change{passivedPendingList.length !== 1 ? "s" : ""})
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
