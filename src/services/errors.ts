/**
 * Shared error types.
 *
 * Lives in its own module (not bridge.ts) so the client transport can throw and
 * tools can `instanceof`-check StudioError without pulling in the broker's HTTP
 * server code.
 */

/** Raised when a command fails on the Studio plugin side or never completes. */
export class StudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioError";
  }
}
