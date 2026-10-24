/**
 * @fileoverview Load cwd .env before the entrypoint's definition graph evaluates.
 * @module config/environment
 */
try {
  process.loadEnvFile();
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
