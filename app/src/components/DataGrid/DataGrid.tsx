/**
 * Shared DataGrid component — configurable table/list view with sticky header,
 * responsive column hiding, row click, hover states, and optional row selection.
 */
import React, { useCallback, useMemo } from "react";
import {
    Checkbox,
    makeStyles,
    mergeClasses,
    Text,
    tokens,
} from "@fluentui/react-components";
import { DataGridSkeleton } from "@/components/ui/LoadingSkeletons";

export interface DataGridColumn<T = any> {
    key: string;
    header: React.ReactNode;
    width: string;
    render: (item: T, index: number) => React.ReactNode;
    align?: "left" | "center" | "right";
    minWidth?: number;
    className?: string;
}

export interface DataGridProps<T = any> {
    columns: DataGridColumn<T>[];
    items: T[];
    getRowKey?: (item: T) => string | number;
    onRowClick?: (item: T) => void;
    loading?: boolean;
    emptyContent?: React.ReactNode;
    className?: string;
    disableStickyHeader?: boolean;
    compact?: boolean;
    disableResponsiveColumnHiding?: boolean;
    selection?: {
        selectedRowIds: Array<string | number>;
        onSelectionChange: (selectedRowIds: Array<string | number>) => void;
        getSelectionLabel?: (item: T) => string;
        isRowSelectable?: (item: T) => boolean;
    };
    getRowClassName?: (item: T, index: number) => string | undefined;
}

