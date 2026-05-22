/**
 * CategoryReparentBoard — Sprint M-5 (2026-05-14).
 *
 * Drag-and-drop UI for re-parenting categories under a different
 * super-group. The board renders one column per top-level category
 * (Housing, Food, Transport, etc.) and shows each leaf category as a
 * draggable card. Drop a card onto a different column to PATCH its
 * parent_id; the budgets panel + donut roll-up instantly reflect the
 * new grouping.
 *
 * Built on the native HTML5 drag-and-drop API — no library dependency.
 * Accessibility note: HTML5 dnd is keyboard-unfriendly. A "Move to…"
 * button on each card gives keyboard users an equivalent affordance.
 *
 * Mounted as a modal on the Budgets panel via a "Manage categories"
 * button. Closes on ESC / backdrop click.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Category } from "../api/client";

interface Props {
  onClose: () => void;
}

export default function CategoryReparentBoard({ onClose }: Props) {
  const qc = useQueryClient();
  const catsQ = useQuery({
    queryKey: ["categories"],
    queryFn: api.listCategories,
  });

  // Local optimistic state — we mutate this on drop so the card moves
  // instantly, then the mutation reconciles with the server. If the
  // server rejects (cycle, missing parent), we roll back.
  const [optimistic, setOptimistic] = useState<Map<number, number | null>>(
    new Map(),
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const mutate = useMutation({
    mutationFn: ({
      categoryId,
      parent_id,
    }: {
      categoryId: number;
      parent_id: number | null;
    }) => api.reparentCategory(categoryId, parent_id),
    onSuccess: (_data, vars) => {
      // Clear the optimistic entry now that the server agrees.
      setOptimistic((prev) => {
        const next = new Map(prev);
        next.delete(vars.categoryId);
        return next;
      });
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["budgetRollup"] });
      qc.invalidateQueries({ queryKey: ["assignmentLedger"] });
    },
    onError: (_err, vars) => {
      // Roll back the optimistic move.
      setOptimistic((prev) => {
        const next = new Map(prev);
        next.delete(vars.categoryId);
        return next;
      });
    },
  });

  // ---- Add-category form state ----
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState<number | "">("");
  const [newDiscretionary, setNewDiscretionary] = useState(true);

  const createMut = useMutation({
    mutationFn: () =>
      api.createCategory({
        name: newName.trim(),
        parent_id: newParentId === "" ? null : Number(newParentId),
        is_discretionary: newDiscretionary,
      }),
    onSuccess: () => {
      setNewName("");
      setNewParentId("");
      setNewDiscretionary(true);
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["budgetRollup"] });
      qc.invalidateQueries({ queryKey: ["assignmentLedger"] });
    },
  });

  // Combine server categories with optimistic overrides.
  const categories = useMemo(() => {
    const cats = catsQ.data ?? [];
    return cats.map((c) =>
      optimistic.has(c.id)
        ? { ...c, parent_id: optimistic.get(c.id) ?? null }
        : c,
    );
  }, [catsQ.data, optimistic]);

  // Build columns: top-level categories (parent_id == null) as columns,
  // children grouped under their parent.
  const { topLevel, children } = useMemo(() => {
    const top: Category[] = [];
    const kids = new Map<number, Category[]>();
    for (const c of categories) {
      if (c.parent_id == null) {
        top.push(c);
      } else {
        const arr = kids.get(c.parent_id) ?? [];
        arr.push(c);
        kids.set(c.parent_id, arr);
      }
    }
    top.sort((a, b) => a.name.localeCompare(b.name));
    return { topLevel: top, children: kids };
  }, [categories]);

  // Drag state — which card is being dragged, which column is being hovered.
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [hoveredColumnId, setHoveredColumnId] = useState<number | null>(null);

  function onDropOnColumn(parentId: number, e: React.DragEvent) {
    e.preventDefault();
    setHoveredColumnId(null);
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return;
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id) || id === parentId) return;
    // Apply optimistic update then dispatch the mutation.
    setOptimistic((prev) => {
      const next = new Map(prev);
      next.set(id, parentId);
      return next;
    });
    mutate.mutate({ categoryId: id, parent_id: parentId });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Manage categories: drag and drop to re-parent"
    >
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-6xl max-h-[92vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-border sticky top-0 bg-card z-10">
          <div>
            <h2 className="text-base font-bold text-text">
              Manage categories
            </h2>
            <p className="text-[11px] text-text-soft mt-0.5">
              Drag any category card to a different group to re-parent it.
              The donut + The Plan card update immediately.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text text-lg leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Board */}
        <div className="p-5">
          {catsQ.isLoading && (
            <div className="text-sm text-text-muted text-center py-8">
              Loading categories…
            </div>
          )}
          {catsQ.isError && (
            <div className="text-sm text-outflow text-center py-8">
              Couldn't load categories.
            </div>
          )}
          {topLevel.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {topLevel.map((parent) => {
                const kids = children.get(parent.id) ?? [];
                const isHovered = hoveredColumnId === parent.id;
                return (
                  <div
                    key={parent.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setHoveredColumnId(parent.id);
                    }}
                    onDragLeave={() => {
                      setHoveredColumnId((cur) =>
                        cur === parent.id ? null : cur,
                      );
                    }}
                    onDrop={(e) => onDropOnColumn(parent.id, e)}
                    className={`border rounded-md p-3 min-h-[140px] transition-colors ${
                      isHovered
                        ? "border-brand bg-brand/5"
                        : "border-border bg-slate-50/50"
                    }`}
                  >
                    <div className="flex items-baseline justify-between mb-2">
                      <h3 className="text-sm font-bold text-text">
                        {parent.icon ? `${parent.icon} ` : ""}
                        {parent.name}
                      </h3>
                      <span className="text-[10px] text-text-muted tabular-nums">
                        {kids.length}{" "}
                        {kids.length === 1 ? "child" : "children"}
                      </span>
                    </div>
                    {kids.length === 0 && (
                      <div className="text-[10px] text-text-muted italic py-3 text-center border border-dashed border-border rounded">
                        Drop categories here
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {kids
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((c) => (
                          <DraggableCard
                            key={c.id}
                            category={c}
                            isBeingDragged={draggingId === c.id}
                            onDragStart={(e) => {
                              setDraggingId(c.id);
                              e.dataTransfer.setData("text/plain", String(c.id));
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            onDragEnd={() => setDraggingId(null)}
                            topLevel={topLevel}
                            onKeyboardMove={(newParentId) => {
                              setOptimistic((prev) => {
                                const next = new Map(prev);
                                next.set(c.id, newParentId);
                                return next;
                              });
                              mutate.mutate({
                                categoryId: c.id,
                                parent_id: newParentId,
                              });
                            }}
                          />
                        ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Add a category */}
        <div className="px-5 pb-4 pt-4 border-t border-border">
          <h3 className="text-xs font-bold text-text mb-2">Add a category</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Category name"
              className="border border-border rounded px-2 py-1 text-xs bg-card w-44"
            />
            <select
              value={newParentId}
              onChange={(e) =>
                setNewParentId(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              className="border border-border rounded px-2 py-1 text-xs bg-card"
            >
              <option value="">No parent (top-level)</option>
              {topLevel.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={newDiscretionary}
                onChange={(e) => setNewDiscretionary(e.target.checked)}
              />
              Variable (discretionary)
            </label>
            <button
              type="button"
              disabled={!newName.trim() || createMut.isPending}
              onClick={() => createMut.mutate()}
              className="text-xs font-semibold px-3 py-1 rounded bg-brand text-white disabled:opacity-40"
            >
              {createMut.isPending ? "Adding\u2026" : "+ Add category"}
            </button>
          </div>
          {createMut.isError && (
            <div className="text-[11px] text-outflow mt-1">
              Couldn't create the category \u2014 a category with that name
              may already exist.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 pb-4 text-[10px] text-text-muted">
          Changes save instantly. The 4 categories at the bottom of the
          taxonomy (Other, Uncategorized, Income, etc.) are top-level on
          purpose — feel free to leave them empty.
        </div>
      </div>
    </div>
  );
}

/* ============================================================== */
/*  DraggableCard — single category card                            */
/* ============================================================== */

function DraggableCard({
  category,
  isBeingDragged,
  onDragStart,
  onDragEnd,
  topLevel,
  onKeyboardMove,
}: {
  category: Category;
  isBeingDragged: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  topLevel: Category[];
  onKeyboardMove: (newParentId: number) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`relative bg-card border border-border rounded-md px-2.5 py-1.5 text-xs flex items-center justify-between gap-2 cursor-grab active:cursor-grabbing transition-opacity ${
        isBeingDragged ? "opacity-30" : "hover:bg-hover hover:shadow-sm"
      }`}
    >
      <span className="truncate">
        <span aria-hidden className="text-text-muted mr-1">⋮⋮</span>
        {category.name}
      </span>
      <div className="relative flex-shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="text-[10px] text-text-muted hover:text-text px-1 rounded focus:outline-none focus:ring-1 focus:ring-brand/40"
          aria-label={`Move ${category.name} to a different group`}
        >
          Move →
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-1 bg-card border border-border rounded shadow-lg z-20 py-1 w-40 max-h-60 overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {topLevel.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={p.id === category.parent_id}
                onClick={() => {
                  setMenuOpen(false);
                  if (p.id !== category.parent_id) onKeyboardMove(p.id);
                }}
                className="w-full text-left px-2 py-1 text-xs hover:bg-hover disabled:opacity-40 disabled:cursor-default"
              >
                {p.icon ? `${p.icon} ` : ""}
                {p.name}
                {p.id === category.parent_id && (
                  <span className="ml-1 text-text-muted">(current)</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
