export interface ShopRequest {
  readonly sessionToken?: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

export class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
