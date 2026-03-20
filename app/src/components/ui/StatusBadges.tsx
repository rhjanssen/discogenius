/**
 * Status badges following Fluent UI v9 design patterns
 * Centralized badge definitions to ensure consistency across the app
 */

import { Badge } from "@fluentui/react-components";
import React from "react";

/**
 * Downloaded badge - indicates media is available in library
 */
export const DownloadedBadge: React.FC = () => (
    <Badge appearance="filled" color="success" size="small">
        Downloaded
    </Badge>
);

/**
 * Missing badge - indicates media is monitored but not downloaded
 */
export const MissingBadge: React.FC = () => (
    <Badge appearance="outline" size="small">
        Missing
    </Badge>
);

/**
 * Failed badge - indicates a download or operation failed
 */
export const FailedBadge: React.FC<{ label?: string }> = ({ label = "Failed" }) => (
    <Badge appearance="filled" color="danger" size="small">
        {label}
    </Badge>
);

/**
 * Processing badge - indicates an operation is in progress
 */
export const ProcessingBadge: React.FC<{ label?: string }> = ({ label = "Processing" }) => (
    <Badge appearance="tint" color="informative" size="small">
        {label}
    </Badge>
);
