export class APIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export class APIClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; authenticated?: boolean } = {},
  ): Promise<T> {
    if (options.authenticated && !this.token) {
      throw new Error(
        'Authentication required. Set TASKQUEUE_TOKEN or run `taskqueue auth login --secret ...`.',
      );
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`Unable to reach ${this.baseUrl}: ${(error as Error).message}`);
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const message =
        typeof body === 'object' && body && 'error' in body
          ? String((body as { error: unknown }).error)
          : `${response.status} ${response.statusText}`;
      throw new APIError(message, response.status, body);
    }

    return body as T;
  }
}
