/**
 * Shared result shape returned by the license provider (Polar). The licensing
 * flow (trial, offline grace, machine activation) reads only these fields.
 */

export interface ProviderResult {
  /** The request completed and returned a parseable answer. */
  reachable: boolean;
  /** The provider considers the key valid/active. */
  valid: boolean;
  /** The key belongs to THIS product (ownership confirmed). */
  owns: boolean;
  /** Key/subscription status, provider-specific string. */
  status?: string;
  /** Subscription/expiry timestamp, if any. */
  expiresAt?: string | null;
  /** Activation instance id (from activate). */
  instanceId?: string;
  /** Error text from the provider or transport. */
  error?: string;
}
