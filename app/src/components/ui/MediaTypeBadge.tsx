import React from 'react';
import { Badge, makeStyles, mergeClasses, shorthands, tokens } from '@fluentui/react-components';

export type MediaTypeBadgeKind = 'album' | 'album-group' | 'track' | 'video';

interface MediaTypeBadgeProps {
    kind: MediaTypeBadgeKind;
    label?: string;
    className?: string;
    size?: 'small' | 'medium' | 'large' | 'extra-large';
}

const useStyles = makeStyles({
    base: {
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
});

function getAccentColor(kind: MediaTypeBadgeKind): string {
    if (kind === 'album' || kind === 'album-group') return 'var(--dg-accent-albums)';
    if (kind === 'video') return 'var(--dg-accent-videos)';
    return 'var(--dg-accent-tracks)';
}

function getAccentBackground(kind: MediaTypeBadgeKind): string {
    if (kind === 'album' || kind === 'album-group') return 'var(--dg-accent-albums-background)';
    if (kind === 'video') return 'var(--dg-accent-videos-background)';
    return 'var(--dg-accent-tracks-background)';
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
    const accent = getAccentColor(kind);
    const accentBackground = getAccentBackground(kind);

    return (
        <Badge
            appearance="tint"
            size={size}
            className={mergeClasses(styles.base, className)}
            style={{ backgroundColor: accentBackground, color: accent }}
        >
            {label || getDefaultLabel(kind)}
        </Badge>
    );
};

export default MediaTypeBadge;
