/**
 * Shared DataGrid component — configurable table/list view with sticky header,
 * responsive column hiding, row click, hover states, and optional row selection.
 */
import React, { useCallback, useMemo, useRef } from "react";
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
    /**
     * Minimum width while interactively resizing (px). Defaults to 80.
     * Do NOT reuse responsive hide breakpoints here — that made columns explode
     * to 700–1100px on first drag.
     */
    minWidth?: number;
    /**
     * Hide this column when the viewport is narrower than this many pixels.
     * Separate from resize minWidth so hide breakpoints do not become resize floors.
     */
    hideBelowWidth?: number;
    className?: string;
    /** Media/thumbnail cells: no ellipsis clip, keep intrinsic artwork size. */
    media?: boolean;
    /** Allow multi-line / wrapping cell content (Fluent list primary+description stacks). */
    wrap?: boolean;
}

export type DataGridRowProps = Omit<
    React.HTMLAttributes<HTMLDivElement>,
    "className" | "style" | "onClick" | "role"
> & {
    [key: `data-${string}`]: string | number | boolean | undefined;
};

export interface DataGridProps<T = any> {
    columns: DataGridColumn<T>[];
    items: T[];
    getRowKey?: (item: T) => string | number;
    onRowClick?: (item: T) => void;
    loading?: boolean;
    emptyContent?: React.ReactNode;
    className?: string;
    /** Accessible name for the grid, for example "Track list". */
    ariaLabel?: string;
    disableStickyHeader?: boolean;
    /**
     * Render the header + all rows as CSS subgrids of one parent grid, so
     * content-sized columns (max-content) resolve to the SAME width across every
     * row and the header and stay aligned. Without this each row is its own grid
     * and a max-content column sizes to that row's content, misaligning columns.
     * Requires all rows to be in the DOM (no windowing) — true for the track list.
     */
    sharedColumns?: boolean;
    compact?: boolean;
    disableResponsiveColumnHiding?: boolean;
    resizableColumns?: boolean;
    columnResizeStorageKey?: string;
    selection?: {
        selectedRowIds: Array<string | number>;
        onSelectionChange: (selectedRowIds: Array<string | number>) => void;
        getSelectionLabel?: (item: T) => string;
        isRowSelectable?: (item: T) => boolean;
    };
    getRowClassName?: (item: T, index: number) => string | undefined;
    /** Stable row metadata used by deep links, tests, and other consumers. */
    getRowProps?: (item: T, index: number) => DataGridRowProps;
    /**
     * Optional full-width content rendered directly under a row (spanning all
     * columns). Return null for rows with no detail. Used e.g. for the inline
     * track audio player so tracks can live in this shared grid.
     */
    renderRowDetail?: (item: T, index: number) => React.ReactNode | null;
    /**
     * Optional full-width content rendered directly before a row. This keeps
     * section dividers such as album volume headers in the shared grid path.
     */
    renderBeforeRow?: (item: T, index: number, previousItem?: T) => React.ReactNode | null;
}

