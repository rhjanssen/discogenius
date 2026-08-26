export interface AlbumMonitorActionPresentation {
  disabled: boolean;
  label: "Monitor" | "Monitored";
  tooltip: string;
}

/**
 * Album Lock protects the user's choice from automation. It does not prevent
 * that same user from explicitly changing the monitored state.
 */
export function getAlbumMonitorActionPresentation({
  isLocked,
  isMonitored,
  isPending,
}: {
  isLocked: boolean;
  isMonitored: boolean;
  isPending: boolean;
}): AlbumMonitorActionPresentation {
  const label = isMonitored ? "Monitored" : "Monitor";
  const action = isMonitored ? "Stop monitoring" : "Start monitoring";

  return {
    disabled: isPending,
    label,
    tooltip: isLocked
      ? `${action}. Lock only prevents automatic curation changes; manual changes remain available.`
      : action,
  };
}
