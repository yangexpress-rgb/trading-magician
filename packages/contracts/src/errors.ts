/**
 * Error body for every /api/v1 response that isn't 2xx. `message` is safe to
 * show to the user; `issues` carries field-level problems for forms.
 */
export const API_ERROR_CODES = [
  'unauthenticated',
  'forbidden_origin',
  'not_found',
  'bad_request',
  'conflict',
  'invalid_state',
  'invalid_definition',
  'transition_blocked',
  'rate_limited',
  'limit_reached',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiIssue {
  path: (string | number)[];
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    issues?: ApiIssue[];
    details?: unknown;
  };
}

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden_origin: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  invalid_state: 409,
  invalid_definition: 422,
  transition_blocked: 422,
  rate_limited: 429,
  limit_reached: 429,
  internal: 500,
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody['error'],
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
  get code(): ApiErrorCode {
    return this.body.code;
  }
}
