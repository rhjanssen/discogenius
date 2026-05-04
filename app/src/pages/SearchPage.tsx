import React from "react";
import { Body1, makeStyles, tokens, Title1 } from "@fluentui/react-components";
import { useSearchParams } from "react-router-dom";
import GlobalSearch from "@/components/GlobalSearch";
import { useTidalConnection } from "@/hooks/useTidalConnection";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalM,
  },
  content: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    width: "100%",
    maxWidth: "720px",
  },
  searchWrapper: {
    width: "100%",
    maxWidth: "100%",
    margin: "0 auto",
  },
  note: {
    textAlign: "center",
    color: tokens.colorNeutralForeground2,
    maxWidth: "720px",
    margin: "0 auto",
  },
});

const SearchPage = () => {
  const styles = useStyles();
  const [searchParams] = useSearchParams();
  const { remoteCatalogAvailable, providerAuthMode } = useTidalConnection();
  const query = searchParams.get("q")?.trim() ?? "";
  const localOnlyMessage = providerAuthMode === "mock"
    ? "Provider auth is mocked in this environment. Artist search still uses MusicBrainz/Lidarr metadata."
    : "Provider not connected. Artist search uses MusicBrainz/Lidarr metadata; provider availability, previews, followed artists, and downloads require connecting a provider.";

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <Title1 align="center">Search</Title1>
        {!remoteCatalogAvailable ? (
          <Body1 className={styles.note}>{localOnlyMessage}</Body1>
        ) : null}
        <div className={styles.searchWrapper}>
          <GlobalSearch key={query} autoFocus initialQuery={query} />
        </div>
      </div>
    </div>
  );
};

export default SearchPage;
