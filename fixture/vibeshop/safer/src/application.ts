import type { DatabaseFactory } from "./data/database.ts";
import type { SessionVerifier } from "./auth/session.ts";
import type { SecretSource } from "./config/secret-source.ts";
import type { ShopRequest } from "./types/http.ts";
import { loadSettings } from "./config/settings.ts";
import { getCatalog } from "./api/catalog.ts";
import { searchProducts } from "./api/search.ts";
import { getOrder } from "./api/order.ts";
import { getCurrentCustomer, getCustomerOrders } from "./api/customer.ts";
import { updateProduct } from "./api/products.ts";

export interface ApplicationPorts {
  readonly database: DatabaseFactory;
  readonly sessions: SessionVerifier;
  readonly secrets: SecretSource;
}

// A host would supply trusted session verification and database adapters. None are shipped here.
export function createShopApplication(ports: ApplicationPorts) {
  const database = ports.database.create(loadSettings(ports.secrets));
  return {
    routes: [
      { method: "GET", path: "/products", handle: () => getCatalog(database) },
      { method: "GET", path: "/products/search", handle: (request: ShopRequest) => searchProducts(request, database) },
      { method: "GET", path: "/orders/:orderId", handle: (request: ShopRequest) => getOrder(request, database, ports.sessions) },
      { method: "GET", path: "/account", handle: (request: ShopRequest) => getCurrentCustomer(request, ports.sessions) },
      { method: "GET", path: "/account/orders", handle: (request: ShopRequest) => getCustomerOrders(request, database, ports.sessions) },
      { method: "PATCH", path: "/admin/products/:productId", handle: (request: ShopRequest) => updateProduct(request, database, ports.sessions) },
    ],
  };
}
