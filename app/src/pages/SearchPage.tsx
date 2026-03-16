import React from "react";
import { makeStyles, tokens, Title1 } from "@fluentui/react-components";
import GlobalSearch from "@/components/GlobalSearch";

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
});

const SearchPage = () => {
  const styles = useStyles();

  return (
    <div className={styles.container}>
      <Title1 align="center">Search</Title1>
      <div className={styles.searchWrapper}>
        <GlobalSearch autoFocus />
      </div>
    </div>
  );
};

export default SearchPage;
