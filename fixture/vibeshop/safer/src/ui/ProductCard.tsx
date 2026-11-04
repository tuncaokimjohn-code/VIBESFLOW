import type { JSX } from "react";
import type { Product } from "../types/models.ts";
import { formatPrice } from "./format.ts";

export function ProductCard({ product }: { readonly product: Product }): JSX.Element {
  return <article aria-label={product.name}>
    <h3>{product.name}</h3>
    <p>{product.description}</p>
    <p>{formatPrice(product.priceCents)}</p>
  </article>;
}
