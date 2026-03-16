import React from 'react';
import { Badge, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

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
        backgroundColor: `color-mix(in srgb, ${tokens.colorNeutralForeground3} 16%, ${tokens.colorNeutralBackground1})`,
        fontWeight: tokens.fontWeightSemibold,
        paddingLeft: tokens.spacingHorizontalS,
        paddingRight: tokens.spacingHorizontalS,
    },
    album: {
        color: 'var(--dg-accent-albums)',
        backgroundColor: 'var(--dg-accent-albums-background)',
    },
    track: {
        color: 'var(--dg-accent-tracks)',
        backgroundColor: 'var(--dg-accent-tracks-background)',
    },
    video: {
        color: 'var(--dg-accent-videos)',
        backgroundColor: 'var(--dg-accent-videos-background)',
    },
});

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
    const variantClass = kind === 'album' || kind === 'album-group'
        ? styles.album
        : kind === 'video'
            ? styles.video
            : styles.track;

    return (
        <Badge
            appearance="filled"
            size={size}
            className={mergeClasses(styles.base, variantClass, className)}
        >
            {label || getDefaultLabel(kind)}
        </Badge>
    );
};

export default MediaTypeBadge;