import React from "react";
import { Badge, BadgeProps, mergeClasses } from "@fluentui/react-components";

/**
 * Warning badge using Fluent UI's built-in "severe" color (dark orange palette).
 * Since our brand color is orange, we can also use "brand" for similar effect.
 * 
 * Fluent UI Badge colors:
 * - "warning" = yellow palette (colorPaletteYellow*)
 * - "severe" = dark orange palette (colorPaletteDarkOrange*) - better contrast
 * - "brand" = brand colors (our orange)
 */

interface WarningBadgeProps extends Omit<BadgeProps, "color"> {
    /** Use tint appearance for less prominent badges */
    tint?: boolean;
    /** Use brand color instead of severe (both are orange-ish) */
    useBrand?: boolean;
}

export const WarningBadge: React.FC<WarningBadgeProps> = ({
    children,
    className,
    tint = false,
    useBrand = false,
    appearance,
    ...props
}) => {
    // Use "warning" (yellow) by default, or "brand" if specified
    const color = useBrand ? "brand" : "warning";
    const badgeAppearance = tint ? "tint" : (appearance || "filled");

    return (
        <Badge
            {...props}
            color={color}
            appearance={badgeAppearance}
            className={className}
        >
            {children}
        </Badge>
    );
};

export default WarningBadge;
