import React from "react";
import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { providerMarkFor } from "./providerMarks";

const useStyles = makeStyles({
    img: {
        display: "block",
        objectFit: "contain",
        flexShrink: 0,
    },
    // Recoloured to the theme foreground via masking so a white monochrome mark
    // never disappears on a same-colour surface (the white TIDAL bug).
    glyph: {
        display: "block",
        flexShrink: 0,
        backgroundColor: tokens.colorNeutralForeground1,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
    },
});

interface ProviderMarkProps {
    provider?: string | null;
    /** Rendered icon size in px (square). */
    size?: number;
    className?: string;
}

/**
 * A streaming provider's brand mark, rendered theme-aware: monochrome marks
 * (TIDAL) are tinted with the theme foreground so they read on any surface;
 * full-colour marks keep their brand colours. Returns null for unknown
 * providers so callers can fall back to an initial.
 */
export const ProviderMark: React.FC<ProviderMarkProps> = ({ provider, size = 16, className }) => {
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
                className={mergeClasses(styles.glyph, className)}
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
