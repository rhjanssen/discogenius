import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowRight16Regular, ArrowSortDownLines24Regular, Dismiss24Regular } from "@fluentui/react-icons";
import { useSelectableCollection } from "@/hooks/useSelectableCollection";

export interface RenamePreviewItem {
  id: number;
  file_type: string;
  file_path: string;
  expected_path: string | null;
  needs_rename: boolean;
  missing: boolean;
  conflict: boolean;
}

export interface RetagPreviewChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface RetagPreviewItem {
  id: number;
  path: string;
  missing: boolean;
  changes: RetagPreviewChange[];
  error?: string;
}

const useStyles = makeStyles({
  dialog: {
    maxWidth: "760px",
  },
  summary: {
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    flexWrap: "wrap",
    marginBottom: tokens.spacingVerticalM,
  },
  selectionToolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    maxHeight: "52vh",
    overflow: "auto",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    gap: tokens.spacingHorizontalS,
    alignItems: "start",
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
  },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXXS,
    minWidth: 0,
  },
  filename: {
    color: tokens.colorNeutralForeground1,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: "anywhere",
  },
  oldValue: {
    color: tokens.colorNeutralForeground3,
    overflowWrap: "anywhere",
  },
  newValue: {
    color: tokens.colorPaletteGreenForeground2,
    overflowWrap: "anywhere",
  },
  change: {
    display: "grid",
    gridTemplateColumns: "minmax(90px, auto) minmax(0, 1fr) auto minmax(0, 1fr)",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
  },
  field: {
    fontWeight: tokens.fontWeightSemibold,
  },
  warning: {
    color: tokens.colorPaletteRedForeground2,
    overflowWrap: "anywhere",
  },
  intro: {
    color: tokens.colorNeutralForeground3,
  },
});

function usePreviewSelection<T extends { id: number }>(
  open: boolean,
  items: T[],
  isSelectable: (item: T) => boolean,
) {
  const {
    selectedRowIds,
    visibleRowIds,
    selectAllVisible,
    clearSelection,
    toggleItem,
    allVisibleSelected,
    someVisibleSelected,
  } = useSelectableCollection({
    items,
    getItemId: (item: T) => item.id,
    isItemSelectable: isSelectable,
  });
  const selectedIds = useMemo(
    () => new Set(selectedRowIds.map(Number)),
    [selectedRowIds],
  );
  const selectableIds = visibleRowIds as number[];
  const initializedSelectionKeyRef = useRef<string | null>(null);
  const selectableKey = selectableIds.join(",");

  useEffect(() => {
    if (!open) {
      initializedSelectionKeyRef.current = null;
      return;
    }
    if (initializedSelectionKeyRef.current === selectableKey) return;
    initializedSelectionKeyRef.current = selectableKey;
    selectAllVisible();
  }, [open, selectableKey, selectAllVisible]);

  const toggleAll = useCallback((selected: boolean) => {
    if (selected) selectAllVisible();
    else clearSelection();
  }, [clearSelection, selectAllVisible]);

  const toggle = useCallback((id: number, selected: boolean, shiftKey: boolean) => {
    toggleItem(id, selected, { range: shiftKey });
  }, [toggleItem]);

  const allSelected = allVisibleSelected;
  const someSelected = someVisibleSelected;
  return { selectedIds, selectableIds, allSelected, someSelected, toggleAll, toggle };
}

const selectableRename = (item: RenamePreviewItem) => !item.missing && !item.conflict && item.needs_rename;
const selectableRetag = (item: RetagPreviewItem) => !item.missing && !item.error && item.changes.length > 0;

