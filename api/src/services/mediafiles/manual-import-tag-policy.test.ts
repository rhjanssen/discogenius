import assert from "node:assert/strict";
import test from "node:test";

import { shouldTagManuallyImportedFiles } from "./manual-import-service.js";

test("shouldTagManuallyImportedFiles only tags manual imports when policy is all_files", () => {
  assert.equal(shouldTagManuallyImportedFiles({ write_audio_tags_policy: "no" } as any), false);
  // Regression-critical: a user deliberately on new_files to protect their
  // own carefully-tagged pre-existing files must NOT get them retagged.
  assert.equal(shouldTagManuallyImportedFiles({ write_audio_tags_policy: "new_files" } as any), false);
  assert.equal(shouldTagManuallyImportedFiles({ write_audio_tags_policy: "all_files" } as any), true);
  // Sync retags after catalog refresh, not a user's existing files at import.
  assert.equal(shouldTagManuallyImportedFiles({ write_audio_tags_policy: "sync" } as any), false);
});
