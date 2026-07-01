import React, { useEffect, useState } from "react";
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
import { ArrowSortDownLines24Regular, Dismiss24Regular } from "@fluentui/react-icons";

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
  warning: {
    color: tokens.colorPaletteRedForeground2,
    overflowWrap: "anywhere",
  },
  intro: {
    color: tokens.colorNeutralForeground3,
  },
});

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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const selectableItems = items.filter((item) => !item.missing && !item.conflict);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedIds(new Set(items.filter((item) => !item.missing && !item.conflict).map((item) => item.id)));
  }, [open, items]);

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
              <Badge appearance="outline" color="warning">{items.filter((item) => item.conflict).length} conflicts</Badge>
              <Badge appearance="outline" color="informative">{items.filter((item) => item.missing).length} missing</Badge>
            </div>
            {items.length > 0 ? (
              <div className={styles.list}>
                <Checkbox
                  label="Select all available changes"
                  checked={selectedIds.size > 0 && selectedIds.size === selectableItems.length}
                  onChange={(_, data) => setSelectedIds(data.checked
                    ? new Set(selectableItems.map((item) => item.id))
                    : new Set())}
                />
                {items.map((item) => (
                  <div key={item.id} className={styles.row}>
                    <Checkbox
                      aria-label={`Rename ${item.file_path}`}
                      checked={selectedIds.has(item.id)}
                      disabled={item.missing || item.conflict}
                      onChange={(_, data) => setSelectedIds((current) => {
                        const next = new Set(current);
                        if (data.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })}
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
              disabled={applying || selectedIds.size === 0}
              onClick={() => onApply(Array.from(selectedIds))}
            >
              {applyLabel}
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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const selectableItems = items.filter((item) => !item.missing);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedIds(new Set(items.filter((item) => !item.missing).map((item) => item.id)));
  }, [open, items]);

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
                  <Checkbox
                    label="Select all available changes"
                    checked={selectedIds.size > 0 && selectedIds.size === selectableItems.length}
                    onChange={(_, data) => setSelectedIds(data.checked
                      ? new Set(selectableItems.map((item) => item.id))
                      : new Set())}
                  />
                  {items.map((item) => (
                    <div key={item.id} className={styles.row}>
                      <Checkbox
                        aria-label={`Retag ${item.path}`}
                        checked={selectedIds.has(item.id)}
                        disabled={item.missing}
                        onChange={(_, data) => setSelectedIds((current) => {
                          const next = new Set(current);
                          if (data.checked) next.add(item.id);
                          else next.delete(item.id);
                          return next;
                        })}
                      />
                      <div className={styles.item}>
                        <span className={styles.filename}>{item.path}</span>
                        {item.missing ? (
                          <span className={styles.warning}>Missing on disk</span>
                        ) : item.changes.map((change) => (
                          <React.Fragment key={change.field}>
                            <span className={styles.oldValue}>- {change.field}: {change.oldValue ?? "(empty)"}</span>
                            <span className={styles.newValue}>+ {change.field}: {change.newValue ?? "(empty)"}</span>
                          </React.Fragment>
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
              disabled={applying || selectedIds.size === 0}
              onClick={() => onApply(Array.from(selectedIds))}
            >
              {applyLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
