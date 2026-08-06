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
 * to live where the ranking is decided — and it has to remove the plan, not
 * merely rank it lower, because the last remaining plan is rank 0 whatever its
 * rendition.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { eligiblePlansForEdition } from "./acquisition-planning-service.js";
import {
  editionRendition,
  effectiveExplicitness,
  planEligibleForEdition,
  providerExplicitnessFromFlag,
} from "./rendition-policy.js";

type Plan = { planKey: string; explicitContent: "explicit" | "clean" | "unknown" };

const plan = (planKey: string, explicitContent: Plan["explicitContent"]): Plan =>
  ({ planKey, explicitContent });

const keys = (plans: readonly Plan[]) => plans.map((p) => p.planKey);

/* ── What labels an Edition ─────────────────────────────────────────── */

test("disambiguation is what labels a rendition", () => {
  assert.equal(editionRendition("Give Me the Future", "deluxe edition - clean"), "clean");
  assert.equal(editionRendition("Give Me the Future", "deluxe edition - explicit"), "explicit");
  assert.equal(editionRendition("Give Me the Future", null), "unlabelled");
});

test("a band's name in a title is not a content rating", () => {
  // Real editions in the library: scanning titles for the word read these as
  // clean-labelled, which would have hidden every explicit plan for them.
  assert.equal(editionRendition("Drink About (Clean Bandit remix)", null), "unlabelled");
  assert.equal(editionRendition("Past Life (Clean Bandit remix)", null), "unlabelled");
  assert.equal(editionRendition("Cleanse", null), "unlabelled");
});

test("a title labels the Edition only when the marker stands alone", () => {
  assert.equal(editionRendition("Give Me the Future (Explicit)", null), "explicit");
  assert.equal(editionRendition("Give Me the Future [Clean Version]", null), "clean");
  assert.equal(editionRendition("Give Me the Future (Censored)", null), "clean");
});

/* ── What an absent provider flag means ─────────────────────────────── */

test("an unmarked track is a track the provider is not calling explicit", () => {
  assert.equal(providerExplicitnessFromFlag(null), "unknown");
  assert.equal(providerExplicitnessFromFlag(undefined), "unknown");
  assert.equal(providerExplicitnessFromFlag(0), "clean");
  assert.equal(providerExplicitnessFromFlag(1), "explicit");
  assert.equal(providerExplicitnessFromFlag(true), "explicit");

  // The fact stays tri-state; only policy collapses it.
  assert.equal(effectiveExplicitness("unknown"), "clean");
  assert.equal(effectiveExplicitness("clean"), "clean");
  assert.equal(effectiveExplicitness("explicit"), "explicit");
});

test("eligibility follows the collapsed value", () => {
  assert.equal(planEligibleForEdition("clean", "clean"), true);
  assert.equal(planEligibleForEdition("unknown", "clean"), true);
  assert.equal(planEligibleForEdition("explicit", "clean"), false);

  assert.equal(planEligibleForEdition("explicit", "explicit"), true);
  assert.equal(planEligibleForEdition("clean", "explicit"), false);
  assert.equal(planEligibleForEdition("unknown", "explicit"), false);

  for (const value of ["explicit", "clean", "unknown"] as const) {
    assert.equal(planEligibleForEdition(value, "unlabelled"), true);
  }
});

/* ── What the planner does with it ──────────────────────────────────── */

test("a clean Edition keeps its clean plan and drops the explicit one", () => {
  const eligible = eligiblePlansForEdition(
    [plan("explicit-hires", "explicit"), plan("clean-lossless", "clean")],
    "Give Me the Future",
    "deluxe edition - clean",
  );
  assert.deepEqual(keys(eligible), ["clean-lossless"]);
});

test("an explicit Edition keeps its explicit plan and drops the clean one", () => {
  const eligible = eligiblePlansForEdition(
    [plan("clean-hires", "clean"), plan("explicit-lossless", "explicit")],
    "Give Me the Future",
    "deluxe edition - explicit",
  );
  assert.deepEqual(keys(eligible), ["explicit-lossless"]);
});

test("a labelled Edition whose only offer conflicts gets no plan at all", () => {
  // Demotion left this plan at rank 0, which is what curation executes. The
  // explicit Edition is the one to monitor for explicit audio.
  assert.deepEqual(eligiblePlansForEdition([plan("explicit", "explicit")], null, "clean"), []);
  assert.deepEqual(eligiblePlansForEdition([plan("clean", "clean")], null, "explicit"), []);
});

test("an unmarked plan fills a clean Edition but not an explicit one", () => {
  assert.deepEqual(
    keys(eligiblePlansForEdition([plan("unmarked", "unknown")], null, "clean")),
    ["unmarked"],
  );
  assert.deepEqual(eligiblePlansForEdition([plan("unmarked", "unknown")], null, "explicit"), []);
});

test("an unlabelled Edition keeps every plan and the planner's own ordering", () => {
  const plans = [plan("a", "explicit"), plan("b", "clean"), plan("c", "unknown")];
  assert.deepEqual(keys(eligiblePlansForEdition(plans, "Give Me the Future", null)), ["a", "b", "c"]);
  assert.deepEqual(keys(eligiblePlansForEdition(plans, null, null)), ["a", "b", "c"]);
});

test("ordering among eligible plans is untouched", () => {
  const eligible = eligiblePlansForEdition(
    [
      plan("clean-best", "clean"),
      plan("explicit-mid", "explicit"),
      plan("unmarked", "unknown"),
      plan("clean-worse", "clean"),
    ],
    null,
    "clean",
  );
  // Quality order among the survivors is the planner's business, not the gate's.
  assert.deepEqual(keys(eligible), ["clean-best", "unmarked", "clean-worse"]);
});
