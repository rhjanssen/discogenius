import { Spinner, Text, makeStyles, mergeClasses, tokens } from "@fluentui/react-components";

interface LoadingStateProps {
    label?: string;
    size?: "extra-tiny" | "tiny" | "extra-small" | "small" | "medium" | "large" | "huge";
    className?: string;
    panelClassName?: string;
}

const useStyles = makeStyles({
    root: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        minHeight: "220px",
    },
    panel: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: tokens.spacingVerticalM,
        color: tokens.colorNeutralForeground2,
    },
});

export const LoadingState = ({
    label = "Loading...",
    size = "large",
    className,
    panelClassName,
}: LoadingStateProps) => {
    const styles = useStyles();

    return (
        <div className={mergeClasses(styles.root, className)}>
            <div className={mergeClasses(styles.panel, panelClassName)}>
                <Spinner size={size} />
                <Text size={300}>{label}</Text>
            </div>
        </div>
    );
};
