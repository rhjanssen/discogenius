import React from "react";
import {
  Persona,
  Link,
  makeStyles,
  tokens,
  mergeClasses,
} from "@fluentui/react-components";
import { useNavigate } from "react-router-dom";

interface ArtistPersonaProps {
  artistId?: string;
  artistName: string;
  avatarUrl?: string;
  className?: string;
}

const useStyles = makeStyles({
  // Flush left with Title1 — no chip padding/background (that read too tight
  // around Persona). Interaction follows Fluent Link: underline the name.
  root: {
    display: "inline-flex",
    alignItems: "center",
    minWidth: 0,
    margin: 0,
    padding: 0,
  },
  primaryText: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    color: "inherit",
  },
  // Inherit the persona type ramp; Link owns hover/focus underline.
  link: {
    fontWeight: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    color: "inherit",
  },
});

export const ArtistPersona: React.FC<ArtistPersonaProps> = ({
  artistId,
  artistName,
  avatarUrl,
  className,
}) => {
  const styles = useStyles();
  const navigate = useNavigate();

  const isClickable = Boolean(artistId);

  const goToArtist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (artistId) {
      navigate(`/artist/${artistId}`);
    }
  };

  return (
    <Persona
      className={mergeClasses(styles.root, className)}
      name={artistName}
      avatar={{
        image: { src: avatarUrl || undefined },
        size: 24,
      }}
      primaryText={{
        className: styles.primaryText,
        children: isClickable ? (
          <Link
            className={styles.link}
            href={`/artist/${artistId}`}
            onClick={goToArtist}
          >
            {artistName}
          </Link>
        ) : undefined,
      }}
    />
  );
};
