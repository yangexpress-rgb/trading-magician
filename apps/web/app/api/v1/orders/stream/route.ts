import { api } from '@/lib/server/api';
import { subscribeToExecutionChanges } from '@/lib/server/execution-events';

export const dynamic = 'force-dynamic';

const PING_MS = 20_000;
const DEBOUNCE_MS = 150;

/**
 * Live updates for the Orders tab (§15.2) as server-sent events. Each `change`
 * event says only that this user's orders, positions or runtimes may have
 * changed; the page then re-reads them through the normal API.
 */
export const GET = api(async (request, { userId }) => {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = subscribeToExecutionChanges(userId, () => {
        timer ??= setTimeout(() => {
          timer = undefined;
          send('event: change\ndata: {}\n\n');
        }, DEBOUNCE_MS);
      });
      const ping = setInterval(() => send(': ping\n\n'), PING_MS);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      request.signal.addEventListener('abort', () => cleanup());
      send('retry: 3000\n\nevent: ready\ndata: {}\n\n');
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
});
