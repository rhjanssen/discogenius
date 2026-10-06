import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RenamePreviewDialog, type RenamePreviewItem } from "./FileMaintenanceDialogs";

afterEach(cleanup);

it("lets users verify a duplicate candidate while leaving ordinary conflicts disabled", () => {
  const items: RenamePreviewItem[] = [
    {id:1,file_type:"track",file_path:"/library/source.flac",expected_path:"/library/target.flac",
      needs_rename:true,missing:false,conflict:true,verify_duplicate:true,conflict_message:"Possible duplicate. Apply verifies the audio."},
    {id:2,file_type:"track",file_path:"/library/other.flac",expected_path:"/library/occupied.flac",
      needs_rename:true,missing:false,conflict:true},
  ];
  const apply=vi.fn();
  render(<RenamePreviewDialog open items={items} applying={false} onOpenChange={vi.fn()} onApply={apply} />);
  expect(screen.getByRole("checkbox",{name:"Rename /library/source.flac"})).toBeEnabled();
  expect(screen.getByRole("checkbox",{name:"Rename /library/other.flac"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Rename / verify selected files (1)"}));
  expect(apply).toHaveBeenCalledWith([1]);
});
