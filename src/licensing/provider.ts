/**
 * Payment/license provider abstraction. The licensing flow (trial, offline
 * grace, machine activation) is provider-neutral; only this thin adapter layer
 * differs between Lemon Squeezy and Polar. Pick one with RMP_LICENSE_PROVIDER.
 */

import { LICENSE_PROVIDER } from "./config.js";
import * as lemonsqueezy from "./lemonsqueezy.js";
import * as polar from "./polar.js";

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

export interface LicenseProvider {
  activate(licenseKey: string, instanceName: string): Promise<ProviderResult>;
  validate(licenseKey: string, instanceId?: string): Promise<ProviderResult>;
}

/** The active provider, selected at load time. */
export const provider: LicenseProvider = LICENSE_PROVIDER === "polar" ? polar : lemonsqueezy;
