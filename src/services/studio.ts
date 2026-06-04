/**
 * Thin helper around the bridge for invoking Studio-side handlers from tools.
 */

import { bridge, StudioError } from "./bridge.js";

/**
 * Run a handler in Studio and return its result.
 * Throws {@link StudioError} with an actionable message on failure.
 */
export async function callStudio<T = unknown>(
  tool: string,
  args: unknown,
): Promise<T> {
  return (await bridge.enqueue(tool, args)) as T;
}

/** Convert any thrown value into a clear, actionable error string for tools. */
export function describeError(error: unknown): string {
  if (error instanceof StudioError) return `Error: ${error.message}`;
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: ${String(error)}`;
}
