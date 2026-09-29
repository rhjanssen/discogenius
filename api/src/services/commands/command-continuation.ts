import type { CommandBodyCommon } from "./command-bodies.js";

/** A completed work unit requests another dispatch, not an infrastructure retry.
 * The lifecycle persists the checkpoint and releases the command's resources. */
export class CommandContinuation extends Error {
    constructor(readonly payloadPatch: Partial<CommandBodyCommon>) {
        super("Command checkpoint ready for continuation");
        this.name = "CommandContinuation";
    }
}
