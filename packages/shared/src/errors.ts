export class ProxyError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
    public readonly provider?: string,
  ) {
    super(message);
    this.name = 'ProxyError';
  }
}
