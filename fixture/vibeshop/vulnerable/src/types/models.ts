export type UserRole = "customer" | "administrator";

export interface Customer {
  readonly id: string;
  readonly displayName: string;
  readonly role: UserRole;
}

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly active: boolean;
}

export interface OrderLine {
  readonly productId: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface Order {
  readonly id: string;
  readonly customerId: string;
  readonly status: "placed" | "shipped";
  readonly lines: readonly OrderLine[];
}

export interface Review {
  readonly id: string;
  readonly productId: string;
  readonly authorLabel: string;
  readonly body: string;
}

export interface ProductUpdate {
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
}
