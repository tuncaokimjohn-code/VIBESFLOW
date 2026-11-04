import type { ShopDatabase } from "../data/database.ts";
import type { ShopRequest } from "../types/http.ts";
import { readSearchTerm } from "./input.ts";

export async function searchProducts(request: ShopRequest, database: ShopDatabase) {
  const term = readSearchTerm(request.query.q);
  const sql = "SELECT id, name, description, price_cents, active FROM products WHERE active = TRUE AND POSITION(LOWER($1) IN LOWER(name)) > 0 ORDER BY name LIMIT 24";
  return database.queryProducts(sql, [term]);
}
