import { Router } from "express";
import { collectHealthDiagnosticsSnapshot } from "../services/commands/health.js";
import { ProviderArtistIdentityService } from "../services/metadata/provider-artist-identity-service.js";

const router = Router();

router.get("/", (_req, res) => {
  try {
    // Compose the import diagnostics here rather than inside
    // collectHealthDiagnosticsSnapshot: the same snapshot backs the container's
    // /health probe, which should stay a pure liveness check without catalog
    // queries.
    res.json({
      ...collectHealthDiagnosticsSnapshot(),
      imports: {
        unmatchedArtists: ProviderArtistIdentityService.listUnmatched(),
      },
    });
  } catch (error: any) {
    res.status(500).json({ detail: error.message });
  }
});

export default router;
