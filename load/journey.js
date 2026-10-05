/**
 * The §19 load target Yong approved: 20 people, 5 strategies each, 10 back
 * tests at once; pages p95 under 1 s. See load/README.md. Needs k6 and
 * load/users.json from `pnpm --filter @tm/db load:seed`.
 */
import { check, fail, sleep } from 'k6';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const users = JSON.parse(open('./users.json'));
const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const CONCURRENT_BACKTESTS = Number(__ENV.CONCURRENT_BACKTESTS || 10);

const backtestWait = new Trend('backtest_wait', true);

export const options = {
  scenarios: {
    browsing: {
      executor: 'per-vu-iterations',
      vus: users.length,
      iterations: 5,
      maxDuration: '10m',
      exec: 'browse',
    },
    backtests: {
      executor: 'shared-iterations',
      vus: CONCURRENT_BACKTESTS,
      iterations: CONCURRENT_BACKTESTS,
      maxDuration: '10m',
      exec: 'backtest',
    },
  },
  thresholds: {
    'http_req_duration{kind:page}': ['p(95)<1000'],
    'http_req_duration{kind:api}': ['p(95)<1000'],
    checks: ['rate==1.00'],
  },
};

function signIn() {
  const user = users[(__VU - 1) % users.length];
  const res = http.post(
    `${BASE}/api/auth/sign-in/email`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: { 'content-type': 'application/json', origin: BASE }, tags: { kind: 'api' } },
  );
  if (!check(res, { 'signed in': (r) => r.status === 200 })) fail(`sign-in failed: ${res.status}`);
  return { origin: BASE };
}

export function browse() {
  const headers = signIn();
  for (const path of ['/strategy-lab', '/orders', '/performance', '/settings/billing']) {
    const res = http.get(`${BASE}${path}`, { headers, tags: { kind: 'page' } });
    check(res, { [`${path} loaded`]: (r) => r.status === 200 });
    sleep(1);
  }
}

export function backtest() {
  const headers = { ...signIn(), 'content-type': 'application/json' };
  const list = http.get(`${BASE}/api/v1/strategies`, { headers, tags: { kind: 'api' } });
  const strategies = list.json('strategies') || [];
  if (!check(strategies, { 'has a strategy': (s) => s.length > 0 })) return;
  const id = strategies[0].id;
  const started = Date.now();
  const queued = http.post(
    `${BASE}/api/v1/strategies/${id}/backtests`,
    JSON.stringify({ from: '2024-01-02', to: '2024-06-28' }),
    { headers, tags: { kind: 'api' } },
  );
  if (!check(queued, { 'back test queued': (r) => r.status === 202 })) return;
  const runId = queued.json('id');
  for (let i = 0; i < 120; i += 1) {
    sleep(1);
    const run = http.get(`${BASE}/api/v1/backtests/${runId}`, { headers, tags: { kind: 'api' } });
    const status = run.json('status');
    if (status === 'completed' || status === 'failed') {
      backtestWait.add(Date.now() - started);
      check(status, { 'back test completed': (s) => s === 'completed' });
      return;
    }
  }
  fail('back test did not finish within two minutes');
}
