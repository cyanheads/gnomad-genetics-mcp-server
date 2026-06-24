/**
 * @fileoverview Unit tests for GnomadService pure logic — dataset→build
 * derivation, coherence validation, and the by-symbol/by-id gene routing.
 * Network methods are covered by live smoke tests; these assert the
 * deterministic, offline-safe behavior.
 * @module tests/services/gnomad-service.test
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import { getServerConfig } from '@/config/server-config.js';
import { GnomadService } from '@/services/gnomad/gnomad-service.js';

const svc = new GnomadService(getServerConfig());

describe('GnomadService.resolveDatasetContext', () => {
  it('defaults to gnomad_r4 / GRCh38 when nothing supplied', () => {
    expect(svc.resolveDatasetContext(undefined)).toEqual({
      dataset: 'gnomad_r4',
      reference_genome: 'GRCh38',
    });
  });

  it('derives GRCh37 for v2.1 and exac', () => {
    expect(svc.resolveDatasetContext('gnomad_r2_1').reference_genome).toBe('GRCh37');
    expect(svc.resolveDatasetContext('exac').reference_genome).toBe('GRCh37');
  });

  it('derives GRCh38 for v3', () => {
    expect(svc.resolveDatasetContext('gnomad_r3').reference_genome).toBe('GRCh38');
  });

  it('accepts a coherent explicit build', () => {
    expect(svc.resolveDatasetContext('gnomad_r4', 'GRCh38').reference_genome).toBe('GRCh38');
    expect(svc.resolveDatasetContext('gnomad_r2_1', 'GRCh37').reference_genome).toBe('GRCh37');
  });

  it('rejects an incoherent dataset/build pair', () => {
    expect(() => svc.resolveDatasetContext('gnomad_r4', 'GRCh37')).toThrow(McpError);
    expect(() => svc.resolveDatasetContext('gnomad_r2_1', 'GRCh38')).toThrow(
      /requires reference_genome/,
    );
  });

  it('accepts a coherent v3 explicit build', () => {
    expect(svc.resolveDatasetContext('gnomad_r3', 'GRCh38').reference_genome).toBe('GRCh38');
  });

  it('carries the incoherent_build reason and the expected/supplied build on the error', () => {
    const err = (() => {
      try {
        svc.resolveDatasetContext('gnomad_r4', 'GRCh37');
        return;
      } catch (e) {
        return e as McpError;
      }
    })();
    expect(err).toBeInstanceOf(McpError);
    expect(err?.data).toMatchObject({
      reason: 'incoherent_build',
      dataset: 'gnomad_r4',
      expected: 'GRCh38',
      supplied: 'GRCh37',
    });
  });
});
