import type { Customer } from "../types/models.ts";
import { HttpError } from "../types/http.ts";

export function requireAdministrator(customer: Customer): void {
  if (customer.role !== "administrator") {
    throw new HttpError(403, "Administrator access required");
  }
}
