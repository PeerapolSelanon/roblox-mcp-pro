/**
 * Reusable Zod fragments shared across tool schemas.
 */

import { z } from "zod";

/** A dotted instance path rooted at `game`, e.g. "game.Workspace.Baseplate". */
export const InstancePath = z
  .string()
  .min(1, "Path must not be empty")
  .max(500, "Path must not exceed 500 characters")
  .describe(
    "Full instance path rooted at a service, e.g. 'game.Workspace.Model.Part' " +
      "or 'Workspace.Baseplate'. Duplicate-named siblings can be picked with a " +
      "1-based index: 'Workspace.Part[2]' = the second child named Part.",
  );

/** A 3-number [x, y, z] vector. */
export const Vec3 = z
  .array(z.number())
  .length(3)
  .describe("A 3-number [x, y, z] vector.");

/** Standard pagination fragment. */
export const pagination = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe("Maximum number of results to return (1-500, default 100)."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Number of results to skip, for pagination (default 0)."),
};
