import { markAcquisitionPlanningStale } from "../../music/acquisition-planning-control.js";
import type { CommandHandler } from "./handler-context.js";

/** Drain jobs left queued by 2.13.4 without doing an eager library-wide rebuild. */
export const handleReplanAcquisition: CommandHandler<"ReplanAcquisition"> = async (job, ctx) => {
  markAcquisitionPlanningStale();
  ctx.updateCommandDescription(job, {
    progress: 100,
    description: "Provider order will apply during the next curation pass",
  });
};
