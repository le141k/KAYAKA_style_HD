/**
 * Aggregate-only BullMQ cutover gate. Run after the API is quiesced and before
 * snapshotting/replacing Redis storage. No worker may be active while the RDB
 * is captured; waiting/delayed jobs are preserved by the volume migration.
 */
import { Queue } from 'bullmq';
import Redis from 'ioredis';

const JOB_STATES = [
  'wait',
  'active',
  'delayed',
  'failed',
  'paused',
  'prioritized',
  'waiting-children',
] as const;

const OPERATION_TIMEOUT_MS = 15_000;

function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Redis cutover ${label} timed out`)),
      OPERATION_TIMEOUT_MS,
    );
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function cutoverStateIsClean(input: {
  pauseRequested: boolean;
  resumeRequested: boolean;
  active: number;
  allPaused: boolean;
}): boolean {
  if (input.pauseRequested) return input.active === 0 && input.allPaused;
  if (input.resumeRequested) return !input.allPaused;
  return input.active === 0;
}

async function main(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'];
  if (!redisUrl) throw new Error('REDIS_URL is required');

  // This is an operator gate, not a long-lived worker. Every invocation must
  // fail within a bounded time so the deploy script's outer drain deadline is
  // real even when Redis is unreachable.
  const connection = new Redis(redisUrl, {
    connectTimeout: 5_000,
    commandTimeout: 10_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => (attempt <= 2 ? Math.min(attempt * 250, 1_000) : null),
  });
  const queueNames = ['mail', 'reports', 'sla', 'workflow'] as const;
  const queues = queueNames.map((name) => new Queue(name, { connection }));
  try {
    await withTimeout(Promise.all(queues.map((queue) => queue.waitUntilReady())), 'connection');
    const pauseRequested = process.argv.includes('--pause');
    const resumeRequested = process.argv.includes('--resume');
    if (pauseRequested && resumeRequested) throw new Error('Choose either --pause or --resume');
    if (pauseRequested) {
      await withTimeout(Promise.all(queues.map((queue) => queue.pause())), 'pause');
    }
    if (resumeRequested) {
      await withTimeout(Promise.all(queues.map((queue) => queue.resume())), 'resume');
    }

    const queueReports = await withTimeout(
      Promise.all(
        queues.map(async (queue, index) => ({
          queue: queueNames[index],
          counts: await queue.getJobCounts(...JOB_STATES),
        })),
      ),
      'counts',
    );
    const queuePauseStates = await withTimeout(
      Promise.all(queues.map((queue) => queue.isPaused())),
      'pause-state check',
    );
    const active = queueReports.reduce((sum, report) => sum + (report.counts.active ?? 0), 0);
    const allPaused = queuePauseStates.every(Boolean);
    const clean = cutoverStateIsClean({ pauseRequested, resumeRequested, active, allPaused });
    const report = {
      queues: queueReports,
      active,
      paused: allPaused,
      clean,
    };
    const snapshotOnly = process.argv.includes('--snapshot');
    if (snapshotOnly) {
      process.stdout.write(JSON.stringify(report));
    } else {
      console.log('=== Redis/BullMQ cutover audit (aggregate only) ===');
      console.log(JSON.stringify(report, null, 2));
    }
    if (!clean) {
      if (!snapshotOnly) {
        console.error(
          pauseRequested
            ? 'NOT CLEAN — every queue must be paused and every active job must finish before cutover.'
            : resumeRequested
              ? 'NOT CLEAN — at least one BullMQ queue remained paused.'
              : 'NOT CLEAN — wait for every active worker job to finish before cutover.',
        );
      }
      process.exitCode = 1;
    } else if (!snapshotOnly) {
      console.log(
        resumeRequested
          ? 'CLEAN — BullMQ queues resumed.'
          : pauseRequested
            ? 'CLEAN — queues paused and no worker side effect is active.'
            : 'CLEAN — no worker side effect is active during the Redis snapshot.',
      );
    }
  } finally {
    await Promise.all(queues.map((queue) => withTimeout(queue.close(), 'close').catch(() => undefined)));
    connection.disconnect();
  }
}

if (require.main === module) {
  void main().catch(() => {
    console.error('Redis cutover audit failed; no job payload was printed.');
    process.exitCode = 1;
  });
}
