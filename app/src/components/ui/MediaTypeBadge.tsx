import React from 'react';
import { Badge, makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';
import { useTheme } from '@/providers/themeContext';

export type MediaTypeBadgeKind = 'album' | 'album-group' | 'track' | 'video';

interface MediaTypeBadgeProps {
    kind: MediaTypeBadgeKind;
    label?: string;
    className?: string;
    size?: 'small' | 'medium' | 'large' | 'extra-large';
}

const useStyles = makeStyles({
    base: {
        color: tokens.colorNeutralForeground1,
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralForeground3} 50%, transparent)`,
        fontWeight: tokens.fontWeightSemibold,
        paddingLeft: tokens.spacingHorizontalS,
        paddingRight: tokens.spacingHorizontalS,
        minWidth: "max-content",
        ...shorthands.border("0"),
        boxShadow: "none",
        "::after": {
            display: "none",
        },
    },
    album: {
        color: 'var(--dg-accent-albums)',
    },
    track: {
        color: 'var(--dg-accent-tracks)',
    },
    video: {
        color: 'var(--dg-accent-videos)',
    },
});

function getAccentColor(kind: MediaTypeBadgeKind): string {
    if (kind === 'album' || kind === 'album-group') return 'var(--dg-accent-albums)';
    if (kind === 'video') return 'var(--dg-accent-videos)';
    return 'var(--dg-accent-tracks)';
}

function getDefaultLabel(kind: MediaTypeBadgeKind): string {
    switch (kind) {
        case 'album-group':
            return 'Album Group';
        case 'album':
            return 'Album';
        case 'video':
            return 'Video';
        case 'track':
        default:
            return 'Track';
    }
}

export const MediaTypeBadge: React.FC<MediaTypeBadgeProps> = ({
    kind,
    label,
    className,
    size = 'small',
}) => {
    const styles = useStyles();
    const { isDarkMode } = useTheme();
    const tint = isDarkMode ? 50 : 60;
    const variantClass = kind === 'album' || kind === 'album-group'
        ? styles.album
        : kind === 'video'
            ? styles.video
            : styles.track;

    return (
        <Badge
            appearance="tint"
            size={size}
            className={mergeClasses(styles.base, variantClass, className)}
            style={{ backgroundColor: `color-mix(in srgb, ${getAccentColor(kind)} ${tint}%, transparent)` }}
        >
            {label || getDefaultLabel(kind)}
        </Badge>
    );
};

export default MediaTypeBadge;
