import type { ReactNode } from "react";
import {
    CheckmarkCircle16Color,
    CheckmarkCircle24Color,
    Clock16Filled,
    Clock16Regular,
    Clock24Filled,
    Clock24Regular,
    DismissCircle16Color,
    DismissCircle24Color,
    QuestionCircle16Color,
    QuestionCircle24Color,
    Warning16Color,
    Warning24Color,
    bundleIcon,
} from "@fluentui/react-icons";
import { tokens } from "@fluentui/react-components";
import { statusIconGlyphPx, statusIconGlyphStyle } from "./statusIconMetrics";

const Clock16 = bundleIcon(Clock16Filled, Clock16Regular);
const Clock24 = bundleIcon(Clock24Filled, Clock24Regular);

export type SemanticStatus = "success" | "warning" | "error" | "unknown" | "info";

type SemanticStatusIconProps = {
    status: SemanticStatus;
    size?: 16 | 24;
    className?: string;
    title?: string;
    "aria-label"?: string;
};

type StatusIconSlotProps = {
    size?: 16 | 24;
    className?: string;
    children: ReactNode;
};

export function StatusIconSlot({ size = 16, className, children }: StatusIconSlotProps) {
    return (
        <span
            className={className}
            style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: size,
                height: size,
                flexShrink: 0,
                overflow: "visible",
                lineHeight: 0,
            }}
        >
            {children}
        </span>
    );
}

function colorStatusIcon(status: SemanticStatus, size: 16 | 24, iconProps: Record<string, unknown>) {
    if (size === 24) {
        if (status === "success") return <CheckmarkCircle24Color {...iconProps} />;
        if (status === "warning") return <Warning24Color {...iconProps} />;
        if (status === "error") return <DismissCircle24Color {...iconProps} />;
        return <QuestionCircle24Color {...iconProps} />;
    }
    if (status === "success") return <CheckmarkCircle16Color {...iconProps} />;
    if (status === "warning") return <Warning16Color {...iconProps} />;
    if (status === "error") return <DismissCircle16Color {...iconProps} />;
    return <QuestionCircle16Color {...iconProps} />;
}

export function SemanticStatusIcon({ status, size = 16, className, ...props }: SemanticStatusIconProps) {
    const glyph = statusIconGlyphPx("color", size);
    return (
        <StatusIconSlot size={size} className={className}>
            {colorStatusIcon(status, size, {
                ...props,
                fontSize: glyph,
                style: statusIconGlyphStyle("color", size),
            })}
        </StatusIconSlot>
    );
}

export function QueuedStatusIcon({ size = 16, className, ...props }: Omit<SemanticStatusIconProps, "status">) {
    const glyph = statusIconGlyphPx("filled", size);
    const Clock = size === 24 ? Clock24 : Clock16;

    return (
        <StatusIconSlot size={size} className={className}>
            <Clock
                {...props}
                fontSize={glyph}
                style={{
                    ...statusIconGlyphStyle("filled", size),
                    color: tokens.colorNeutralForeground3,
                }}
            />
        </StatusIconSlot>
    );
}
