import type { Instrumentation } from 'next';

/**
 * Errors thrown while rendering pages or running route handlers outside the
 * /api/v1 wrapper are logged and reported here (ADR 0025).
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { logger } = await import('./lib/server/log');
  logger().error(
    {
      err: error,
      method: request.method,
      route: context.routePath,
      routeType: context.routeType,
    },
    'Request failed',
  );
};
