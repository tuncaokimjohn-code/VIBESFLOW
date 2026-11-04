import type { SecretSource } from "./secret-source.ts";

export interface ShopSettings {
  readonly adapter: "synthetic-memory";
  readonly serviceCredential: string;
}

export function loadSettings(_source: SecretSource): ShopSettings {
  return Object.freeze({
    adapter: "synthetic-memory",
    serviceCredential: "SYNTHETIC_VIBESHOP_NOT_A_REAL_SECRET_0000",
  });
}
