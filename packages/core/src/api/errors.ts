/**
 * Error thrown when a Safe API request fails, or when a service answers with
 * a record that does not match the request.
 */
export class SafeApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly response?: unknown
  ) {
    super(message)
    this.name = 'SafeApiError'
  }
}
