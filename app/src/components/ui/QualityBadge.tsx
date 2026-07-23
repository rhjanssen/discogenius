import React from "react";
import { Badge, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { tidalBadgeColor, tidalBadgeColorLight } from "@/theme/theme";
import { useTheme } from "@/providers/themeContext";
import { isSpatialAudioQuality, normalizeQualityTag } from "@/utils/spatialAudio";
import {
  isUnknownQualityTag,
  isVideoResolutionQuality,
  qualityDescription,
  stereoQualityTier,
  videoQualityTier,
} from "@/utils/qualityTier";
import {
  ATMOS_LOGO_HEIGHT_PX,
  BADGE_HEIGHT_PX,
  type DiscogeniusBadgeSize,
} from "./badgeSizes";
import { ATMOS_OPTICAL_NUDGE_PX, badgeGlassFill } from "./badgeChrome";
import { AppTooltip } from "./AppTooltip";

export type AudioQuality = string;

type BadgeSize = DiscogeniusBadgeSize;

export function formatQualityForSlot(quality: string | null | undefined, isVideo = false): string {
  const norm = String(quality || "").trim().toUpperCase();
  if (isVideo && (!norm || !isVideoResolutionQuality(norm))) {
    if (norm === "MAX" || norm === "HIRES" || norm === "UHD" || norm === "2160P") return "UHD";
    if (norm === "HIGH" || norm === "LOSSLESS" || norm === "FHD" || norm === "1080P") return "FHD";
    if (norm === "NORMAL" || norm === "HD" || norm === "720P") return "HD";
    if (norm === "LOW" || norm === "SD" || norm === "480P") return "SD";
    return "FHD";
  }
  return String(quality || "");
}

interface QualityBadgeProps {
  quality: string;
  className?: string;
  size?: BadgeSize;
  /** Override the default tier description (e.g. probed local file props). */
  tooltip?: string | null;
  /**
   * When false, skip the Fluent tooltip — parents that wrap the badge in a
   * richer offer tooltip (ProviderQualityRow) should pass false.
   */
  showTooltip?: boolean;
}

// Horizontal "Dolby Atmos" lockup aspect ratio (viewBox 110.76 × 15.64).
const ATMOS_ASPECT = 110.7599945 / 15.6427517;

const useStyles = makeStyles({
  // Own the layout entirely — do not lean on Fluent Badge size padding, which
  // differs across small/medium/large and throws off logo vs text centering.
  base: {
    fontWeight: tokens.fontWeightSemibold,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    flexShrink: 0,
    whiteSpace: "nowrap",
    minWidth: "max-content",
    lineHeight: 1,
    verticalAlign: "middle",
    paddingTop: 0,
    paddingBottom: 0,
    "::after": {
      display: "none",
    },
  },
  label: {
    textTransform: "uppercase",
    letterSpacing: "0",
  },
  textLabel: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    opacity: 1,
  },
  small: {
    height: `${BADGE_HEIGHT_PX.small}px`,
    minHeight: `${BADGE_HEIGHT_PX.small}px`,
    maxHeight: `${BADGE_HEIGHT_PX.small}px`,
    fontSize: tokens.fontSizeBase100,
    paddingLeft: tokens.spacingHorizontalSNudge,
    paddingRight: tokens.spacingHorizontalSNudge,
  },
  medium: {
    height: `${BADGE_HEIGHT_PX.medium}px`,
    minHeight: `${BADGE_HEIGHT_PX.medium}px`,
    maxHeight: `${BADGE_HEIGHT_PX.medium}px`,
    fontSize: tokens.fontSizeBase200,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
  },
  large: {
    height: `${BADGE_HEIGHT_PX.large}px`,
    minHeight: `${BADGE_HEIGHT_PX.large}px`,
    maxHeight: `${BADGE_HEIGHT_PX.large}px`,
    fontSize: tokens.fontSizeBase300,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
  },
  atmos: {
    lineHeight: 0,
  },
  atmosLogo: {
    display: "block",
    flexShrink: 0,
    opacity: 1,
    WebkitMaskImage: 'url("/assets/images/dolby_atmos_horizontal.svg")',
    maskImage: 'url("/assets/images/dolby_atmos_horizontal.svg")',
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
  },
});

export const QualityBadge: React.FC<QualityBadgeProps> = ({
  quality,
  className,
  size = "medium",
  tooltip,
  showTooltip = true,
}) => {
  const styles = useStyles();
  const { isDarkMode } = useTheme();
  const palette = isDarkMode ? tidalBadgeColor : tidalBadgeColorLight;

  const normalizedQuality = normalizeQualityTag(quality);
  const sizeClass = size === "small" ? styles.small : size === "large" ? styles.large : styles.medium;
  const description = String(tooltip || qualityDescription(quality) || "").trim();

  if (isUnknownQualityTag(normalizedQuality)) {
    return null;
  }

  let backgroundColor: string = badgeGlassFill(palette.SpatialBackground, isDarkMode);
  let color: string = palette.SpatialText;
  let badgeText = quality;
  let isAtmosLogo = false;

  if (normalizedQuality === "DOLBY_ATMOS") {
    isAtmosLogo = true;
    badgeText = "Dolby Atmos";
  } else if (isSpatialAudioQuality(normalizedQuality)) {
    badgeText = "Spatial";
  } else if (isVideoResolutionQuality(normalizedQuality)) {
    const tier = videoQualityTier(normalizedQuality);
    if (!tier) return null;
    badgeText = tier;
  } else {
    const tier = stereoQualityTier(normalizedQuality);
    badgeText = tier;
    if (tier === "MAX") {
      backgroundColor = badgeGlassFill(palette.YellowBackground, isDarkMode);
      color = palette.YellowText;
    } else if (tier === "HIGH") {
      backgroundColor = badgeGlassFill(palette.TealBackground, isDarkMode);
      color = palette.TealText;
    }
  }

  const badgeAria = showTooltip ? undefined : badgeText;
  const badgeHidden = showTooltip ? true : undefined;

  const badge = isAtmosLogo ? (() => {
    const logoHeight = ATMOS_LOGO_HEIGHT_PX[size];
    const nudge = ATMOS_OPTICAL_NUDGE_PX[size];
    return (
      <Badge
        shape="circular"
        appearance="tint"
        size="medium"
        className={mergeClasses(styles.base, styles.atmos, sizeClass, className)}
        style={{ backgroundColor: badgeGlassFill(palette.SpatialBackground, isDarkMode) }}
        aria-label={badgeAria}
        aria-hidden={badgeHidden}
      >
        <span
          aria-hidden="true"
          className={styles.atmosLogo}
          style={{
            height: `${logoHeight}px`,
            width: `${Math.round(logoHeight * ATMOS_ASPECT)}px`,
            backgroundColor: palette.SpatialText,
            transform: `translateY(${nudge}px)`,
          }}
        />
      </Badge>
    );
  })() : (
    <Badge
      shape="circular"
      appearance="tint"
      size="medium"
      className={mergeClasses(styles.base, styles.label, sizeClass, className)}
      style={{ backgroundColor, color }}
      aria-label={badgeAria}
      aria-hidden={badgeHidden}
    >
      <span className={styles.textLabel}>{badgeText}</span>
    </Badge>
  );

  if (!showTooltip) {
    return badge;
  }

  return (
    <AppTooltip content={description || badgeText} relationship="description" withArrow>
      <span style={{ display: "inline-flex" }} aria-label={badgeText}>
        {badge}
      </span>
    </AppTooltip>
  );
};
