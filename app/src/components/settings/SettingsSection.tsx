import { Caption1, Title3, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import type { ReactNode } from "react";

interface SettingsSectionProps {
    id: string;
    title: string;
    description: ReactNode;
    children: ReactNode;
    className?: string;
    actions?: ReactNode;
}

const useStyles = makeStyles({
    section: {
        display: "flex",
        width: "100%",
        minWidth: 0,
        flexDirection: "column",
        // Tight header→card gap; panel-level column supplies section spacing.
        gap: tokens.spacingVerticalS,
        scrollMarginTop: tokens.spacingVerticalXXXL,
    },
    header: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: tokens.spacingHorizontalM,
        flexWrap: "wrap",
    },
    heading: {
        display: "flex",
        flexDirection: "column",
        gap: tokens.spacingVerticalXXS,
        minWidth: 0,
    },
    title: {
        margin: 0,
    },
    description: {
        color: tokens.colorNeutralForeground2,
        maxWidth: "72ch",
    },
    actions: {
        display: "flex",
        alignItems: "flex-start",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "wrap",
    },
    body: {
        display: "flex",
        flexDirection: "column",
        // Fluent size200 (20px) between stacked Cards in one section.
        gap: tokens.spacingVerticalL,
        width: "100%",
        minWidth: 0,
    },
});

export const SettingsSection = ({
    id,
    title,
    description,
    children,
    className,
    actions,
}: SettingsSectionProps) => {
    const styles = useStyles();

    return (
        <section id={id} className={mergeClasses(styles.section, className)}>
            <div className={styles.header}>
                <div className={styles.heading}>
                    <Title3 className={styles.title}>{title}</Title3>
                    <Caption1 className={styles.description}>{description}</Caption1>
                </div>
                {actions ? <div className={styles.actions}>{actions}</div> : null}
            </div>
            <div className={styles.body}>{children}</div>
        </section>
    );
};

export default SettingsSection;
