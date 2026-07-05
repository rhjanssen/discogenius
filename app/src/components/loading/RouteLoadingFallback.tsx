import { Spinner, makeStyles, tokens } from "@fluentui/react-components";

const useStyles = makeStyles({
  root: {
    minHeight: "240px",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: tokens.spacingHorizontalL,
    boxSizing: "border-box",
  },
});

export default function RouteLoadingFallback() {
  const styles = useStyles();

  return (
    <div className={styles.root} aria-hidden="true">
      <Spinner size="medium" />
    </div>
  );
}
