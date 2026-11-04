import { requireUser, type SessionVerifier } from "../auth/session.ts";
import type { ShopDatabase } from "../data/database.ts";
import { findOrder } from "../data/orders.ts";
import { HttpError, type ShopRequest } from "../types/http.ts";
import { readIdentifier } from "./input.ts";

export async function getOrder(request: ShopRequest, database: ShopDatabase, sessions: SessionVerifier) {
  const viewer = await requireUser(request, sessions);
  const orderId = readIdentifier(request.params.orderId);
  const order = await findOrder(database, orderId);
  if (!order) throw new HttpError(404, "Order not found");
  return order;
}
