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
import {
  AddCircle16Filled,
  SubtractCircle16Filled,
  ArrowRight16Regular,
  ArrowSortDownLines24Regular,
  Dismiss24Regular,
  ArrowRight16Filled,
  ArrowSortDownLines24Filled,
  Dismiss24Filled,
  Prohibited16Regular,
  Warning16Filled,
  ErrorCircle16Filled,
  Record20Regular,
  Video16Regular,
  Tag16Regular,
  bundleIcon,
} from "@fluentui/react-icons";
import { useSelectableCollection } from "@/hooks/useSelectableCollection";

const ArrowRight16 = bundleIcon(ArrowRight16Filled, ArrowRight16Regular);
const ArrowSortDownLines24 = bundleIcon(ArrowSortDownLines24Filled, ArrowSortDownLines24Regular);
const Dismiss24 = bundleIcon(Dismiss24Filled, Dismiss24Regular);

export interface RenamePreviewItem {
  id: number;
  file_type: string;
  file_path: string;
  expected_path: string | null;
  needs_rename: boolean;
  missing: boolean;
  conflict: boolean;
  drop_duplicate?: boolean;
  conflict_message?: string;
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
    maxWidth: "840px",
    width: "100%",
    "@media (max-width: 640px)": {
      width: "calc(100vw - 16px)",
      maxWidth: "100vw",
      margin: "8px",
      padding: "12px",
    },
  },
  summary: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    alignItems: "center",
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
    marginBottom: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    maxHeight: "56vh",
    overflow: "auto",
    paddingRight: tokens.spacingHorizontalXXS,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    gap: tokens.spacingHorizontalM,
    alignItems: "start",
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackgroundAlpha2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    transition: "background-color 0.15s ease",
    "&:hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
    },
    "@media (max-width: 640px)": {
      gap: tokens.spacingHorizontalS,
      padding: tokens.spacingVerticalS,
    },
  },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  headerLine: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  fileTypeBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    fontSize: tokens.fontSizeBase100,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontWeight: tokens.fontWeightBold,
    padding: "2px 8px",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground4,
    color: tokens.colorNeutralForeground2,
  },
  pathLine: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    fontSize: tokens.fontSizeBase200,
    fontFamily: tokens.fontFamilyMonospace,
  },
  oldPath: {
    color: tokens.colorPaletteRedForeground2,
    overflowWrap: "anywhere",
  },
  newPath: {
    color: tokens.colorPaletteGreenForeground2,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: "anywhere",
  },
  oldValue: {
    color: tokens.colorNeutralForeground3,
    overflowWrap: "anywhere",
    fontSize: tokens.fontSizeBase200,
  },
  newValue: {
    color: tokens.colorPaletteGreenForeground2,
    fontWeight: tokens.fontWeightSemibold,
    overflowWrap: "anywhere",
    fontSize: tokens.fontSizeBase200,
  },
  emptyValue: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    color: tokens.colorNeutralForeground4,
    fontStyle: "italic",
    fontSize: tokens.fontSizeBase100,
    padding: "1px 6px",
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackgroundAlpha,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
  },
  tagChangeRow: {
    display: "grid",
    gridTemplateColumns: "minmax(120px, 160px) minmax(0, 1fr)",
    alignItems: "center",
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke3}`,
    "@media (max-width: 640px)": {
      display: "flex",
      flexDirection: "column",
      alignItems: "stretch",
      gap: tokens.spacingVerticalXXS,
      padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
    },
  },
  tagDiffContainer: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto minmax(0, 1fr)",
    alignItems: "center",
    gap: tokens.spacingHorizontalS,
    minWidth: 0,
    "@media (max-width: 640px)": {
      display: "flex",
      flexDirection: "column",
      alignItems: "stretch",
      gap: tokens.spacingVerticalXXS,
      backgroundColor: tokens.colorNeutralBackgroundAlpha2,
      padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
      borderRadius: tokens.borderRadiusSmall,
      border: `1px solid ${tokens.colorNeutralStroke2}`,
    },
  },
  tagDiffValueBefore: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  tagDiffValueAfter: {
    display: "flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    minWidth: 0,
    overflowWrap: "anywhere",
  },
  tagDiffArrow: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground4,
    "@media (max-width: 640px)": {
      display: "none",
    },
  },
  tagDiffIndicatorOld: {
    display: "none",
    color: tokens.colorPaletteRedForeground2,
    flexShrink: 0,
    "@media (max-width: 640px)": {
      display: "inline-flex",
    },
  },
  tagDiffIndicatorNew: {
    display: "none",
    color: tokens.colorPaletteGreenForeground2,
    flexShrink: 0,
    "@media (max-width: 640px)": {
      display: "inline-flex",
    },
  },
  tagFieldLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXXS,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
  },
  warningBanner: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorPaletteRedForeground2,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  conflictBanner: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorPaletteYellowForeground2,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  intro: {
    color: tokens.colorNeutralForeground3,
    marginBottom: tokens.spacingVerticalS,
  },
});

function TagValueDisplay({ value, isNew = false }: { value: string | null; isNew?: boolean }) {
  const styles = useStyles();
  if (!value || value.trim() === "" || value === "0") {
    return (
      <span className={styles.emptyValue}>
        <Prohibited16Regular style={{ fontSize: 13, flexShrink: 0 }} />
        <span>∅ (empty)</span>
      </span>
    );
  }
  return <span className={isNew ? styles.newValue : styles.oldValue}>{value}</span>;
}

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

const selectableRename = (item: RenamePreviewItem) =>
  !item.missing && !item.conflict && (item.needs_rename || Boolean(item.drop_duplicate));
const selectableRetag = (item: RetagPreviewItem) => !item.missing && !item.error && item.changes.length > 0;

export function RenamePreviewDialog({
  open,
  items,
  applying,
  title = "Organize & Rename Preview",
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
                icon={<Dismiss24 />}
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
              {items.some((item) => item.conflict) && (
                <Badge appearance="outline" color="danger">
                  {items.filter((item) => item.conflict).length} conflicts
                </Badge>
              )}
              {items.some((item) => item.drop_duplicate) && (
                <Badge appearance="outline" color="warning">
                  {items.filter((item) => item.drop_duplicate).length} duplicates
                </Badge>
              )}
              {items.some((item) => item.missing) && (
                <Badge appearance="outline" color="important">
                  {items.filter((item) => item.missing).length} missing
                </Badge>
              )}
            </div>
            {items.length > 0 ? (
              <>
                <div className={styles.selectionToolbar}>
                  <Checkbox
                    label="Select all actionable files"
                    checked={selection.allSelected ? true : selection.someSelected ? "mixed" : false}
                    onChange={(_, data) => selection.toggleAll(data.checked === true)}
                  />
                  <Text size={200}>{selection.selectedIds.size} of {selection.selectableIds.length} actionable files</Text>
                </div>
                <div className={styles.list}>
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
                        <div className={styles.headerLine}>
                          <span className={styles.fileTypeBadge}>
                            {item.file_type === "video" ? <Video16Regular /> : <Record20Regular />}
                            {item.file_type}
                          </span>
                        </div>
                        <div className={styles.pathLine}>
                          <SubtractCircle16Filled style={{ color: tokens.colorPaletteRedForeground2, flexShrink: 0 }} />
                          <span className={styles.oldPath}>{item.file_path}</span>
                        </div>
                        {item.missing ? (
                          <div className={styles.warningBanner}>
                            <Warning16Filled />
                            <span>Missing on disk</span>
                          </div>
                        ) : item.conflict ? (
                          <div className={styles.warningBanner}>
                            <ErrorCircle16Filled />
                            <span>
                              {item.conflict_message || `Conflict: target path ${item.expected_path ?? "already exists"}. Row skipped.`}
                            </span>
                          </div>
                        ) : item.drop_duplicate ? (
                          <div className={styles.conflictBanner}>
                            <Warning16Filled />
                            <span>
                              {item.conflict_message || `Duplicate file — Apply keeps target and removes this file.`}
                            </span>
                          </div>
                        ) : (
                          <div className={styles.pathLine}>
                            <AddCircle16Filled style={{ color: tokens.colorPaletteGreenForeground2, flexShrink: 0 }} />
                            <span className={styles.newPath}>{item.expected_path ?? "target path unavailable"}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <Text>No files need renaming.</Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              appearance="primary"
              icon={applying ? <Spinner size="tiny" /> : <ArrowSortDownLines24 />}
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
                icon={<Dismiss24 />}
                onClick={() => onOpenChange(false)}
              />
            }
          >
            {title}
          </DialogTitle>
          <DialogContent>
            <Text size={200} className={styles.intro}>
              MusicBrainz identifiers are written alongside these changes. Compatible spatial files may be skipped when embedded tag rewriting is unsafe.
            </Text>
            {items.length > 0 ? (
              <>
                <div className={styles.summary}>
                  <Badge appearance="outline" color="brand">{items.length} files</Badge>
                  <Badge appearance="filled" color="informative">{selection.selectedIds.size} selected</Badge>
                  {items.some((item) => item.missing || item.error) && (
                    <Badge appearance="outline" color="warning">
                      {items.filter((item) => item.missing || item.error).length} unavailable
                    </Badge>
                  )}
                </div>
                <div className={styles.selectionToolbar}>
                  <Checkbox
                    label="Select all actionable files"
                    checked={selection.allSelected ? true : selection.someSelected ? "mixed" : false}
                    onChange={(_, data) => selection.toggleAll(data.checked === true)}
                  />
                  <Text size={200}>{selection.selectedIds.size} of {selection.selectableIds.length} actionable files</Text>
                </div>
                <div className={styles.list}>
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
                        <div className={styles.headerLine}>
                          <Record20Regular style={{ flexShrink: 0 }} />
                          <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{item.path}</span>
                        </div>
                        {item.missing ? (
                          <div className={styles.warningBanner}>
                            <Warning16Filled />
                            <span>Missing on disk</span>
                          </div>
                        ) : item.error ? (
                          <div className={styles.warningBanner}>
                            <ErrorCircle16Filled />
                            <span>{item.error}</span>
                          </div>
                        ) : item.changes.map((change) => (
                          <div className={styles.tagChangeRow} key={change.field}>
                            <span className={styles.tagFieldLabel}>
                              <Tag16Regular />
                              {change.field}
                            </span>
                            <div className={styles.tagDiffContainer}>
                              <div className={styles.tagDiffValueBefore}>
                                <SubtractCircle16Filled className={styles.tagDiffIndicatorOld} />
                                <TagValueDisplay value={change.oldValue} isNew={false} />
                              </div>
                              <ArrowRight16 className={styles.tagDiffArrow} />
                              <div className={styles.tagDiffValueAfter}>
                                <AddCircle16Filled className={styles.tagDiffIndicatorNew} />
                                <TagValueDisplay value={change.newValue} isNew={true} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <Text>No files need retagging.</Text>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              appearance="primary"
              icon={applying ? <Spinner size="tiny" /> : <ArrowSortDownLines24 />}
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
