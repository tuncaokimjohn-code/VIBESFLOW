import products from "../../../synthetic-data/products.json";
import orders from "../../../synthetic-data/orders.json";
import reviews from "../../../synthetic-data/reviews.json";
import customers from "../../../synthetic-data/customers.json";
import type { Product, Order, Review, Customer } from "../types/models.ts";

export interface SyntheticData {
  readonly products: readonly Product[];
  readonly orders: readonly Order[];
  readonly reviews: readonly Review[];
  readonly customers: readonly Customer[];
}

export const syntheticData: SyntheticData = { products, reviews,
  orders: orders as Order[], customers: customers as Customer[] };
