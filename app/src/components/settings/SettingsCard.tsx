import { Card, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import type { ReactNode } from "react";
import { glassSurfaceStyles } from "@/components/ui/glassSurfaceStyles";

interface SettingsCardProps {
    children: ReactNode;
    className?: string;
}

const useStyles = makeStyles({
    card: {
        ...glassSurfaceStyles,
        // Row dividers live inside; zero padding so Settings rows edge-align.
        padding: tokens.spacingVerticalNone,
        overflow: "hidden",
        width: "100%",
        boxSizing: "border-box",
    },
});

/**
 * Fluent Card shell for settings groups. Uses the shared glass surface so
 * cards sit consistently over UltraBlur / page chrome.
 */
export const SettingsCard = ({ children, className }: SettingsCardProps) => {
    const styles = useStyles();
    return (
        <Card appearance="filled-alternative" className={mergeClasses(styles.card, className)}>
            {children}
        </Card>
    );
};

export default SettingsCard;
