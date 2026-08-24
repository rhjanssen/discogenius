import {
    CheckmarkCircle16Color,
    CheckmarkCircle24Color,
    DismissCircle16Color,
    DismissCircle24Color,
    QuestionCircle16Color,
    QuestionCircle24Color,
    Warning16Color,
    Warning24Color,
} from "@fluentui/react-icons";

export type SemanticStatus = "success" | "warning" | "error" | "unknown";

type SemanticStatusIconProps = {
    status: SemanticStatus;
    size?: 16 | 24;
    className?: string;
    title?: string;
    "aria-label"?: string;
};

/** Shared Fluent color icons for terminal statuses across import and dashboard views. */
export function SemanticStatusIcon({ status, size = 16, ...props }: SemanticStatusIconProps) {
    if (size === 24) {
        if (status === "success") return <CheckmarkCircle24Color {...props} />;
        if (status === "warning") return <Warning24Color {...props} />;
        if (status === "error") return <DismissCircle24Color {...props} />;
        return <QuestionCircle24Color {...props} />;
    }

    if (status === "success") return <CheckmarkCircle16Color {...props} />;
    if (status === "warning") return <Warning16Color {...props} />;
    if (status === "error") return <DismissCircle16Color {...props} />;
    return <QuestionCircle16Color {...props} />;
}
