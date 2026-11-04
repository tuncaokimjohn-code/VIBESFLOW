import { requireUser, type SessionVerifier } from "../auth/session.ts";
import { requireAdministrator } from "../auth/permissions.ts";
import type { ShopDatabase } from "../data/database.ts";
import { HttpError, type ShopRequest } from "../types/http.ts";
import { readIdentifier, readProductUpdate } from "./input.ts";

export async function updateProduct(request: ShopRequest, database: ShopDatabase, sessions: SessionVerifier) {
  const viewer = await requireUser(request, sessions);
  requireAdministrator(viewer);
  const productId = readIdentifier(request.params.productId);
  const update = readProductUpdate(request.body);
  const product = await database.products.update(productId, update);
  if (!product) throw new HttpError(404, "Product not found");
  return product;
}
