import { useEffect, useState } from "react";

/**
 * Shared delayed-loading policy: returns true only once `active` has been
 * continuously true for `delayMs`. Loading placeholders (skeletons/spinners)
 * gated behind this never flash for sub-second cached requests; slow requests
 * still get their placeholder after the grace window. Fluent guidance reserves
 * skeletons for predictable layouts expected to take longer than about a
 * second, so the default grace window keeps fast cache hits placeholder-free.
 */
export function useDelayedVisible(active: boolean, delayMs = 300): boolean {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        if (!active) {
            setVisible(false);
            return;
        }
        const timer = window.setTimeout(() => setVisible(true), delayMs);
        return () => window.clearTimeout(timer);
    }, [active, delayMs]);

    return active && visible;
}
