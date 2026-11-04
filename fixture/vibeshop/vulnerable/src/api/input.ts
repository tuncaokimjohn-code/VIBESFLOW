import type { ProductUpdate } from "../types/models.ts";
import { HttpError } from "../types/http.ts";

export function readIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]+-[0-9]{3,8}$/.test(value)) {
    throw new HttpError(400, "Invalid identifier");
  }
  return value;
}

export function readSearchTerm(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 100) {
    throw new HttpError(400, "Search requires 1 to 100 characters");
  }
  return value.trim();
}

function readText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new HttpError(400, "Invalid product text");
  }
  return value.trim();
}

export function readProductUpdate(body: unknown): ProductUpdate {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Invalid product update");
  }
  const fields = body as Record<string, unknown>;
  const priceCents = fields.priceCents;
  if (typeof priceCents !== "number" || !Number.isSafeInteger(priceCents) ||
      priceCents < 0 || priceCents > 1_000_000) {
    throw new HttpError(400, "Invalid product price");
  }
  return {
    name: readText(fields.name, 120),
    description: readText(fields.description, 2000),
    priceCents,
  };
}
