/**
 * A clean Edition must not be acquired with explicit audio.
 *
 * MusicBrainz issues clean and explicit versions of an album as separate
 * releases with separate Recordings — Bastille's *Give Me the Future* has both,
 * and its "Promises" exists as two Recording MBIDs seven milliseconds apart.
 * Coverage identity deliberately treats them as one *wanted* song so curation
 * does not monitor both editions. Acquisition must not inherit that leniency:
 * once the clean edition is the one being filled, the audio has to be clean.
 *
 * The availability view already hid conflicting plans, but curation and the
 * download path read rank 0 straight from `AcquisitionPlans`, so the gate has
 * to live where the ranking is decided.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { demoteExplicitnessConflicts } from "./acquisition-planning-service.js";

type Plan = { planKey: string; explicitContent: "explicit" | "clean" | "unknown" };

const plan = (planKey: string, explicitContent: Plan["explicitContent"]): Plan =>
  ({ planKey, explicitContent });

const keys = (plans: readonly Plan[]) => plans.map((p) => p.planKey);

test("an explicit plan cannot be rank 0 on a clean edition", () => {
  const ranked = demoteExplicitnessConflicts(
    [plan("explicit-hires", "explicit"), plan("clean-lossless", "clean")],
    "Give Me the Future",
    "deluxe edition - clean",
  );
  assert.equal(ranked[0].planKey, "clean-lossless");
  assert.deepEqual(keys(ranked), ["clean-lossless", "explicit-hires"]);
});

test("a clean plan cannot be rank 0 on an explicit edition", () => {
  const ranked = demoteExplicitnessConflicts(
    [plan("clean-hires", "clean"), plan("explicit-lossless", "explicit")],
    "Give Me the Future",
    "deluxe edition - explicit",
  );
  assert.equal(ranked[0].planKey, "explicit-lossless");
});

test("the conflicting plan is demoted, not discarded", () => {
  // It stays selectable: the user may deliberately choose the other version,
  // and dropping it would make the Editions list claim there is no offer.
  const ranked = demoteExplicitnessConflicts(
    [plan("explicit", "explicit")],
    null,
    "clean",
  );
  assert.deepEqual(keys(ranked), ["explicit"]);
});

test("unknown explicitness never conflicts", () => {
  // Providers that do not report the flag must not be stranded; an absent fact
  // is not evidence of the opposite one.
  for (const label of ["clean", "explicit"]) {
    const ranked = demoteExplicitnessConflicts(
      [plan("unknown-hires", "unknown"), plan("matching", label === "clean" ? "clean" : "explicit")],
      null,
      label,
    );
    assert.equal(ranked[0].planKey, "unknown-hires", `${label}: order is preserved`);
  }
});

test("an unlabelled edition keeps the planner's own ordering", () => {
  const plans = [plan("a", "explicit"), plan("b", "clean"), plan("c", "unknown")];
  assert.deepEqual(keys(demoteExplicitnessConflicts(plans, "Give Me the Future", null)), ["a", "b", "c"]);
  assert.deepEqual(keys(demoteExplicitnessConflicts(plans, null, null)), ["a", "b", "c"]);
});

test("ordering among non-conflicting plans is untouched", () => {
  const ranked = demoteExplicitnessConflicts(
    [
      plan("clean-best", "clean"),
      plan("explicit-mid", "explicit"),
      plan("unknown-worst", "unknown"),
      plan("clean-worse", "clean"),
    ],
    null,
    "clean",
  );
  // Quality order among the survivors is the planner's business, not the gate's.
  assert.deepEqual(keys(ranked), ["clean-best", "unknown-worst", "clean-worse", "explicit-mid"]);
});
