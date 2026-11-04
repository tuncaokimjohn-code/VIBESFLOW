import type { ShopDatabase } from "../data/database.ts";
import { listCatalog } from "../data/catalog.ts";

export function getCatalog(database: ShopDatabase) {
  return listCatalog(database);
}
