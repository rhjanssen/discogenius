import React from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { providerMarkFor } from "./providerMarks";

const useStyles = makeStyles({
    img: {
        display: "block",
        objectFit: "contain",
        flexShrink: 0,
    },
    glyphMaskBase: {
        display: "block",
        flexShrink: 0,
        WebkitMaskImage: 'url("/assets/images/tidal_icon.svg")',
        maskImage: 'url("/assets/images/tidal_icon.svg")',
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
    },
    // "auto": tinted with the theme foreground so a white monochrome mark never
    // disappears on a same-colour neutral surface (the white TIDAL bug).
    glyphAuto: {
        backgroundColor: tokens.colorNeutralForeground1,
    },
    // "onDark": always white, for placement on a fixed dark chip (so TIDAL reads
    // white-on-black to match the Dolby Atmos badge, in both themes).
    glyphOnDark: {
        backgroundColor: tokens.colorNeutralForegroundStaticInverted,
    },
    size12: {
        width: "12px",
        height: "12px",
    },
    size14: {
        width: "14px",
        height: "14px",
    },
    size16: {
        width: "16px",
        height: "16px",
    },
    size20: {
        width: "20px",
        height: "20px",
    },
    size24: {
        width: "24px",
        height: "24px",
    },
    size28: {
        width: "28px",
        height: "28px",
    },
});

function getSizeClassName(styles: ReturnType<typeof useStyles>, size: number): string {
    switch (size) {
        case 12:
            return styles.size12;
        case 14:
            return styles.size14;
        case 20:
            return styles.size20;
        case 24:
            return styles.size24;
        case 28:
            return styles.size28;
        case 16:
        default:
            return styles.size16;
    }
}

interface ProviderMarkProps {
    provider?: string | null;
    /** Rendered icon size in px (square). */
    size?: number;
    /**
     * "auto" tints monochrome marks with the theme foreground (use on neutral
     * surfaces). "onDark" forces them white for a fixed dark chip.
     */
    tone?: "auto" | "onDark";
    className?: string;
}

/**
 * A streaming provider's brand mark, rendered theme-aware: monochrome marks
 * (TIDAL) are tinted (or forced white on dark chips) so they read on any
 * surface; full-colour marks keep their brand colours. Returns null for unknown
 * providers so callers can fall back to an initial.
 */
export const ProviderMark: React.FC<ProviderMarkProps> = ({ provider, size = 16, tone = "auto", className }) => {
    const styles = useStyles();
    const mark = providerMarkFor(provider);
    if (!mark) {
        return null;
    }
    const sizeClass = getSizeClassName(styles, size);
    if (mark.monochrome) {
        return (
            <span
                aria-hidden="true"
                className={mergeClasses(
                    styles.glyphMaskBase,
                    sizeClass,
                    tone === "onDark" ? styles.glyphOnDark : styles.glyphAuto,
                    className,
                )}
            />
        );
    }
    return (
        <img
            src={mark.src}
            alt=""
            width={size}
            height={size}
            aria-hidden="true"
            className={mergeClasses(styles.img, sizeClass, className)}
        />
    );
};
