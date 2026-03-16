import React from 'react';
import { makeStyles, tokens, ProgressBar, Text } from '@fluentui/react-components';

interface DownloadOverlayProps {
    status: 'pending' | 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled' | 'paused' | string;
    progress?: number;
    error?: string;
    showText?: boolean;
}

const useStyles = makeStyles({
    root: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(4px)',
        padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.spacingVerticalXXS,
        zIndex: 5,
        borderBottomLeftRadius: tokens.borderRadiusMedium,
        borderBottomRightRadius: tokens.borderRadiusMedium,
    },
    text: {
        color: tokens.colorNeutralForegroundOnBrand,
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
        textAlign: 'center',
    },
    errorText: {
        color: tokens.colorPaletteRedForeground1,
        fontSize: tokens.fontSizeBase200,
        fontWeight: tokens.fontWeightSemibold,
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    }
});

export const DownloadOverlay: React.FC<DownloadOverlayProps> = ({
    status,
    progress = 0,
    error,
    showText = true,
}) => {
    const styles = useStyles();

    if (status === 'completed' || status === 'cancelled') {
        return null;
    }

    const isPending = status === 'pending' || status === 'queued' || status === 'paused';

    return (
        <div className={styles.root}>
            {showText && (
                <Text className={status === 'failed' ? styles.errorText : styles.text} title={error}>
                    {status === 'failed' ? (error || 'Failed') : isPending ? status.charAt(0).toUpperCase() + status.slice(1) : `${Math.round(progress)}%`}
                </Text>
            )}
            {status !== 'failed' && (
                <ProgressBar
                    value={isPending ? undefined : progress / 100}
                    thickness="medium"
                    color={isPending ? 'warning' : 'success'}
                />
            )}
        </div>
    );
};
