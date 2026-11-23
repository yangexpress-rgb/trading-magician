import { liveTradingEnabled } from '@tm/domain';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', service: 'web', liveTrading: liveTradingEnabled() });
}
