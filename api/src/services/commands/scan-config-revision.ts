import { createHash } from "node:crypto";
import { getConfigSection } from "../config/config.js";

export function scanConfigRevision(): string {
    return createHash("sha256").update(JSON.stringify({
        path: getConfigSection("path"), metadata: getConfigSection("metadata"), filtering: getConfigSection("filtering"),
    })).digest("hex");
}
