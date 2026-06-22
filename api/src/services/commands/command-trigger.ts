/**
 * Command trigger + priority enums.
 *
 * Mirrors Lidarr's `CommandTrigger` and `CommandPriority`
 * (NzbDrone.Core/Messaging/Commands). Modelled as `as const` objects so the
 * numeric values persisted in the `commands.trigger` / `commands.priority`
 * columns stay stable while call sites read by name instead of magic numbers.
 */

export const CommandTrigger = {
  Unspecified: 0,
  Manual: 1,
  Scheduled: 2,
} as const;

export type CommandTrigger = typeof CommandTrigger[keyof typeof CommandTrigger];

export const CommandPriority = {
  Low: -1,
  Normal: 0,
  High: 1,
} as const;

export type CommandPriority = typeof CommandPriority[keyof typeof CommandPriority];
