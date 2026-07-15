import type { ReactNode } from 'react';
import {
  Button,
  Text,
  makeStyles,
  mergeClasses,
  tokens } from '@fluentui/react-components';
import {
  ChevronDown16Regular as ChevronDown16RegularBase,
  ChevronUp16Regular as ChevronUp16RegularBase,
  ChevronUp16Filled,
  bundleIcon,
  ChevronDown16Filled
} from "@fluentui/react-icons";

const ChevronDown16Regular = bundleIcon(ChevronDown16Filled, ChevronDown16RegularBase);

const ChevronUp16Regular = bundleIcon(ChevronUp16Filled, ChevronUp16RegularBase);

const useStyles = makeStyles({
    container: {
        // Small own-margins so the block keeps a little air without doubling up
        // on the parent's flex gap (which would push the name↔bio / album-review
        // spacing out too far). Shared by the artist bio and the album review.
        marginTop: tokens.spacingVerticalXS,
        marginBottom: tokens.spacingVerticalXS,
    },
    content: {
        fontSize: tokens.fontSizeBase300,
        color: tokens.colorNeutralForeground2,
        lineHeight: tokens.lineHeightBase400,
        overflow: 'hidden',
    },
    collapsed: {
        display: '-webkit-box',
        WebkitLineClamp: '2',
        WebkitBoxOrient: 'vertical',
    },
    expanded: {
        display: 'block',
    },
    preserveWhitespace: {
        whiteSpace: 'pre-wrap',
    },
    attribution: {
        marginTop: tokens.spacingVerticalXS,
        color: tokens.colorNeutralForeground3,
        fontSize: tokens.fontSizeBase200,
        lineHeight: tokens.lineHeightBase200,
    },
    toggleButton: {
        marginTop: tokens.spacingVerticalXS,
        padding: tokens.spacingVerticalNone,
        minWidth: 'auto',
        height: 'auto',
        backgroundColor: tokens.colorTransparentBackground,
        border: 'none',
        color: tokens.colorBrandForeground1,
        fontSize: tokens.fontSizeBase200,
        cursor: 'pointer',
        '&:hover': {
            backgroundColor: tokens.colorTransparentBackground,
            textDecoration: 'underline',
        },
        display: 'flex',
        justifyContent: 'center',
        width: '100%',
        '@media (min-width: 768px)': {
            justifyContent: 'flex-start',
            width: 'auto',
        },
    },
});

interface ExpandableMetadataBlockProps {
    content: ReactNode;
    attribution?: string | null;
    expanded: boolean;
    onToggle: () => void;
    preserveWhitespace?: boolean;
}

export function ExpandableMetadataBlock({
    content,
    attribution,
    expanded,
    onToggle,
    preserveWhitespace = false,
}: ExpandableMetadataBlockProps) {
    const styles = useStyles();

    return (
        <div className={styles.container}>
            <div
                className={mergeClasses(
                    styles.content,
                    expanded ? styles.expanded : styles.collapsed,
                    preserveWhitespace && styles.preserveWhitespace,
                )}
            >
                {content}
            </div>
            {attribution && expanded && (
                <Text block className={styles.attribution}>
                    {attribution}
                </Text>
            )}
            <Button
                appearance="transparent"
                size="small"
                className={styles.toggleButton}
                onClick={onToggle}
                icon={expanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
            >
                {expanded ? 'Show less' : 'Read more'}
            </Button>
        </div>
    );
}