const useStyles = makeStyles({
    root: {
        display: "flex",
        flexDirection: "column",
        width: "100%",
    },
    // sharedColumns: the root becomes the one grid that owns the column tracks;
    // the header and every row are subgrids of it, so content-sized columns
    // resolve identically across all rows. Keep horizontal padding on the
    // header/rows themselves (do not zero it) so the first media column cannot
    // sit flush against a clipping overflow ancestor.
    rootSharedColumns: {
        display: "grid",
        boxSizing: "border-box",
        columnGap: tokens.spacingHorizontalS,
    },
    sharedGridRow: {
        gridColumn: "1 / -1",
        gridTemplateColumns: "subgrid",
    },
    sharedFullWidthRow: {
        gridColumn: "1 / -1",
    },
    header: {
        display: "grid",
        gap: tokens.spacingHorizontalXS,
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        width: "100%",
        minWidth: "100%",
        boxSizing: "border-box",
        backgroundColor: "transparent",
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        fontWeight: tokens.fontWeightSemibold,
        fontSize: tokens.fontSizeBase200,
        color: tokens.colorNeutralForeground2,
        position: "sticky",
        top: 0,
        zIndex: 10,
        "@media (min-width: 768px)": {
            gap: tokens.spacingHorizontalS,
            padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
        },
    },
    row: {
        display: "grid",
        gap: tokens.spacingHorizontalXS,
        // Keep a real horizontal inset on narrow viewports so the first media
        // column cannot sit flush against a clipping overflow ancestor.
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
            backdropFilter: "blur(14px) saturate(140%)",
            WebkitBackdropFilter: "blur(14px) saturate(140%)",
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
        paddingTop: tokens.spacingVerticalXS,
        paddingBottom: tokens.spacingVerticalXS,
    },
    rowSelected: {
        backgroundColor: tokens.colorSubtleBackgroundSelected,
        "&:hover": {
            backgroundColor: tokens.colorSubtleBackgroundSelected,
        },
    },
    cellLeft: { textAlign: "left", justifyContent: "flex-start" },
    cellCenter: { textAlign: "center", justifyContent: "center" },
    cellRight: { textAlign: "right", justifyContent: "flex-end" },
    headerCell: {
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        position: "relative",
        minWidth: 0,
    },
    columnResizeHandle: {
        position: "absolute",
        top: 0,
        right: "-4px",
        width: "8px",
        height: "100%",
        cursor: "col-resize",
        touchAction: "none",
        zIndex: 2,
        "::after": {
            content: '""',
            position: "absolute",
            top: "20%",
            bottom: "20%",
            left: "3px",
            width: tokens.strokeWidthThin,
            backgroundColor: "transparent",
        },
        ":hover::after": {
            backgroundColor: tokens.colorNeutralStroke1,
        },
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
    cellWrap: {
        overflow: "hidden",
        whiteSpace: "normal",
        minWidth: 0,
    },
    cellMedia: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "visible",
        minWidth: "auto",
        whiteSpace: "normal",
        textOverflow: "clip",
    },
    selectionCell: {
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minWidth: 0,
    },
    rowDetail: {
        padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalM} ${tokens.spacingVerticalS}`,
        borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
        backgroundColor: tokens.colorSubtleBackground,
    },
    rowBefore: {
        padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalM} ${tokens.spacingVerticalXXS}`,
        color: tokens.colorNeutralForeground2,
        fontWeight: tokens.fontWeightSemibold,
        backgroundColor: tokens.colorSubtleBackground,
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

function useViewportWidth() {
    const [width, setWidth] = React.useState(() => (
        typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth
    ));

    React.useEffect(() => {
        const updateWidth = () => setWidth(window.innerWidth);
        updateWidth();
        window.addEventListener("resize", updateWidth);
        return () => window.removeEventListener("resize", updateWidth);
    }, []);

    return width;
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
        ariaLabel,
        disableStickyHeader,
        sharedColumns,
        compact,
        disableResponsiveColumnHiding,
        resizableColumns,
        columnResizeStorageKey,
        selection,
        getRowClassName,
        getRowProps,
        renderRowDetail,
        renderBeforeRow,
    }: DataGridProps<T>,
    ref: React.Ref<HTMLDivElement>
) {
    const styles = useStyles();
    const viewportWidth = useViewportWidth();
    const isMobile = useMediaQuery("(max-width: 767px)");
    const [columnWidths, setColumnWidths] = React.useState<Record<string, string>>(() => {
        if (!columnResizeStorageKey || typeof window === "undefined") {
            return {};
        }
        try {
            const parsed = JSON.parse(window.localStorage.getItem(columnResizeStorageKey) || "{}");
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? parsed as Record<string, string>
                : {};
        } catch {
            return {};
        }
    });

    React.useEffect(() => {
        if (!columnResizeStorageKey || typeof window === "undefined") {
            return;
        }
        window.localStorage.setItem(columnResizeStorageKey, JSON.stringify(columnWidths));
    }, [columnResizeStorageKey, columnWidths]);

    const visibleColumns = useMemo(
        () => disableResponsiveColumnHiding
            ? columns
            : columns.filter((column) => {
                const hideBelow = column.hideBelowWidth ?? column.minWidth;
                return !hideBelow || viewportWidth >= hideBelow;
            }),
        [columns, disableResponsiveColumnHiding, viewportWidth]
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
    const lastToggledRowIdRef = useRef<string | number | null>(null);
    const pendingRangeSelectionRef = useRef(false);

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
        () => {
            const tracks = [
                selection ? "44px" : null,
                ...visibleColumns.map((column) => {
                    const width = columnWidths[column.key] ?? column.width;
                    // Fixed px tracks must not shrink under minWidth:0 cells, or
                    // cover art in the first column gets clipped by overflow:hidden.
                    if (/^\d+px$/.test(width)) {
                        return `minmax(${width}, ${width})`;
                    }
                    return width;
                }),
            ].filter(Boolean) as string[];
            return tracks.join(" ");
        },
        [columnWidths, selection, visibleColumns]
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
        lastToggledRowIdRef.current = null;
    }, [selectableRowIds, selection]);

    const toggleRow = useCallback((rowId: string | number, checked: boolean, range: boolean) => {
        if (!selection) {
            return;
        }

        const currentIndex = selectableRowIds.indexOf(rowId);
        const previousIndex = lastToggledRowIdRef.current == null
            ? -1
            : selectableRowIds.indexOf(lastToggledRowIdRef.current);
        const affectedRowIds = range && currentIndex >= 0 && previousIndex >= 0
            ? selectableRowIds.slice(Math.min(currentIndex, previousIndex), Math.max(currentIndex, previousIndex) + 1)
            : [rowId];
        const nextSelection = new Set(selectedRowIds);
        for (const affectedRowId of affectedRowIds) {
            if (checked) {
                nextSelection.add(affectedRowId);
            } else {
                nextSelection.delete(affectedRowId);
            }
        }
        selection.onSelectionChange(Array.from(nextSelection));
        lastToggledRowIdRef.current = rowId;
    }, [selectableRowIds, selectedRowIds, selection]);

    const beginColumnResize = useCallback((event: React.PointerEvent<HTMLSpanElement>, column: DataGridColumn<T>) => {
        if (!resizableColumns || isMobile) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const headerCell = event.currentTarget.parentElement;
        const startX = event.clientX;
        const startWidth = headerCell?.getBoundingClientRect().width ?? 120;
        // Resize floor is only the explicit resize minWidth (or 80). Never treat
        // hideBelowWidth / legacy large minWidth hide breakpoints as a floor.
        const minWidth = Math.max(56, column.minWidth ?? 80);
        const maxWidth = Math.max(minWidth, Math.round(window.innerWidth * 0.55));

        const handleMove = (moveEvent: PointerEvent) => {
            const nextWidth = Math.min(
                maxWidth,
                Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX)),
            );
            setColumnWidths((current) => ({ ...current, [column.key]: `${nextWidth}px` }));
        };

        const handleUp = () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("pointerup", handleUp);
            window.removeEventListener("pointercancel", handleUp);
        };

        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", handleUp);
        window.addEventListener("pointercancel", handleUp);
    }, [isMobile, resizableColumns]);

    if (loading) {
        return (
            <div className={mergeClasses(styles.root, className)}>
                <DataGridSkeleton
                    columns={Math.max(visibleColumns.length + (selection ? 1 : 0), 3)}
                    rows={8}
                    columnTemplate={gridTemplate}
                    compact={Boolean(compact)}
                />
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
        <div
            className={mergeClasses(styles.root, sharedColumns ? styles.rootSharedColumns : undefined, className)}
            ref={ref}
            role="grid"
            aria-label={ariaLabel}
            aria-rowcount={items.length + 1}
            style={sharedColumns ? gridStyle : undefined}
        >
            <div
                className={mergeClasses(styles.header, sharedColumns ? styles.sharedGridRow : undefined)}
                role="row"
                style={{
                    ...(sharedColumns ? {} : gridStyle),
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
                        style={column.hideBelowWidth || column.minWidth
                            ? { ["--dg-min" as any]: `${column.minWidth ?? 80}px` }
                            : undefined}
                        data-dg-min={column.minWidth}
                        data-dg-hide-below={column.hideBelowWidth}
                    >
                        {column.header}
                        {resizableColumns && !isMobile ? (
                            <span
                                className={styles.columnResizeHandle}
                                role="separator"
                                aria-orientation="vertical"
                                aria-label={`Resize ${typeof column.header === "string" ? column.header : column.key} column`}
                                onPointerDown={(event) => beginColumnResize(event, column)}
                            />
                        ) : null}
                    </div>
                ))}
            </div>

            {items.map((item, index) => {
                const rowId = keyFn(item);
                const rowSelected = selectedRowIdSet.has(rowId);
                const beforeRow = renderBeforeRow?.(item, index, index > 0 ? items[index - 1] : undefined) ?? null;
                const rowDetail = renderRowDetail?.(item, index) ?? null;
                const rowProps = getRowProps?.(item, index);

                return (
                    <React.Fragment key={rowId}>
                        {beforeRow ? (
                            <div className={mergeClasses(styles.rowBefore, sharedColumns ? styles.sharedFullWidthRow : undefined)} role="row">
                                {beforeRow}
                            </div>
                        ) : null}
                        <div
                            {...rowProps}
                            role="row"
                            className={mergeClasses(
                                styles.row,
                                onRowClick ? styles.rowClickable : undefined,
                                compact ? styles.rowCompact : undefined,
                                rowSelected ? styles.rowSelected : undefined,
                                sharedColumns ? styles.sharedGridRow : undefined,
                                getRowClassName?.(item, index)
                            )}
                            style={sharedColumns ? undefined : gridStyle}
                            onClick={onRowClick ? () => handleRowClick(item) : undefined}
                        >
                            {selection ? (
                                <div className={styles.selectionCell} role="gridcell">
                                    <Checkbox
                                        checked={rowSelected}
                                        disabled={!(selection.isRowSelectable?.(item) ?? true)}
                                        aria-label={selection.getSelectionLabel?.(item) || `Select row ${index + 1}`}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            pendingRangeSelectionRef.current = event.shiftKey;
                                        }}
                                        onChange={(event, data) => toggleRow(
                                            rowId,
                                            Boolean(data.checked),
                                            pendingRangeSelectionRef.current
                                                || Boolean((event.nativeEvent as MouseEvent).shiftKey),
                                        )}
                                    />
                                </div>
                            ) : null}
                            {visibleColumns.map((column) => (
                                <div
                                    key={column.key}
                                    role="gridcell"
                                    className={mergeClasses(
                                        column.media || column.key === "thumb" || column.key === "cover"
                                            ? styles.cellMedia
                                            : column.wrap
                                                ? styles.cellWrap
                                                : styles.cell,
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
                        {rowDetail ? (
                            <div
                                className={mergeClasses(styles.rowDetail, sharedColumns ? styles.sharedFullWidthRow : undefined)}
                                role="row"
                                onClick={(event) => event.stopPropagation()}
                            >
                                {rowDetail}
                            </div>
                        ) : null}
                    </React.Fragment>
                );
            })}
        </div>
    );
}

export const DataGrid = React.forwardRef(DataGridInner) as <T>(
    props: DataGridProps<T> & { ref?: React.Ref<HTMLDivElement> }
) => React.ReactElement | null;

export default DataGrid;

