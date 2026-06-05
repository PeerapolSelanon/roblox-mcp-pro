/**
 * Thin helper tools use to invoke Studio-side handlers. Routes through the
 * client transport to the shared broker, which forwards to the Studio plugin.
 */

import { StudioError } from "./errors.js";
import { call } from "../client/transport.js";

/**
 * Run a handler in Studio and return its result.
 * Throws {@link StudioError} with an actionable message on failure.
 */
export async function callStudio<T = unknown>(
  tool: string,
  args: unknown,
): Promise<T> {
  return call<T>(tool, args);
}

/** Convert any thrown value into a clear, actionable error string for tools. */
export function describeError(error: unknown): string {
  if (error instanceof StudioError) return `Error: ${error.message}`;
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: ${String(error)}`;
}
