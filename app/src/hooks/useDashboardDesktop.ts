import { useEffect, useState } from "react";

/** Matches the breakpoint where dashboard sections stop stacking. */
export function useDashboardDesktop(): boolean {
    const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 960px)").matches);
    useEffect(() => {
        const media = window.matchMedia("(min-width: 960px)");
        const update = () => setDesktop(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);
    return desktop;
}
