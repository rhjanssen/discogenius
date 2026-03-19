import React from "react";
import { Body1, makeStyles, tokens, Title1 } from "@fluentui/react-components";
import GlobalSearch from "@/components/GlobalSearch";
import { useTidalConnection } from "@/hooks/useTidalConnection";

const useStyles = makeStyles({
  container: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalM,
    minHeight: "100vh",
  },
  searchWrapper: {
    width: "100%",
    maxWidth: "600px",
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
  const { remoteCatalogAvailable, providerAuthMode } = useTidalConnection();
  const localOnlyMessage = providerAuthMode === "mock"
    ? "Provider auth is mocked in this environment. Search results are limited to your indexed local library."
    : "Disconnected mode is active. Search results are limited to your indexed local library.";

  return (
    <div className={styles.container}>
      <Title1 align="center">Search</Title1>
      {!remoteCatalogAvailable ? (
        <Body1 className={styles.note}>{localOnlyMessage}</Body1>
      ) : null}
      <div className={styles.searchWrapper}>
        <GlobalSearch autoFocus />
      </div>
    </div>
  );
};

export default SearchPage;
