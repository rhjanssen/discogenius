import { isValidElement, useId, type ReactNode } from 'react';
import {
  Button,
  Text,
  makeStyles,
  mergeClasses,
  tokens } from '@fluentui/react-components';
import {
  ChevronDown16Regular,
  ChevronUp16Regular,
  ChevronUp16Filled,
  bundleIcon,
  ChevronDown16Filled
} from "@fluentui/react-icons";

const ChevronDown16 = bundleIcon(ChevronDown16Filled, ChevronDown16Regular);

const ChevronUp16 = bundleIcon(ChevronUp16Filled, ChevronUp16Regular);

const useStyles = makeStyles({
    container: {
        // Parent flex gaps own the spacing (artist titleBlock XS/SNudge,
        // albumInfo section M). Extra margins here stacked and pushed name↔bio
        // / title↔review too far apart.
        marginTop: tokens.spacingVerticalNone,
        marginBottom: tokens.spacingVerticalNone,
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

function metadataText(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }
    if (Array.isArray(node)) {
        return node.map(metadataText).join('');
    }
    if (isValidElement<{ children?: ReactNode }>(node)) {
        return metadataText(node.props.children);
    }
    return '';
}

function collapsedPreview(node: ReactNode, maxLength = 420): string {
    const text = metadataText(node).replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    const candidate = text.slice(0, maxLength + 1);
    const lastBreak = candidate.lastIndexOf(' ');
    return `${candidate.slice(0, lastBreak > maxLength * 0.75 ? lastBreak : maxLength).trimEnd()}…`;
}

export function ExpandableMetadataBlock({
    content,
    attribution,
    expanded,
    onToggle,
    preserveWhitespace = false,
}: ExpandableMetadataBlockProps) {
    const styles = useStyles();
    const contentId = useId();

    return (
        <div className={styles.container}>
            <div
                id={contentId}
                className={mergeClasses(
                    styles.content,
                    expanded ? styles.expanded : styles.collapsed,
                    preserveWhitespace && styles.preserveWhitespace,
                )}
            >
                {expanded ? content : collapsedPreview(content)}
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
                aria-controls={contentId}
                aria-expanded={expanded}
                icon={expanded ? <ChevronUp16 /> : <ChevronDown16 />}
            >
                {expanded ? 'Show less' : 'Read more'}
            </Button>
        </div>
    );
}
