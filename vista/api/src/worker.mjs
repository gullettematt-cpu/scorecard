// Worker Lambda: incoming texts (handed off by the API so Twilio gets an instant answer) and the
// scheduled jobs from EventBridge Scheduler: { job: 'heartbeat' | 'morning' | 'pm-digest' | 'cutoff' | 'dispatch-poll' }.
import { createServices } from './lib/services.mjs';
import { realDeps } from './lib/deps.mjs';

export function createWorker(getDeps) {
  return async function worker(event) {
    const svc = createServices(await getDeps());
    switch (event.job) {
      case 'sms': return svc.handleText(event.msg);
      case 'heartbeat': return svc.heartbeat();
      case 'morning': return svc.morning();
      case 'pm-digest': return svc.pmDigest();
      case 'cutoff': return svc.cutoff();
      case 'dispatch-poll': return svc.dispatchPoll();
      default: throw new Error(`unknown job ${event.job}`);
    }
  };
}
export const handler = createWorker(realDeps);
