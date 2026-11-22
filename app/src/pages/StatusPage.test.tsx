import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { afterEach, describe, expect, it } from "vitest";
import type { HealthCheckResultContract } from "@contracts/system-status";
import { CheckList } from "./StatusPage";

afterEach(cleanup);

function check(scope: string, status: HealthCheckResultContract["status"], message: string): HealthCheckResultContract {
  return { scope, status, message } as HealthCheckResultContract;
}

describe("Status page health checks", () => {
  it("leads with the problems and folds the passing checks away", () => {
    render(
      <FluentProvider theme={webLightTheme}>
        <CheckList
          checks={[
            check("paths.config", "ok", "Config directory is writable"),
            check("paths.database", "ok", "Database file is writable"),
            check("tools.tiddl", "error", "tiddl is not available on PATH"),
          ]}
        />
      </FluentProvider>,
    );

    expect(screen.getByText("tiddl is not available on PATH")).toBeTruthy();
    expect(screen.queryByText("Config directory is writable")).toBeNull();

    const disclosure = screen.getByRole("button", { name: "2 checks passed" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
    expect(screen.getByText("Config directory is writable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide passing checks" }).getAttribute("aria-expanded")).toBe("true");
  });
});
