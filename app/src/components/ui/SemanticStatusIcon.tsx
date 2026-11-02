import type { ReactNode } from "react";
import {
    CheckmarkCircle16Filled,
    CheckmarkCircle24Filled,
    Clock16Filled,
    Clock16Regular,
    Clock24Filled,
    Clock24Regular,
    DismissCircle16Filled,
    DismissCircle24Filled,
    QuestionCircle16Filled,
    QuestionCircle24Filled,
    Prohibited16Regular,
    Prohibited24Regular,
    Warning16Filled,
    Warning24Filled,
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

function filledStatusIcon(status: SemanticStatus, size: 16 | 24, iconProps: Record<string, unknown>) {
    if (size === 24) {
        if (status === "success") return <CheckmarkCircle24Filled {...iconProps} />;
        if (status === "warning") return <Warning24Filled {...iconProps} />;
        if (status === "error") return <DismissCircle24Filled {...iconProps} />;
        return <QuestionCircle24Filled {...iconProps} />;
    }
    if (status === "success") return <CheckmarkCircle16Filled {...iconProps} />;
    if (status === "warning") return <Warning16Filled {...iconProps} />;
    if (status === "error") return <DismissCircle16Filled {...iconProps} />;
    return <QuestionCircle16Filled {...iconProps} />;
}

export function SemanticStatusIcon({ status, size = 16, className, ...props }: SemanticStatusIconProps) {
    const glyph = statusIconGlyphPx("filled", size);
    return (
        <StatusIconSlot size={size} className={className}>
            {filledStatusIcon(status, size, {
                ...props,
                fontSize: glyph,
                style: { ...statusIconGlyphStyle("filled", size),
                    color: status === "success" ? tokens.colorPaletteGreenForeground2 : tokens.colorNeutralForeground2 },
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

export function CancelledStatusIcon({ size = 16, className, ...props }: Omit<SemanticStatusIconProps, "status">) {
    const glyph = statusIconGlyphPx("regular", size);
    const Icon = size === 24 ? Prohibited24Regular : Prohibited16Regular;

    return (
        <StatusIconSlot size={size} className={className}>
            <Icon
                {...props}
                fontSize={glyph}
                style={{
                    ...statusIconGlyphStyle("regular", size),
                    color: tokens.colorNeutralForeground3,
                }}
            />
        </StatusIconSlot>
    );
}
