import type { JSX } from "react";
import type { Order } from "../types/models.ts";
import { formatPrice } from "./format.ts";

export function OrderSummary({ order }: { readonly order: Order }): JSX.Element {
  const total = order.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  return <article aria-label={`Order ${order.id}`}>
    <h3>Order {order.id}</h3>
    <p>Status: {order.status}</p>
    <p>Total: {formatPrice(total)}</p>
  </article>;
}
