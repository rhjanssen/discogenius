import { useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Link, Text, Title1, Body1, makeStyles, tokens } from "@fluentui/react-components";
import { useUltraBlurContext } from "@/providers/UltraBlurContext";
import { useTheme } from "@/providers/themeContext";

const useStyles = makeStyles({
  root: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "60vh",
    padding: tokens.spacingVerticalXL,
  },
  content: {
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    alignItems: "center",
  },
  code: {
    fontSize: "72px",
    fontWeight: tokens.fontWeightBold,
    lineHeight: "1",
    color: tokens.colorNeutralForeground1,
  },
  link: {
    color: tokens.colorBrandForeground1,
    textDecorationLine: "underline",
    ":hover": {
      color: tokens.colorBrandForeground2,
    },
  },
});

const NotFound = () => {
  const location = useLocation();
  const { setArtwork } = useUltraBlurContext();
  const { setBrandKeyColor } = useTheme();
  const styles = useStyles();

  useEffect(() => {
    setArtwork(undefined);
    setBrandKeyColor(null);
  }, [location.pathname, setArtwork, setBrandKeyColor]);

  return (
    <div className={styles.root}>
      <div className={styles.content}>
        <div className={styles.code}>404</div>
        <Title1>Page not found</Title1>
        <Body1 style={{ color: tokens.colorNeutralForeground2 }}>
          The page you're looking for doesn't exist or has been moved.
        </Body1>
        <Link href="/" className={styles.link}>
          Return to Library
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
