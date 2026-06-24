/**
 * @fileoverview Module-level accessor for the framework's optional DataCanvas.
 * The canvas is wired onto CoreServices (not Context), so handlers reach it via
 * this shim, set once in createApp's setup() callback. Not a domain service —
 * the access pattern the api-canvas skill prescribes.
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Wire the framework canvas (or undefined when CANVAS_PROVIDER_TYPE=none). */
export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

/** Get the canvas, or undefined when DataCanvas is not enabled. */
export const getCanvas = (): DataCanvas | undefined => _canvas;
