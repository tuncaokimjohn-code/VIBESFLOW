import { requireUser, type SessionVerifier } from "../auth/session.ts";
import { customerOrders } from "../data/orders.ts";
import type { ShopDatabase } from "../data/database.ts";
import type { ShopRequest } from "../types/http.ts";

export async function getCurrentCustomer(request: ShopRequest, sessions: SessionVerifier) {
  const viewer = await requireUser(request, sessions);
  return { id: viewer.id, displayName: viewer.displayName };
}

export async function getCustomerOrders(
  request: ShopRequest, database: ShopDatabase, sessions: SessionVerifier,
) {
  const viewer = await requireUser(request, sessions);
  return customerOrders(database, viewer.id);
}
