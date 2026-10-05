import { listOfferedPlans } from '@tm/db';
import type { PlanListDto } from '@tm/contracts';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) => {
  const body: PlanListDto = { plans: await tx(listOfferedPlans) };
  return Response.json(body);
});
