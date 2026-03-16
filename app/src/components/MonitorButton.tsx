import React from "react";
import { Button, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { Eye24Regular, EyeOff24Regular } from "@fluentui/react-icons";
import { useMonitoring } from "@/hooks/useMonitoring";

interface MonitorButtonProps {
    id: string;
    type: "artist" | "album" | "track";
    isMonitored: boolean;
    isLocked?: boolean; // If item is locked, maybe disable regular monitor toggle? Or show lock icon overlay?
    className?: string;
    size?: "default" | "sm" | "lg" | "icon";
    variant?: "default" | "outline" | "ghost";
    showLabel?: boolean;
}

export const MonitorButton: React.FC<MonitorButtonProps> = ({
    id,
    type,
    isMonitored,
    isLocked,
    className,
    size = "default",
    variant,
    showLabel = true,
}) => {
    const { toggleMonitor, isTogglingMonitor } = useMonitoring();
    const styles = useStyles();

    // If locked, we generally shouldn't allow simple monitor toggling without unlocking first?
    // Or maybe clicking this hints that it's locked.
    // For now, let's assume this button handles standard monitoring.

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (isLocked) {
            // Maybe show toast? "Item is locked. Unlock to change status."
            // Or just do nothing.
            return;
        }
        toggleMonitor({ id, type, currentStatus: isMonitored });
    };

    // Determine appearance
    // Monitored = Primary (Solid)
    // Unmonitored = Outline or Ghost (depending on context)

    const finalAppearance = (
        variant === "ghost"
            ? "subtle"
            : variant === "outline"
                ? "outline"
                : (isMonitored ? "subtle" : "primary")
    ) as "primary" | "outline" | "subtle" | "transparent" | "secondary";

    const label = isMonitored ? "Unmonitor" : "Monitor";
    const Icon = isMonitored ? EyeOff24Regular : Eye24Regular;

    return (
        <Button
            appearance={finalAppearance}
            size={size === "icon" ? "medium" : (size === "sm" ? "small" : (size === "lg" ? "large" : "medium"))}
            icon={<Icon />}
            className={mergeClasses(
                styles.root,
                isLocked && styles.locked,
                className
            )}
            onClick={handleClick}
            disabled={isTogglingMonitor}
        >
            {showLabel && label}
        </Button>
    );
};

const useStyles = makeStyles({
    root: {
        transitionProperty: "all",
        transitionDuration: tokens.durationNormal,
        transitionTimingFunction: tokens.curveEasyEase,
    },
    locked: {
        opacity: 0.7,
        cursor: "not-allowed",
    },
});
