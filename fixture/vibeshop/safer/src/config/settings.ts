import type { SecretSource } from "./secret-source.ts";

export interface ShopSettings {
  readonly adapter: "synthetic-memory";
  readonly serviceCredential: string;
}

export function loadSettings(source: SecretSource): ShopSettings {
  const serviceCredential = source.read("VIBESHOP_SERVICE_CREDENTIAL");
  if (!serviceCredential || !serviceCredential.trim()) {
    throw new Error("VIBESHOP_SERVICE_CREDENTIAL must be supplied by the host secret source");
  }
  return Object.freeze({ adapter: "synthetic-memory", serviceCredential });
}
