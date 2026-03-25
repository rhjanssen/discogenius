import { useCallback, useEffect, useMemo, useState } from "react";

export interface SelectableCollectionOptions<T> {
  items: T[];
  getItemId: (item: T) => string | number;
}

export function useSelectableCollection<T>({ items, getItemId }: SelectableCollectionOptions<T>) {
  const [selectedRowIds, setSelectedRowIds] = useState<Array<string | number>>([]);

  const visibleRowIds = useMemo(() => items.map((item) => getItemId(item)), [getItemId, items]);
  const visibleRowIdSet = useMemo(() => new Set(visibleRowIds), [visibleRowIds]);
  const selectedRowIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);

  useEffect(() => {
    setSelectedRowIds((current) => current.filter((rowId) => visibleRowIdSet.has(rowId)));
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
  }, [visibleRowIds]);

  const clearSelection = useCallback(() => {
    setSelectedRowIds([]);
  }, []);

  const selection = useMemo(() => ({
    selectedRowIds,
    onSelectionChange: setSelectedRowIds,
  }), [selectedRowIds]);

  return {
    selectedRowIds,
    selectedItems,
    selectedCount,
    allVisibleSelected,
    someVisibleSelected,
    selectAllVisible,
    clearSelection,
    selection,
    setSelectedRowIds,
  };
}
