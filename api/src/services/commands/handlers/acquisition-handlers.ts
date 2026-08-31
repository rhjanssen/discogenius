import { db } from "../../../database.js";
import {
  AcquisitionPlanningService,
  getAcquisitionProviderPriority,
} from "../../music/acquisition-planning-service.js";
import { emitLibraryUpdated } from "../app-events.js";
import type { CommandHandler } from "./handler-context.js";

interface MonitoredEditionRow {
  library_id: number;
  edition_id: number;
}

/** Re-rank existing plans after a provider-preference change, without curating. */
export const handleReplanAcquisition: CommandHandler<"ReplanAcquisition"> = async (job, ctx) => {
  const editions = db.prepare(`
    SELECT library_id, edition_id
    FROM LibraryEditions
    ORDER BY library_id, edition_id
  `).all() as MonitoredEditionRow[];
  const providerPriority = getAcquisitionProviderPriority();
  const planner = new AcquisitionPlanningService(db);
  const failed: string[] = [];

  ctx.updateCommandDescription(job, {
    progress: editions.length === 0 ? 100 : 5,
    description: editions.length === 0
      ? "No monitored editions need acquisition plans"
      : `Replanning ${editions.length} monitored edition(s)`,
  });

  for (let index = 0; index < editions.length; index++) {
    const edition = editions[index];
    try {
      planner.compute({
        libraryId: edition.library_id,
        editionId: edition.edition_id,
        providerPriority,
        plannerVersion: 1,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(`library ${edition.library_id}, edition ${edition.edition_id}: ${message}`);
    }

    if ((index + 1) % 20 === 0 || index === editions.length - 1) {
      ctx.updateCommandDescription(job, {
        progress: Math.min(99, 5 + Math.round(((index + 1) / editions.length) * 94)),
        description: `Replanned ${index + 1} of ${editions.length} monitored edition(s)`,
      });
      await ctx.yieldToEventLoop();
    }
  }

  if (failed.length > 0) {
    throw new Error(`Failed to replan ${failed.length} edition(s). First failure: ${failed[0]}`);
  }

  if (editions.length > 0) {
    emitLibraryUpdated({
      reason: "provider-priority-changed",
      libraryIds: [...new Set(editions.map((edition) => edition.library_id))],
    });
  }
  ctx.updateCommandDescription(job, {
    progress: 100,
    description: `Replanned ${editions.length} monitored edition(s)`,
  });
};
