/**
 * @fileoverview Live gnomAD transcript-consequence records, captured 2026-11-01
 * (UTC) with the server's own query documents: the transcript_consequences of
 * four variant records, and gene list replies with the gene's MANE Select and
 * canonical transcript IDs. Shared by the service and tool tests of the
 * consequence-transcript fields.
 * @module tests/helpers/live-consequences
 */

/**
 * transcript_consequences of gnomad_r4 9-21968220-C-A: stop_gained on a
 * non-MANE CDKN2A isoform first, the MANE Select entry second, and a second
 * gene's (ENSG00000264545) canonical entry among them.
 */
export const CDKN2A_STOP_GAINED_R4 = [
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000579122',
    major_consequence: 'stop_gained',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.406G>T',
    hgvsp: 'p.Glu136Ter',
    lof: 'LC',
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000304494',
    major_consequence: '3_prime_UTR_variant',
    is_mane_select: true,
    is_canonical: true,
    hgvsc: 'c.*9G>T',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000494262',
    major_consequence: '3_prime_UTR_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.*9G>T',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000498124',
    major_consequence: '3_prime_UTR_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.*173G>T',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000498628',
    major_consequence: '3_prime_UTR_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.*9G>T',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000530628',
    major_consequence: '3_prime_UTR_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.*50G>T',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000578845',
    major_consequence: '3_prime_UTR_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.*9G>T',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000579755',
    major_consequence: '3_prime_UTR_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.*124G>T',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000264545',
    gene_symbol: null,
    transcript_id: 'ENST00000404796',
    major_consequence: 'intron_variant',
    is_mane_select: null,
    is_canonical: true,
    hgvsc: 'c.348-61213C>A',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000380151',
    major_consequence: '3_prime_UTR_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.*403G>T',
    hgvsp: null,
    lof: null,
  },
];

/**
 * transcript_consequences of gnomad_r4 9-21994160-G-A: stop_gained on the
 * p14ARF isoforms' exon 1β, which lies outside CDKN2A's MANE Select (p16INK4a)
 * transcript, so CDKN2A has neither a MANE Select nor a canonical entry here.
 */
export const CDKN2A_ARF_STOP_GAINED_R4 = [
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000530628',
    major_consequence: 'stop_gained',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.172C>T',
    hgvsp: 'p.Gln58Ter',
    lof: 'HC',
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000579755',
    major_consequence: 'stop_gained',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.172C>T',
    hgvsp: 'p.Gln58Ter',
    lof: 'HC',
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000494262',
    major_consequence: 'intron_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.-175-107C>T',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000498628',
    major_consequence: 'intron_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'c.-4+661C>T',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000264545',
    gene_symbol: null,
    transcript_id: 'ENST00000404796',
    major_consequence: 'intron_variant',
    is_mane_select: null,
    is_canonical: true,
    hgvsc: 'c.348-35273G>A',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000240498',
    gene_symbol: 'CDKN2B-AS1',
    transcript_id: 'ENST00000468603',
    major_consequence: 'non_coding_transcript_exon_variant',
    is_mane_select: null,
    is_canonical: null,
    hgvsc: 'n.22G>A',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000147889',
    gene_symbol: 'CDKN2A',
    transcript_id: 'ENST00000470819',
    major_consequence: 'intron_variant',
    is_mane_select: false,
    is_canonical: null,
    hgvsc: 'n.54-92C>T',
    hgvsp: null,
    lof: null,
  },
];

/**
 * The first two of 18 transcript_consequences of gnomad_r4 9-22050002-T-A, all
 * in CDKN2B-AS1: a gene with no MANE Select, so gnomAD reports no MANE status
 * (null) on GRCh38 too, and the canonical entry stands in.
 */
export const CDKN2B_AS1_INTRON_R4 = [
  {
    gene_id: 'ENSG00000240498',
    gene_symbol: 'CDKN2B-AS1',
    transcript_id: 'ENST00000650946',
    major_consequence: 'intron_variant',
    is_mane_select: null,
    is_canonical: true,
    hgvsc: 'n.302+774T>A',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000240498',
    gene_symbol: 'CDKN2B-AS1',
    transcript_id: 'ENST00000421632',
    major_consequence: 'intron_variant',
    is_mane_select: null,
    is_canonical: null,
    hgvsc: 'n.502+774T>A',
    hgvsp: null,
    lof: null,
  },
];

