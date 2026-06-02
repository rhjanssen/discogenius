import React from "react";
import { Persona, makeStyles, tokens, mergeClasses } from "@fluentui/react-components";
import { useNavigate } from "react-router-dom";

interface ArtistPersonaProps {
  artistId?: string;
  artistName: string;
  avatarUrl?: string;
  className?: string;
}

const useStyles = makeStyles({
  root: {
    display: "inline-flex",
    alignItems: "center",
    cursor: "pointer",
    backgroundColor: "transparent",
    color: "inherit",
    border: 0,
    font: "inherit",
    textAlign: "left",
    borderRadius: tokens.borderRadiusMedium,
    padding: `0 ${tokens.spacingHorizontalXS}`,
    transition: `background-color ${tokens.durationFast} ${tokens.curveEasyEase}`,
    transform: "translateY(1px)",
    ":hover": {
      backgroundColor: tokens.colorNeutralBackgroundAlpha,
      opacity: 0.9,
    },
  },
  rootDisabled: {
    cursor: "default",
    ":hover": {
      backgroundColor: "transparent",
      opacity: 1,
    },
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

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (artistId) {
      navigate(`/artist/${artistId}`);
    }
  };

  const isClickable = Boolean(artistId);

  return (
    <button
      type="button"
      className={mergeClasses(
        styles.root,
        !isClickable && styles.rootDisabled,
        className
      )}
      onClick={isClickable ? handleClick : undefined}
      disabled={!isClickable}
    >
      <Persona
        name={artistName}
        avatar={{
          image: { src: avatarUrl || undefined },
          size: 24,
        }}
        primaryText={{
          style: {
            fontWeight: tokens.fontWeightSemibold,
            fontSize: tokens.fontSizeBase400,
          }
        }}
      />
    </button>
  );
};
