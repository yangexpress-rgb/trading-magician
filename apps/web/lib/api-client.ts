import { createApiClient } from '@tm/contracts';

/** Browser client for /api/v1; the session cookie travels with same-origin requests. */
export const apiClient = createApiClient();
