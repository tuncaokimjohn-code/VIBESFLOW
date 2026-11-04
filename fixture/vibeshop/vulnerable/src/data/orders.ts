import type { ShopDatabase } from "./database.ts";
import type { Order } from "../types/models.ts";

export function findOrder(database: ShopDatabase, id: string): Promise<Order | null> {
  return database.orders.findById(id);
}

export function customerOrders(database: ShopDatabase, customerId: string): Promise<readonly Order[]> {
  return database.orders.findByCustomer(customerId);
}
