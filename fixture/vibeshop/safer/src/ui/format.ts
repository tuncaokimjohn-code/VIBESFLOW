export function formatPrice(priceCents: number): string {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
    throw new RangeError("Expected non-negative integer cents");
  }
  return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" })
    .format(priceCents / 100);
}
