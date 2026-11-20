import type { Deadline } from '../../application/ports/report';

export class TimerDeadline implements Deadline {
  async race<T>(work: Promise<T>, milliseconds: number): Promise<T | 'expired'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<'expired'>(resolve => { timer = setTimeout(() => resolve('expired'), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
}
