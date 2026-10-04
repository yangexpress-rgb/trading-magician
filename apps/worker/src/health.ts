import { createServer, type Server } from 'node:http';

export interface HealthReport {
  status: 'ok';
  service: 'worker';
  /** Phase 0/1 worker runs no jobs; queues and runtimes arrive in Phase 2–3. */
  jobs: 'none';
}

export function healthReport(): HealthReport {
  return { status: 'ok', service: 'worker', jobs: 'none' };
}

export function createHealthServer(): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(healthReport()));
      return;
    }
    res.writeHead(404).end();
  });
}
