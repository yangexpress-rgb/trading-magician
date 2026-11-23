import { createDb } from '@tm/db';
import { finraClient } from '../src/short-interest/finra';
import { runShortInterestPass } from '../src/short-interest/job';

/**
 * The full FINRA short interest backfill (data inputs part 2, item B, N323):
 * every published settlement from December 2017 to today, in passes of 10,
 * until none is left. Resumable: stored settlements are skipped, so a run
 * that stops can simply be started again. The worker's own loop does the same
 * work more slowly; this is for doing it in one go.
 *
 *   DATABASE_WORKER_URL=… FINRA_CLIENT_ID=… FINRA_CLIENT_SECRET=… \
 *     pnpm --filter @tm/worker short-interest:backfill
 */
const url = process.env.DATABASE_WORKER_URL ?? process.env.DATABASE_APP_URL;
const clientId = process.env.FINRA_CLIENT_ID?.trim();
const clientSecret = process.env.FINRA_CLIENT_SECRET?.trim();
if (!url || !clientId || !clientSecret) {
  process.stderr.write('Needs DATABASE_WORKER_URL, FINRA_CLIENT_ID and FINRA_CLIENT_SECRET\n');
  process.exit(1);
}
const handle = createDb(url, { max: 2 });
const logger = {
  info: (obj: object, msg: string) => process.stdout.write(`${msg} ${JSON.stringify(obj)}\n`),
  warn: (obj: object, msg: string) => process.stderr.write(`${msg} ${JSON.stringify(obj)}\n`),
};
const client = finraClient({
  clientId,
  clientSecret,
  apiUrl: process.env.FINRA_API_URL,
  tokenUrl: process.env.FINRA_TOKEN_URL,
});
try {
  for (;;) {
    const r = await runShortInterestPass({ db: handle.db, client, logger, perPass: 10 });
    process.stdout.write(`stored ${r.fetched.length} settlements; ${r.pending} left\n`);
    if (r.pending === 0) break;
  }
} finally {
  await handle.close();
}
