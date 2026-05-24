import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { glassButtonStyles } from "@/components/ui/glassButtonStyles";

const useBaseStyles = makeStyles({
    tabSlot: {
        minWidth: 0,
        flex: "1 1 auto",
    },
    mobileSelect: {
        display: "block",
        "@media (min-width: 640px)": {
            display: "none",
        },
    },
    desktopTabs: {
        display: "none",
        "@media (min-width: 640px)": {
            display: "block",
        },
    },
    menuButton: {
        ...glassButtonStyles,
        minHeight: "36px",
        "@media (max-width: 639px)": {
            minHeight: "40px",
            minWidth: "40px",
            paddingLeft: tokens.spacingHorizontalS,
            paddingRight: tokens.spacingHorizontalS,
        },
    },
});

const useAlwaysTabStyles = makeStyles({
    mobileSelect: { display: "none" },
    desktopTabs: { display: "block" },
});

export function useResponsiveTabsStyles({ collapseOnMobile = true }: { collapseOnMobile?: boolean } = {}) {
    const base = useBaseStyles();
    const always = useAlwaysTabStyles();

    if (!collapseOnMobile) {
        return {
            ...base,
            mobileSelect: mergeClasses(base.mobileSelect, always.mobileSelect),
            desktopTabs: mergeClasses(base.desktopTabs, always.desktopTabs),
        };
    }

    return base;
}
