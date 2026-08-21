"use client";

import { useEffect } from "react";

/**
 * Drag to resize any column, on every `table.grid` in the app.
 *
 * The tables are written as plain markup in eight different pages, and several of
 * them render columns the pipeline decides at runtime, so attaching this per call
 * site would mean touching every one of them and missing the dynamic cases. One
 * mount in the root layout covers all of them, including tables that do not exist
 * yet when this runs, which is why it watches the document rather than a ref.
 *
 * Widths are remembered against the header row's text, so a React re-render that
 * replaces the table element (new query results, a fresh run history) does not
 * throw away what the reader set up. Nothing is written to storage: this is a
 * per-session reading aid, not a preference.
 */

const MIN_WIDTH = 56;
const KEYBOARD_STEP = 16;

const remembered = new Map<string, number[]>();

function headers(table: HTMLTableElement): HTMLTableCellElement[] {
  return Array.from(table.querySelectorAll<HTMLTableCellElement>("thead th"));
}

/** Identity that survives re-rendering. Column names are what the reader sized. */
function tableKey(table: HTMLTableElement): string {
  return headers(table)
    .map((th) => th.textContent?.trim() ?? "")
    .join("|");
}

/**
 * Column widths only hold still under a fixed layout, so the first resize pins
 * every column at the width the auto algorithm had already chosen. Doing it at
 * that moment rather than on mount means an untouched table still sizes itself
 * to its content.
 */
function freeze(table: HTMLTableElement): HTMLTableCellElement[] {
  const cells = headers(table);
  if (table.dataset.resizeFrozen !== "true") {
    const widths = cells.map((th) => th.getBoundingClientRect().width);
    table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
    table.style.tableLayout = "fixed";
    cells.forEach((th, index) => {
      th.style.width = `${widths[index]}px`;
    });
    table.dataset.resizeFrozen = "true";
  }
  return cells;
}

function remember(table: HTMLTableElement): void {
  remembered.set(
    tableKey(table),
    headers(table).map((th) => th.getBoundingClientRect().width),
  );
}

function restore(table: HTMLTableElement): void {
  const widths = remembered.get(tableKey(table));
  const cells = headers(table);
  if (!widths || widths.length !== cells.length) return;
  table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
  table.style.tableLayout = "fixed";
  cells.forEach((th, index) => {
    th.style.width = `${widths[index]}px`;
  });
  table.dataset.resizeFrozen = "true";
}

/** Hand the table back to the browser's own column sizing. */
function reset(table: HTMLTableElement): void {
  headers(table).forEach((th) => {
    th.style.width = "";
  });
  table.style.width = "";
  table.style.tableLayout = "";
  delete table.dataset.resizeFrozen;
  remembered.delete(tableKey(table));
}

function resize(table: HTMLTableElement, index: number, width: number, fromWidth: number): void {
  const cells = headers(table);
  const next = Math.max(MIN_WIDTH, width);
  const tableWidth = table.getBoundingClientRect().width;
  cells[index].style.width = `${next}px`;
  // Widen the table by the same amount, so dragging one column does not squeeze
  // its neighbours out of the space they were given.
  table.style.width = `${tableWidth + (next - fromWidth)}px`;
}

function addHandle(table: HTMLTableElement, th: HTMLTableCellElement, index: number): void {
  const handle = document.createElement("span");
  handle.className = "col-resize";
  handle.dataset.colResize = "true";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", `Resize column ${th.textContent?.trim() ?? index + 1}`);
  handle.title = "Drag to resize this column. Double click to restore every column.";

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const cells = freeze(table);
    const startX = event.clientX;
    const startWidth = cells[index].getBoundingClientRect().width;
    // Throws NotFoundError if the pointer has already been released. Capture is a
    // nicety here (it keeps events coming when the cursor outruns the handle), not
    // a requirement, so losing it must not abort the drag.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* drag still works through the listeners below */
    }
    document.body.style.userSelect = "none";

    const onMove = (move: PointerEvent) => {
      resize(table, index, startWidth + (move.clientX - startX), cells[index].getBoundingClientRect().width);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.style.userSelect = "";
      remember(table);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });

  // A pointer is not the only way in. Arrow keys move the same edge.
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const cells = freeze(table);
    const current = cells[index].getBoundingClientRect().width;
    resize(table, index, current + (event.key === "ArrowRight" ? KEYBOARD_STEP : -KEYBOARD_STEP), current);
    remember(table);
  });

  handle.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    reset(table);
  });

  th.appendChild(handle);
}

function enhance(table: HTMLTableElement): void {
  const cells = headers(table);
  if (cells.length < 2) return;
  restore(table);
  cells.forEach((th, index) => {
    // The last column absorbs the slack, so it gets no handle of its own.
    if (index === cells.length - 1) return;
    if (th.querySelector("[data-col-resize]")) return;
    addHandle(table, th, index);
  });
}

export function ResizableColumns(): null {
  useEffect(() => {
    const enhanceAll = () => {
      document.querySelectorAll<HTMLTableElement>("table.grid").forEach(enhance);
    };

    enhanceAll();

    // React re-renders drop the handles we injected, and results arrive long after
    // mount. Coalesce to one pass per frame so a 200 row table does not run this
    // once per mutated node.
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        enhanceAll();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);

  return null;
}
