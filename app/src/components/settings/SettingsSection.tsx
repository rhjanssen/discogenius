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
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
        breakInside: "avoid",
        WebkitColumnBreakInside: "avoid",
        pageBreakInside: "avoid",
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
    },
    actions: {
        display: "flex",
        alignItems: "flex-start",
        gap: tokens.spacingHorizontalXS,
        flexWrap: "wrap",
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
            {children}
        </section>
    );
};

export default SettingsSection;
