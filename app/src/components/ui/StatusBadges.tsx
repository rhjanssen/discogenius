/**
 * Status badges following Fluent UI v9 design patterns
 * Centralized badge definitions to ensure consistency across the app
 */

import { Badge } from "@fluentui/react-components";
import React from "react";

/**
 * Downloaded badge - indicates media is available in library
 */
export const DownloadedBadge: React.FC<{ className?: string }> = ({ className }) => (
    <Badge appearance="filled" color="success" size="small" className={className}>
        Downloaded
    </Badge>
);

export const NotScannedBadge: React.FC<{ className?: string }> = ({ className }) => (
    <Badge appearance="outline" color="warning" size="small" className={className}>
        Not Scanned
    </Badge>
);

/**
 * Failed badge - indicates a download or operation failed
 */
export const FailedBadge: React.FC<{ label?: string; className?: string }> = ({ label = "Failed", className }) => (
    <Badge appearance="filled" color="danger" size="small" className={className}>
        {label}
    </Badge>
);

/**
 * Processing badge - indicates an operation is in progress
 */
export const ProcessingBadge: React.FC<{ label?: string; className?: string }> = ({ label = "Processing", className }) => (
    <Badge appearance="tint" color="informative" size="small" className={className}>
        {label}
    </Badge>
);
