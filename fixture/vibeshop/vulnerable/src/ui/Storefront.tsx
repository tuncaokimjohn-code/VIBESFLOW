import type { JSX } from "react";
import type { Order, Product, Review } from "../types/models.ts";
import { ProductCard } from "./ProductCard.tsx";
import { ReviewCard } from "./ReviewCard.tsx";
import { OrderSummary } from "./OrderSummary.tsx";

export interface StorefrontProps {
  readonly products: readonly Product[];
  readonly reviews: readonly Review[];
  readonly orders: readonly Order[];
}

export function Storefront({ products, reviews, orders }: StorefrontProps): JSX.Element {
  return <main>
    <header><h1>VibeShop</h1><p>A fictional shopping catalog for local source analysis.</p></header>
    <section aria-labelledby="catalog-heading">
      <h2 id="catalog-heading">Products</h2>
      {products.length === 0 ? <p>No products found.</p> : products.map(product =>
        <ProductCard key={product.id} product={product} />)}
    </section>
    <section aria-labelledby="review-heading">
      <h2 id="review-heading">Customer reviews</h2>
      {reviews.map(review => <ReviewCard key={review.id} review={review} />)}
    </section>
    <section aria-labelledby="order-heading">
      <h2 id="order-heading">Your orders</h2>
      {orders.map(order => <OrderSummary key={order.id} order={order} />)}
    </section>
  </main>;
}
