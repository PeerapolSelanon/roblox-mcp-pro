/**
 * Shared response formatting helpers used by tools.
 *
 * Every tool returns both human-readable `content` text and machine-readable
 * `structuredContent`, truncating oversized payloads per CHARACTER_LIMIT.
 */

import { CHARACTER_LIMIT } from "../constants.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** The SDK's CallToolResult carries an open index signature. */
  [key: string]: unknown;
}

/** Build a successful tool result from structured data + a text rendering. */
export function ok(
  structured: Record<string, unknown>,
  text: string,
): ToolResult {
  return {
    content: [{ type: "text", text: truncate(text) }],
    structuredContent: structured,
  };
}

/** Build an error tool result (text only). */
export function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Truncate text to CHARACTER_LIMIT with an explanatory suffix. */
export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const head = text.slice(0, CHARACTER_LIMIT);
  return (
    head +
    `\n\n…[truncated ${text.length - CHARACTER_LIMIT} of ${text.length} chars. ` +
    "Narrow the query, add filters, or use pagination to see more.]"
  );
}
