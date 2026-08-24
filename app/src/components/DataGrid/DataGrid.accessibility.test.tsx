import axe from "axe-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataGrid, type DataGridColumn } from "./DataGrid";

type TestRow = {
    id: number;
    name: string;
};

const rows: TestRow[] = [{ id: 1, name: "Bastille" }];

afterEach(cleanup);

describe("DataGrid row accessibility", () => {
    it("makes clickable rows focusable and operable with Enter and Space", () => {
        const onRowClick = vi.fn();
        const columns: DataGridColumn<TestRow>[] = [{
            key: "name",
            header: "Artist",
            width: "1fr",
            render: (item) => item.name,
        }];

        render(
            <DataGrid
                ariaLabel="Artists"
                columns={columns}
                items={rows}
                onRowClick={onRowClick}
            />
        );

        const row = screen.getAllByRole("row")[1];
        expect(row).toHaveAttribute("tabindex", "0");

        fireEvent.keyDown(row, { key: "Enter" });
        fireEvent.keyDown(row, { key: " " });

        expect(onRowClick).toHaveBeenCalledTimes(2);
        expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);
    });

    it("does not activate the row from nested interactive controls", () => {
        const onRowClick = vi.fn();
        const onButtonClick = vi.fn();
        const columns: DataGridColumn<TestRow>[] = [{
            key: "actions",
            header: "Actions",
            width: "1fr",
            render: () => <button onClick={onButtonClick}>Download</button>,
        }];

        render(
            <DataGrid
                ariaLabel="Artists"
                columns={columns}
                items={rows}
                onRowClick={onRowClick}
            />
        );

        const button = screen.getByRole("button", { name: "Download" });
        fireEvent.click(button);
        fireEvent.keyDown(button, { key: "Enter" });

        expect(onButtonClick).toHaveBeenCalledOnce();
        expect(onRowClick).not.toHaveBeenCalled();
    });

    it("does not add a tab stop to non-interactive rows", () => {
        const columns: DataGridColumn<TestRow>[] = [{
            key: "name",
            header: "Artist",
            width: "1fr",
            render: (item) => item.name,
        }];

        render(<DataGrid ariaLabel="Artists" columns={columns} items={rows} />);

        expect(screen.getAllByRole("row")[1]).not.toHaveAttribute("tabindex");
    });

    it("keeps header, content, section, and detail rows structurally valid", async () => {
        const columns: DataGridColumn<TestRow>[] = [{
            key: "name",
            header: "Artist",
            width: "1fr",
            render: (item) => item.name,
        }];

        const { container } = render(
            <DataGrid
                ariaLabel="Artists"
                columns={columns}
                items={rows}
                renderBeforeRow={() => <span>Featured artists</span>}
                renderRowDetail={() => <button>Play Bastille</button>}
            />
        );

        const grid = screen.getByRole("grid", { name: "Artists" });
        const renderedRows = screen.getAllByRole("row");
        expect(renderedRows).toHaveLength(4);
        expect(renderedRows[0].children[0]).toHaveAttribute("role", "columnheader");
        for (const row of renderedRows.slice(1)) {
            expect(Array.from(row.children).every((child) => child.getAttribute("role") === "gridcell")).toBe(true);
        }

        // The grid is not virtualized. Let assistive technology infer the count,
        // including optional section and detail rows, from the rendered tree.
        expect(grid).not.toHaveAttribute("aria-rowcount");
        expect((await axe.run(container)).violations).toEqual([]);
    });
});
