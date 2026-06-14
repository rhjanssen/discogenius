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
        backgroundColor: "#ffffff",
    },
});

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
    const dim = `${size}px`;
    if (mark.monochrome) {
        return (
            <span
                aria-hidden="true"
                className={mergeClasses(styles.glyphMaskBase, tone === "onDark" ? styles.glyphOnDark : styles.glyphAuto, className)}
                style={{
                    width: dim,
                    height: dim,
                    WebkitMaskImage: `url("${mark.src}")`,
                    maskImage: `url("${mark.src}")`,
                }}
            />
        );
    }
    return (
        <img
            src={mark.src}
            alt=""
            aria-hidden="true"
            className={mergeClasses(styles.img, className)}
            style={{ width: dim, height: dim }}
        />
    );
};
