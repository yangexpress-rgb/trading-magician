import { createServer, type Server } from 'node:http';

export interface HealthReport {
  status: 'ok';
  service: 'worker';
  /** Which job loops this worker runs. Order runtimes arrive in Phase 3. */
  jobs: 'none' | 'backtests';
}

export function healthReport(jobs: HealthReport['jobs'] = 'none'): HealthReport {
  return { status: 'ok', service: 'worker', jobs };
}

export function createHealthServer(jobs: HealthReport['jobs'] = 'none'): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthReport(jobs)));
      return;
    }
    res.writeHead(404).end();
  });
}
