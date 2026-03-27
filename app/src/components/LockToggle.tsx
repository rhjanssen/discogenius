import React from "react";
import { Button, Tooltip, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { LockClosed24Regular, LockOpen24Regular } from "@fluentui/react-icons";
import { useMonitoring } from "@/hooks/useMonitoring";


interface LockToggleProps {
    id: string;
    type: "artist" | "album" | "track";
    isLocked: boolean;
    isMonitored?: boolean;
    className?: string;
}

export const LockToggle: React.FC<LockToggleProps> = ({
    id,
    type,
    isLocked,
    className,
}) => {
    const { toggleLock, isTogglingLock } = useMonitoring();
    const styles = useStyles();

    const handleClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        toggleLock({ id, type, isLocked });
    };

    const Icon = isLocked ? LockOpen24Regular : LockClosed24Regular;
    const label = isLocked ? "Unlock" : "Lock";
    const tooltipText = isLocked
        ? "Item is locked (Auto-filters won't change it)"
        : "Lock item to prevent auto-filters from changing status";

    return (
        <Tooltip content={tooltipText} relationship="label">
            <Button
                appearance="subtle"
                icon={<Icon />}
                className={mergeClasses(
                    styles.root,
                    isLocked ? styles.locked : styles.unlocked,
                    className
                )}
                onClick={handleClick}
                disabled={isTogglingLock}
                aria-label={label}
            />
        </Tooltip>
    );
};

const useStyles = makeStyles({
    root: {
        minWidth: "32px",
        width: "32px",
        height: "32px",
        padding: tokens.spacingVerticalNone,
        transitionProperty: "color, background-color, border-color",
        transitionDuration: tokens.durationNormal,
        transitionTimingFunction: tokens.curveEasyEase,
    },
    locked: {
        color: tokens.colorStatusDangerForeground1,
        ":hover": {
            color: tokens.colorStatusDangerForeground2,
        },
    },
    unlocked: {
        color: tokens.colorNeutralForeground3,
        ":hover": {
            color: tokens.colorBrandForeground1,
        },
    },
});
