/**
 * Status badges following Fluent UI v9 design patterns
 * Centralized badge definitions to ensure consistency across the app
 */

import { Badge, tokens } from "@fluentui/react-components";
import { CheckmarkCircle16Filled } from "@fluentui/react-icons";
import React from "react";

/**
 * Downloaded badge - indicates media is available in library
 */
export const DownloadedBadge: React.FC<{ className?: string }> = ({ className }) => (
    <div
        className={className}
        title="Downloaded"
        style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tokens.colorPaletteGreenBackground3,
            color: tokens.colorPaletteGreenForeground3,
            borderRadius: tokens.borderRadiusCircular,
            padding: tokens.spacingHorizontalXXS,
            boxShadow: tokens.shadow4,
        }}
    >
        <CheckmarkCircle16Filled style={{ width: "12px", height: "12px" }} />
    </div>
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
