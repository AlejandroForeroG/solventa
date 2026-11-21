// The short permission of the person acting for a customer ended before a write could commit: nothing was written.
export class LeaseExpired extends Error {
  constructor() { super('lease_expired'); this.name = 'LeaseExpired'; }
}
