import { LIVE_TRADING_ENABLED } from '@tm/domain';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', service: 'web', liveTrading: LIVE_TRADING_ENABLED });
}