export function RenamePreviewDialog({
  open,
  items,
  applying,
  title = "Preview Rename",
  applyLabel = "Rename selected files",
  onOpenChange,
  onApply,
}: {
  open: boolean;
  items: RenamePreviewItem[];
  applying: boolean;
  title?: string;
  applyLabel?: string;
  onOpenChange: (open: boolean) => void;
  onApply: (ids: number[]) => void;
}) {
  const styles = useStyles();
  const selection = usePreviewSelection(open, items, selectableRename);

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface className={styles.dialog}>
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close rename preview"
                icon={<Dismiss24Regular />}
                onClick={() => onOpenChange(false)}
              />
            }
          >
            {title}
          </DialogTitle>
          <DialogContent>
            <div className={styles.summary}>
              <Badge appearance="outline" color="brand">{items.length} changes</Badge>
              <Badge appearance="filled" color="informative">{selection.selectedIds.size} selected</Badge>
              <Badge appearance="outline" color="warning">{items.filter((item) => item.conflict).length} conflicts</Badge>
              <Badge appearance="outline" color="informative">{items.filter((item) => item.missing).length} missing</Badge>
            </div>
            {items.length > 0 ? (
              <div className={styles.list}>
                <div className={styles.selectionToolbar}>
                  <Checkbox
                    label="Select all actionable files"
                    checked={selection.allSelected ? true : selection.someSelected ? "mixed" : false}
                    onChange={(_, data) => selection.toggleAll(data.checked === true)}
                  />
                  <Text size={200}>{selection.selectedIds.size} of {selection.selectableIds.length}</Text>
                </div>
                {items.map((item) => (
                  <div key={item.id} className={styles.row}>
                    <Checkbox
                      aria-label={`Rename ${item.file_path}`}
                      checked={selection.selectedIds.has(item.id)}
                      disabled={!selectableRename(item)}
                      onChange={(event, data) => selection.toggle(
                        item.id,
                        data.checked === true,
                        Boolean((event.nativeEvent as MouseEvent).shiftKey),
                      )}
                    />
                    <div className={styles.item}>
                      <span className={styles.filename}>{item.file_type}</span>
                      <span className={styles.oldValue}>- {item.file_path}</span>
                      {item.missing ? (
                        <span className={styles.warning}>Missing on disk</span>
                      ) : item.conflict ? (
                        <span className={styles.warning}>Conflict: {item.expected_path ?? "target path unavailable"}</span>
                      ) : (
                        <span className={styles.newValue}>+ {item.expected_path ?? "target path unavailable"}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Text>No files need renaming.</Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              appearance="primary"
              icon={applying ? <Spinner size="tiny" /> : <ArrowSortDownLines24Regular />}
              disabled={applying || selection.selectedIds.size === 0}
              onClick={() => onApply(Array.from(selection.selectedIds))}
            >
              {applyLabel} ({selection.selectedIds.size})
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function RetagPreviewDialog({
  open,
  items,
  applying,
  title = "Write Metadata Tags",
  applyLabel = "Retag selected files",
  onOpenChange,
  onApply,
}: {
  open: boolean;
  items: RetagPreviewItem[];
  applying: boolean;
  title?: string;
  applyLabel?: string;
  onOpenChange: (open: boolean) => void;
  onApply: (ids: number[]) => void;
}) {
  const styles = useStyles();
  const selection = usePreviewSelection(open, items, selectableRetag);

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface className={styles.dialog}>
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close retag preview"
                icon={<Dismiss24Regular />}
                onClick={() => onOpenChange(false)}
              />
            }
          >
            {title}
          </DialogTitle>
          <DialogContent>
            <div className={styles.list}>
              <Text size={200} className={styles.intro}>
                MusicBrainz identifiers are written alongside these changes. Compatible spatial files may be skipped when embedded tag rewriting is unsafe.
              </Text>
              {items.length > 0 ? (
                <>
                  <div className={styles.summary}>
                    <Badge appearance="outline" color="brand">{items.length} changes</Badge>
                    <Badge appearance="filled" color="informative">{selection.selectedIds.size} selected</Badge>
                    <Badge appearance="outline" color="warning">{items.filter((item) => item.missing || item.error).length} unavailable</Badge>
                  </div>
                  <div className={styles.selectionToolbar}>
                    <Checkbox
                      label="Select all actionable files"
                      checked={selection.allSelected ? true : selection.someSelected ? "mixed" : false}
                      onChange={(_, data) => selection.toggleAll(data.checked === true)}
                    />
                    <Text size={200}>{selection.selectedIds.size} of {selection.selectableIds.length}</Text>
                  </div>
                  {items.map((item) => (
                    <div key={item.id} className={styles.row}>
                      <Checkbox
                        aria-label={`Retag ${item.path}`}
                        checked={selection.selectedIds.has(item.id)}
                        disabled={!selectableRetag(item)}
                        onChange={(event, data) => selection.toggle(
                          item.id,
                          data.checked === true,
                          Boolean((event.nativeEvent as MouseEvent).shiftKey),
                        )}
                      />
                      <div className={styles.item}>
                        <span className={styles.filename}>{item.path}</span>
                        {item.missing ? (
                          <span className={styles.warning}>Missing on disk</span>
                        ) : item.error ? (
                          <span className={styles.warning}>{item.error}</span>
                        ) : item.changes.map((change) => (
                          <div className={styles.change} key={change.field}>
                            <span className={styles.field}>{change.field}</span>
                            <span className={styles.oldValue}>{change.oldValue || "∅"}</span>
                            <ArrowRight16Regular />
                            <span className={styles.newValue}>{change.newValue || "∅"}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <Text>No files need retagging.</Text>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              appearance="primary"
              icon={applying ? <Spinner size="tiny" /> : <ArrowSortDownLines24Regular />}
              disabled={applying || selection.selectedIds.size === 0}
              onClick={() => onApply(Array.from(selection.selectedIds))}
            >
              {applyLabel} ({selection.selectedIds.size})
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
