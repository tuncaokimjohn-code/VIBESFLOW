import type { Order, Product, ProductUpdate } from "../types/models.ts";
import type { ShopSettings } from "../config/settings.ts";

export interface ShopDatabase {
  queryProducts(sql: string, parameters: readonly string[]): Promise<readonly Product[]>;
  orders: {
    findById(id: string): Promise<Order | null>;
    findByCustomer(customerId: string): Promise<readonly Order[]>;
  };
  products: {
    update(id: string, update: ProductUpdate): Promise<Product | null>;
  };
}

// Interfaces only: this project supplies no live connection or query executor.
export interface DatabaseFactory {
  create(settings: ShopSettings): ShopDatabase;
}
