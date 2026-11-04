import type { ShopDatabase } from "./database.ts";
import type { Product } from "../types/models.ts";

export function listCatalog(database: ShopDatabase): Promise<readonly Product[]> {
  return database.queryProducts(
    "SELECT id, name, description, price_cents, active FROM products WHERE active = TRUE ORDER BY name LIMIT 24",
    [],
  );
}
