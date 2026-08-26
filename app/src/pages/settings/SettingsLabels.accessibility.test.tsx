import axe from "axe-core";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import { AudioQualitySettingsSection } from "./AudioQualitySettingsSection";
import { MetadataFilesSettingsSection } from "./MetadataFilesSettingsSection";
import { MetadataSourceSettingsSection } from "./MetadataSourceSettingsSection";
import { MusicVideosSettingsSection } from "./MusicVideosSettingsSection";
import { NamingSettingsSection } from "./NamingSettingsSection";

afterEach(cleanup);

function renderSettings(children: React.ReactNode) {
  return render(<FluentProvider theme={webLightTheme}>{children}</FluentProvider>);
}

describe("Settings control labels", () => {
  it("names radio groups and every radio option", async () => {
    const { container } = renderSettings(
      <>
        <AppearanceSettingsSection theme="light" onThemeChange={vi.fn()} />
        <AudioQualitySettingsSection
          audioQuality="max"
          includeSpatial={false}
          onAudioQualityChange={vi.fn()}
          onIncludeSpatialChange={vi.fn()}
        />
        <MetadataSourceSettingsSection
          catalogConfig={null}
          catalogTest={{ status: "idle" }}
          onUpdateCatalog={vi.fn()}
          onHostChange={vi.fn()}
          onTestConnection={vi.fn()}
        />
        <MusicVideosSettingsSection
          curationConfig={null}
          videoQuality="uhd"
          videoFolderLayout="separated"
          onUpdateCuration={vi.fn()}
          onVideoQualityChange={vi.fn()}
          onVideoFolderLayoutChange={vi.fn()}
        />
      </>,
    );

    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Preferred stereo audio quality" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Max/ })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Metadata source" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /MusicBrainz \(local\)/ })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Preferred video quality" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Ultra HD/ })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("names adjacent selects, switches, and path inputs", async () => {
    const { container } = renderSettings(
      <>
        <MetadataFilesSettingsSection
          metadataSettings={null}
          updateMetadataSettings={vi.fn()}
          embedCover={true}
          onEmbedCoverChange={vi.fn()}
        />
        <NamingSettingsSection
          pathSettings={null}
          updatePathSettings={vi.fn()}
          namingSettings={null}
          updateNamingSettings={vi.fn()}
        />
      </>,
    );

    expect(screen.getByRole("combobox", { name: "Write audio tags" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Preferred artwork" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Music Library Path" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Spatial Library Path" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Video Library Path" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Create Empty Artist Folders" })).toBeInTheDocument();
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
