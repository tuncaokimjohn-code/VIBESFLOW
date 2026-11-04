import type { JSX } from "react";
import type { Review } from "../types/models.ts";

export function ReviewCard({ review }: { readonly review: Review }): JSX.Element {
  return <article aria-label={`Review by ${review.authorLabel}`}>
    <h3>{review.authorLabel}</h3>
    <div dangerouslySetInnerHTML={{ __html: review.body }} />
  </article>;
}
