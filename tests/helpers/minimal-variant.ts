/**
 * @fileoverview The smallest gnomAD VariantDetails payload the service parses
 * into a record — one genome callset with no populations, consequences,
 * predictors, flags, or joint record (null, as outside gnomad_r4) — for tests
 * that fake gnomAD's GraphQL API.
 * @module tests/helpers/minimal-variant
 */

/** A minimal nuclear gnomAD variant payload that parses cleanly, on the given build. */
export function minimalVariant(variantId: string, referenceGenome = 'GRCh38') {
  return {
    variant_id: variantId,
    reference_genome: referenceGenome,
    rsids: [],
    flags: null,
    exome: null,
    genome: {
      ac: 1,
      an: 1_000,
      af: 0.001,
      homozygote_count: 0,
      hemizygote_count: null,
      populations: [],
    },
    joint: null,
    transcript_consequences: null,
    in_silico_predictors: null,
  };
}
