import type { CSSProperties, ReactNode } from "react";
import {
    CheckmarkCircle16Color,
    CheckmarkCircle24Color,
    DismissCircle16Color,
    DismissCircle24Color,
    QuestionCircle16Color,
    QuestionCircle24Color,
    Warning16Color,
    Warning24Color,
} from "@fluentui/react-icons";

export type SemanticStatus = "success" | "warning" | "error" | "unknown" | "info";
export type StatusIconWeight = "color" | "filled";

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

/**
 * Color artwork sits inside the viewBox, so a 16 Color glyph reads smaller
 * than a 16 Filled glyph. Draw Color one pixel larger and Filled one pixel
 * smaller in the same slot so mixed rows share one visual weight.
 */
const GLYPH_PX = {
    color: { 16: 17, 24: 25 },
    filled: { 16: 15, 24: 22 },
} as const;

export function statusIconGlyphPx(weight: StatusIconWeight, size: 16 | 24 = 16): number {
    return GLYPH_PX[weight][size];
}

export function statusIconGlyphStyle(weight: StatusIconWeight, size: 16 | 24 = 16): CSSProperties {
    const px = statusIconGlyphPx(weight, size);
    return { width: px, height: px };
}

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
