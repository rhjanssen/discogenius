/**
 * A provider album represents this edition when the plan is that one album,
 * or the match is the whole edition (`exact`) or a larger product of it
 * (`source_superset`). `overlap` and `source_subset` are donors: another
 * album's tracks used to fill gaps. Their cover and provider id are not ours.
 *
 * `plan` is the acquisition plan and `release_match` is its source match.
 */
export const PROVIDER_REPRESENTS_EDITION_SQL =
  "(plan.composition = 'single_source' OR release_match.relation IN ('exact', 'source_superset'))";
