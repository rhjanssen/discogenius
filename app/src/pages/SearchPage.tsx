import { makeStyles, tokens, Title1 } from "@fluentui/react-components";
import { useSearchParams } from "react-router-dom";
import GlobalSearch from "@/components/GlobalSearch";

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
});
const SearchPage = () => {
  const styles = useStyles();
  const [searchParams] = useSearchParams();
  const query = searchParams.get("q")?.trim() ?? "";

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <Title1 align="center">Search Library</Title1>
        <div className={styles.searchWrapper}>
          <GlobalSearch key={query} autoFocus initialQuery={query} />
        </div>
      </div>
    </div>
  );
};

export default SearchPage;
