/**
 * @fileoverview gnomad_dataframe_drop — opt-in tool to drop a named table from a
 * canvas to reclaim memory. A mutation (readOnlyHint: false), so it is gated
 * behind GNOMAD_DATAFRAME_DROP_ENABLED (off by default) via the disabledTool()
 * wrapper: present in the manifest/landing page but absent from tools/list and
 * uncallable when off. Per-table TTL already reclaims memory automatically — this
 * is a convenience, not a requirement.
 * @module mcp-server/tools/definitions/gnomad-dataframe-drop.tool
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCanvas } from '@/services/canvas-accessor.js';

const gnomadDataframeDropDef = tool('gnomad_dataframe_drop', {
  title: 'gnomad-genetics-mcp-server: dataframe drop',
  description:
    'Drop a named table from a canvas to reclaim memory. Opt-in and off by default — a deliberate mutation on the otherwise read-only research surface. Use the canvas_id and table_name from a prior staging call. Per-table TTL already reclaims memory automatically, so this is a convenience for operators who want manual control.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  input: z.object({
    canvas_id: z.string().min(1).describe('Canvas ID holding the table to drop.'),
    table_name: z
      .string()
      .min(1)
      .describe('Name of the table to drop (e.g. gene_variants, clinvar_variants).'),
  }),
  output: z.object({
    dropped: z
      .boolean()
      .describe('True when the table existed and was dropped; false when no such table.'),
  }),
  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'DataCanvas is not enabled on this server instance.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb and restart; the staging tools then return a queryable canvas_id.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled. Set CANVAS_PROVIDER_TYPE=duckdb.',
        {
          ...ctx.recoveryFor('canvas_disabled'),
        },
      );
    }
    const instance = await canvas.acquire(input.canvas_id, ctx);
    const dropped = await instance.drop(input.table_name);
    ctx.log.info('gnomad_dataframe_drop executed', {
      canvas_id: instance.canvasId,
      table_name: input.table_name,
      dropped,
    });
    return { dropped };
  },

  format: (result) => [
    {
      type: 'text',
      text: result.dropped ? 'Table dropped.' : 'No such table on this canvas — nothing dropped.',
    },
  ],
});

/**
 * Conditionally registered: the real tool when GNOMAD_DATAFRAME_DROP_ENABLED=true,
 * otherwise a disabled placeholder absent from tools/list (present-but-uncallable
 * on the manifest/landing page).
 */
export const gnomadDataframeDrop = getServerConfig().dataframeDropEnabled
  ? gnomadDataframeDropDef
  : disabledTool(gnomadDataframeDropDef, {
      reason:
        'Canvas table drop is turned off in this deployment — the research surface stays read-only.',
      hint: 'GNOMAD_DATAFRAME_DROP_ENABLED=true',
    });
