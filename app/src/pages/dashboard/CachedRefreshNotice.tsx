import { Text, mergeClasses } from "@fluentui/react-components";
import { ErrorCircle24Filled } from "@fluentui/react-icons";
import { useDashboardStyles } from "./dashboardStyles";

interface CachedRefreshNoticeProps {
    visible: boolean;
    cachedLabel: string;
    errorMessage?: string;
}

const CachedRefreshNotice = ({ visible, cachedLabel, errorMessage }: CachedRefreshNoticeProps) => {
    const styles = useDashboardStyles();

    if (!visible) {
        return null;
    }

    return (
        <div className={mergeClasses(styles.syncNotice, styles.syncNoticeError)}>
            <ErrorCircle24Filled className={styles.statusIconError} />
            <Text size={200} className={styles.syncNoticeText}>
                {`Showing cached ${cachedLabel}${errorMessage ? ` (${errorMessage})` : ""}`}
            </Text>
        </div>
    );
};

export default CachedRefreshNotice;