const useStyles = makeStyles({
    root: {
        display: "flex",
        flexDirection: "column",
        width: "100%",
    },
    header: {
        display: "grid",
        gap: tokens.spacingHorizontalXS,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        width: "100%",
        minWidth: "100%",
        boxSizing: "border-box",
        backgroundColor: tokens.colorNeutralBackgroundAlpha2,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        fontWeight: tokens.fontWeightSemibold,
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground2,
        position: "sticky",
        top: 0,
        zIndex: 10,
        backdropFilter: "blur(10px)",
        "@media (min-width: 768px)": {
            gap: tokens.spacingHorizontalS,
            padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
        },
    },
    row: {
        display: "grid",
        gap: tokens.spacingHorizontalXS,
        padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalS}`,
        alignItems: "center",
        width: "100%",
        minWidth: "100%",
        boxSizing: "border-box",
        backgroundColor: tokens.colorSubtleBackground,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        transition: `background-color ${tokens.durationFast} ${tokens.curveEasyEase}`,
        "&:hover": {
            backgroundColor: tokens.colorNeutralBackgroundAlpha,
        },
        "@media (min-width: 768px)": {
            gap: tokens.spacingHorizontalS,
            padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
        },
    },
    rowClickable: {
        cursor: "pointer",
    },
    rowCompact: {
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        "@media (min-width: 768px)": {
            padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
        },
    },
    rowSelected: {
        backgroundColor: tokens.colorSubtleBackgroundSelected,
        "&:hover": {
            backgroundColor: tokens.colorSubtleBackgroundSelected,
        },
    },
    cellLeft: { textAlign: "left" },
    cellCenter: { textAlign: "center", justifyContent: "center" },
    cellRight: { textAlign: "right", justifyContent: "flex-end" },
    headerCell: {
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
    },
    selectionHeaderCell: {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
    },
    loading: {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: tokens.spacingVerticalXXXL,
    },
    empty: {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: tokens.spacingVerticalXXXL,
        color: tokens.colorNeutralForeground3,
    },
    cell: {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        minWidth: 0,
    },
    selectionCell: {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minWidth: 0,
    },
});

function useMediaQuery(query: string) {
    const [matches, setMatches] = React.useState(false);

    React.useEffect(() => {
        const media = window.matchMedia(query);
        if (media.matches !== matches) {
            setMatches(media.matches);
        }

        const listener = () => setMatches(media.matches);
        media.addEventListener("change", listener);
        return () => media.removeEventListener("change", listener);
    }, [matches, query]);

    return matches;
}

function DataGridInner<T>(
    {
        columns,
        items,
        getRowKey,
        onRowClick,
        loading,
        emptyContent,
        className,
        disableStickyHeader,
        compact,
        disableResponsiveColumnHiding,
        selection,
        getRowClassName,
    }: DataGridProps<T>,
    ref: React.Ref<HTMLDivElement>
) {
    const styles = useStyles();
    const isMobile = useMediaQuery("(max-width: 767px)");

    const visibleColumns = useMemo(
        () => disableResponsiveColumnHiding
            ? columns
            : columns.filter((column) => !column.minWidth || (!isMobile || column.minWidth <= 767)),
        [columns, disableResponsiveColumnHiding, isMobile]
    );

    const defaultKey = useCallback(
        (item: T) => (item as any).id ?? String(item),
        []
    );

    const keyFn = getRowKey ?? defaultKey;
    const selectedRowIds = useMemo(
        () => selection?.selectedRowIds ?? [],
        [selection?.selectedRowIds]
    );

    const selectedRowIdSet = useMemo(
        () => new Set(selectedRowIds),
        [selectedRowIds]
    );

    const selectableRowIds = useMemo(() => {
        if (!selection) {
            return [] as Array<string | number>;
        }

        return items
            .filter((item) => selection.isRowSelectable?.(item) ?? true)
            .map((item) => keyFn(item));
    }, [items, keyFn, selection]);

    const allSelectableSelected = selectableRowIds.length > 0
        && selectableRowIds.every((rowId) => selectedRowIdSet.has(rowId));
    const someSelectableSelected = !allSelectableSelected
        && selectableRowIds.some((rowId) => selectedRowIdSet.has(rowId));

    const gridTemplate = useMemo(
        () => [selection ? "44px" : null, ...visibleColumns.map((column) => column.width)].filter(Boolean).join(" "),
        [selection, visibleColumns]
    );

    const gridStyle: React.CSSProperties = {
        gridTemplateColumns: gridTemplate,
    };

    const handleRowClick = useCallback((item: T) => {
        onRowClick?.(item);
    }, [onRowClick]);

    const toggleAllRows = useCallback((checked: boolean) => {
        if (!selection) {
            return;
        }

        selection.onSelectionChange(checked ? selectableRowIds : []);
    }, [selectableRowIds, selection]);

    const toggleRow = useCallback((rowId: string | number, checked: boolean) => {
        if (!selection) {
            return;
        }

        const nextSelection = checked
            ? Array.from(new Set([...selectedRowIds, rowId]))
            : selectedRowIds.filter((currentRowId) => currentRowId !== rowId);
        selection.onSelectionChange(nextSelection);
    }, [selectedRowIds, selection]);

    if (loading) {
        return (
            <div className={mergeClasses(styles.root, className)}>
                <DataGridSkeleton columns={Math.max(visibleColumns.length + (selection ? 1 : 0), 3)} rows={8} />
            </div>
        );
    }

    if (!items || items.length === 0) {
        return (
            <div className={mergeClasses(styles.root, className)}>
                <div className={styles.empty}>
                    {emptyContent ?? <Text>No items</Text>}
                </div>
            </div>
        );
    }

    return (
        <div className={mergeClasses(styles.root, className)} ref={ref} role="grid" aria-rowcount={items.length + 1}>
            <div
                className={styles.header}
                role="row"
                style={{
                    ...gridStyle,
                    ...(disableStickyHeader ? { position: "relative" } : {}),
                }}
            >
                {selection ? (
                    <div className={mergeClasses(styles.headerCell, styles.selectionHeaderCell)} role="columnheader">
                        <Checkbox
                            checked={allSelectableSelected ? true : someSelectableSelected ? "mixed" : false}
                            aria-label="Select all visible rows"
                            onChange={(_, data) => toggleAllRows(Boolean(data.checked))}
                        />
                    </div>
                ) : null}
                {visibleColumns.map((column) => (
                    <div
                        key={column.key}
                        role="columnheader"
                        className={mergeClasses(
                            styles.headerCell,
                            column.align === "center"
                                ? styles.cellCenter
                                : column.align === "right"
                                    ? styles.cellRight
                                    : styles.cellLeft,
                            column.className
                        )}
                        style={column.minWidth ? { ["--dg-min" as any]: `${column.minWidth}px` } : undefined}
                        data-dg-min={column.minWidth}
                    >
                        {column.header}
                    </div>
                ))}
            </div>

            {items.map((item, index) => {
                const rowId = keyFn(item);
                const rowSelected = selectedRowIdSet.has(rowId);

                return (
                    <div
                        key={rowId}
                        role="row"
                        className={mergeClasses(
                            styles.row,
                            onRowClick ? styles.rowClickable : undefined,
                            compact ? styles.rowCompact : undefined,
                            rowSelected ? styles.rowSelected : undefined,
                            getRowClassName?.(item, index)
                        )}
                        style={gridStyle}
                        onClick={onRowClick ? () => handleRowClick(item) : undefined}
                    >
                        {selection ? (
                            <div className={styles.selectionCell} role="gridcell">
                                <Checkbox
                                    checked={rowSelected}
                                    disabled={!(selection.isRowSelectable?.(item) ?? true)}
                                    aria-label={selection.getSelectionLabel?.(item) || `Select row ${index + 1}`}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={(_, data) => toggleRow(rowId, Boolean(data.checked))}
                                />
                            </div>
                        ) : null}
                        {visibleColumns.map((column) => (
                            <div
                                key={column.key}
                                role="gridcell"
                                className={mergeClasses(
                                    styles.cell,
                                    column.align === "center"
                                        ? styles.cellCenter
                                        : column.align === "right"
                                            ? styles.cellRight
                                            : styles.cellLeft,
                                    column.className
                                )}
                                data-dg-min={column.minWidth}
                            >
                                {column.render(item, index)}
                            </div>
                        ))}
                    </div>
                );
            })}
        </div>
    );
}

export const DataGrid = React.forwardRef(DataGridInner) as <T>(
    props: DataGridProps<T> & { ref?: React.Ref<HTMLDivElement> }
) => React.ReactElement | null;

export default DataGrid;
