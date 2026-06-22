/**
 * Command handler contract.
 *
 * Mirrors Lidarr's `IExecute<TCommand>`: one handler per command, resolved from
 * a registry by command name. The `CommandExecutor` builds a per-command
 * `CommandHandlerContext` (progress/description helpers, cooperative yield) and
 * invokes the matching handler. Keeping handlers as discrete units — rather than
 * one monolithic switch — is what makes off-thread execution tractable later.
 */

import type {CommandModel, CommandModelOf} from "../command-model.js";
import type {CommandName} from "../command-names.js";

export interface CommandHandlerContext {
  /** Update a command's progress / description (persisted + broadcast). */
  updateCommandDescription(job: CommandModel, options: { progress?: number; description?: string }): void;
  /** Build a "<artist> · <phase>" progress label. */
  formatArtistPhaseDescription(job: CommandModel, phase: string, fallback?: string): string;
  /** Build a workflow-aware label, e.g. "Refreshing <artist>". */
  formatWorkflowCommandLabel(job: CommandModel, fallback: string): string;
  /** Resolve a human label for the command's subject artist. */
  resolveArtistLabel(job: CommandModel): string;
  /** Hand the event loop back to pending I/O between heavy work units. */
  yieldToEventLoop(): Promise<void>;
}

export type CommandHandler<K extends CommandName = CommandName> = (
  job: CommandModelOf<K>,
  ctx: CommandHandlerContext,
) => Promise<void>;

export type CommandHandlerRegistry = { [K in CommandName]?: CommandHandler<K> };
