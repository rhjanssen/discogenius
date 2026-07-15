import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface SelectableCollectionOptions<T> {
  items: T[];
  getItemId: (item: T) => string | number;
  isItemSelectable?: (item: T) => boolean;
}

export function useSelectableCollection<T>({
  items,
  getItemId,
  isItemSelectable,
}: SelectableCollectionOptions<T>) {
  const [selectedRowIds, setSelectedRowIds] = useState<Array<string | number>>([]);
  const lastToggledRowIdRef = useRef<string | number | null>(null);

  const visibleRowIds = useMemo(
    () => items.filter((item) => isItemSelectable?.(item) ?? true).map((item) => getItemId(item)),
    [getItemId, isItemSelectable, items],
  );
  const visibleRowIdSet = useMemo(() => new Set(visibleRowIds), [visibleRowIds]);
  const selectedRowIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);

  useEffect(() => {
    setSelectedRowIds((current) => {
      const next = current.filter((rowId) => visibleRowIdSet.has(rowId));
      // Preserve identity when nothing was pruned: returning a fresh array here
      // re-renders, and since callers often pass an inline getItemId (new
      // identity per render → new visibleRowIdSet → this effect refires), a
      // fresh-but-equal array turns that into an infinite update loop
      // ("Maximum update depth exceeded" on the dashboard queue).
      return next.length === current.length ? current : next;
    });
  }, [visibleRowIdSet]);

  const selectedItems = useMemo(() => {
    if (selectedRowIds.length === 0) {
      return [] as T[];
    }

    return items.filter((item) => selectedRowIdSet.has(getItemId(item)));
  }, [getItemId, items, selectedRowIdSet, selectedRowIds.length]);

  const selectedCount = selectedRowIds.length;
  const allVisibleSelected = visibleRowIds.length > 0 && visibleRowIds.every((rowId) => selectedRowIdSet.has(rowId));
  const someVisibleSelected = !allVisibleSelected && visibleRowIds.some((rowId) => selectedRowIdSet.has(rowId));

  const selectAllVisible = useCallback(() => {
    setSelectedRowIds(visibleRowIds);
    lastToggledRowIdRef.current = null;
  }, [visibleRowIds]);

  const clearSelection = useCallback(() => {
    setSelectedRowIds([]);
    lastToggledRowIdRef.current = null;
  }, []);

  const toggleItem = useCallback((
    rowId: string | number,
    selected: boolean,
    options?: { range?: boolean },
  ) => {
    if (!visibleRowIdSet.has(rowId)) {
      return;
    }

    setSelectedRowIds((current) => {
      const next = new Set(current);
      const rowIndex = visibleRowIds.indexOf(rowId);
      const previousIndex = lastToggledRowIdRef.current == null
        ? -1
        : visibleRowIds.indexOf(lastToggledRowIdRef.current);
      const affectedIds = options?.range && rowIndex >= 0 && previousIndex >= 0
        ? visibleRowIds.slice(Math.min(rowIndex, previousIndex), Math.max(rowIndex, previousIndex) + 1)
        : [rowId];

      for (const affectedId of affectedIds) {
        if (selected) {
          next.add(affectedId);
        } else {
          next.delete(affectedId);
        }
      }

      return Array.from(next);
    });
    lastToggledRowIdRef.current = rowId;
  }, [visibleRowIdSet, visibleRowIds]);

  const selection = useMemo(() => ({
    selectedRowIds,
    onSelectionChange: setSelectedRowIds,
  }), [selectedRowIds]);

  return {
    selectedRowIds,
    selectedItems,
    selectedCount,
    visibleRowIds,
    allVisibleSelected,
    someVisibleSelected,
    selectAllVisible,
    clearSelection,
    toggleItem,
    selection,
    setSelectedRowIds,
  };
}
