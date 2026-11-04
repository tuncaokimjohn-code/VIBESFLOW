import type { Customer } from "../types/models.ts";
import { HttpError, type ShopRequest } from "../types/http.ts";

export interface VerifiedSession {
  readonly customer: Customer;
  readonly expiresAt: number;
  readonly audience: string;
}

// The host must verify token authenticity, revocation, issuer and identity before returning a session.
export interface SessionVerifier {
  verify(token: string): Promise<VerifiedSession | null>;
}

export async function requireUser(
  request: ShopRequest,
  verifier: SessionVerifier,
  now: number = Date.now(),
): Promise<Customer> {
  const token = request.sessionToken;
  if (typeof token !== "string" || token.length < 1 || token.length > 4096) {
    throw new HttpError(401, "Sign in required");
  }
  const session = await verifier.verify(token);
  if (!session || !Number.isFinite(session.expiresAt) || session.expiresAt <= now ||
      session.audience !== "vibeshop-fixture" || !session.customer.id ||
      !["customer", "administrator"].includes(session.customer.role)) {
    throw new HttpError(401, "Sign in required");
  }
  return session.customer;
}