/** transcript_consequences of gnomad_r2_1 1-55516888-G-GA: GRCh37, so no MANE status on any entry. */
export const PCSK9_FRAMESHIFT_R2_1 = [
  {
    gene_id: 'ENSG00000169174',
    gene_symbol: 'PCSK9',
    transcript_id: 'ENST00000452118',
    major_consequence: 'frameshift_variant',
    is_mane_select: null,
    is_canonical: null,
    hgvsc: 'c.547_548insA',
    hgvsp: 'p.Gly183GlufsTer23',
    lof: 'HC',
  },
  {
    gene_id: 'ENSG00000169174',
    gene_symbol: 'PCSK9',
    transcript_id: 'ENST00000302118',
    major_consequence: 'intron_variant',
    is_mane_select: null,
    is_canonical: true,
    hgvsc: 'c.524-1063_524-1062insA',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000169174',
    gene_symbol: 'PCSK9',
    transcript_id: 'ENST00000543384',
    major_consequence: 'intron_variant',
    is_mane_select: null,
    is_canonical: null,
    hgvsc: 'c.-77-1063_-77-1062insA',
    hgvsp: null,
    lof: null,
  },
  {
    gene_id: 'ENSG00000169174',
    gene_symbol: 'PCSK9',
    transcript_id: 'ENST00000490692',
    major_consequence: 'non_coding_transcript_exon_variant',
    is_mane_select: null,
    is_canonical: null,
    hgvsc: 'n.282_283insA',
    hgvsp: null,
    lof: null,
  },
];

/** gnomad_r4 PCSK9 rows: start_lost on the MANE Select transcript, and on ENST00000673903 (3 of 4,544 rows sit there). */
export const PCSK9_R4_GENE = {
  chrom: '1',
  canonical_transcript_id: 'ENST00000302118',
  mane_select_transcript: { ensembl_id: 'ENST00000302118' },
  variants: [
    {
      variant_id: '1-55039838-A-G',
      consequence: 'start_lost',
      transcript_id: 'ENST00000302118',
      flags: [],
      exome: { ac: 6, an: 1414526, af: 4.241703581270334e-6, homozygote_count: 0, filters: [] },
      genome: null,
      joint: { ac: 6, an: 1566868, homozygote_count: 0 },
    },
    {
      variant_id: '1-55044012-T-A',
      consequence: 'start_lost',
      transcript_id: 'ENST00000673903',
      flags: [],
      exome: { ac: 24, an: 1461876, af: 1.6417261108329296e-5, homozygote_count: 0, filters: [] },
      genome: null,
      joint: { ac: 24, an: 1614224, homozygote_count: 0 },
    },
  ],
};

/** gnomad_r2_1 CDKN2A rows: no MANE Select on GRCh37; canonical ENST00000498124 holds 458 of 769 rows. */
export const CDKN2A_R2_1_GENE = {
  chrom: '9',
  canonical_transcript_id: 'ENST00000498124',
  mane_select_transcript: null,
  variants: [
    {
      variant_id: '9-21968154-G-T',
      consequence: '3_prime_UTR_variant',
      transcript_id: 'ENST00000498124',
      flags: [],
      exome: null,
      genome: { ac: 1, an: 31172, af: 3.208007185936096e-5, homozygote_count: 0, filters: [] },
      joint: null,
    },
    {
      variant_id: '9-21968212-A-G',
      consequence: 'missense_variant',
      transcript_id: 'ENST00000579122',
      flags: [],
      exome: { ac: 1, an: 251396, af: 3.9777880316313705e-6, homozygote_count: 0, filters: [] },
      genome: null,
      joint: null,
    },
  ],
};

/** The gnomad_r4 row of intergenic region 4-45000004-45000004: no consequence, no transcript. */
export const INTERGENIC_R4_ROW = {
  variant_id: '4-45000004-T-C',
  consequence: null,
  transcript_id: null,
  flags: [],
  exome: null,
  genome: { ac: 4, an: 152212, af: 2.6279136993141146e-5, homozygote_count: 0, filters: [] },
  joint: { ac: 4, an: 152212, homozygote_count: 0 },
};
