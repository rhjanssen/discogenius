import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtistLibraryScopeDialog } from "./ArtistLibraryScopeDialog";

afterEach(cleanup);

const libraries = [
  { id: 1, name: "Stereo", root_path: "D:\\Music" },
  { id: 2, name: "Spatial", root_path: "D:\\Atmos" },
];

describe("ArtistLibraryScopeDialog", () => {
  it("submits the exact libraries and policy the operator chose", async () => {
    const onConfirm = vi.fn();
    render(
      <ArtistLibraryScopeDialog
        open
        action="monitor"
        artistName="Bastille"
        libraries={libraries}
        initialLibraryIds={[1, 2]}
        initialPolicy="all"
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Spatial" }));
    fireEvent.click(screen.getByRole("radio", { name: /Only releases newer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Monitor" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith([1], "new"));
  });

  it("requires a deliberate library selection and gives every checkbox its own label", async () => {
    const onConfirm = vi.fn();
    render(
      <ArtistLibraryScopeDialog
        open
        action="unmonitor"
        artistName="Bakermat"
        libraries={libraries}
        initialLibraryIds={[]}
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Unmonitor" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Select at least one library.");
    expect(onConfirm).not.toHaveBeenCalled();
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.map((checkbox) => checkbox.id)).toHaveLength(new Set(checkboxes.map((checkbox) => checkbox.id)).size);
    expect(screen.getByRole("checkbox", { name: "Stereo" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Spatial" })).toBeInTheDocument();
  });
});
