import { PolicyCacheFailure } from '../../policy-cache/domain/cached-policy';
import { DraftFailure } from '../domain/draft';

// Both protected stores share the device prompt, but keep their own failure contracts.
export function draftDeviceFailure(error: unknown): unknown {
  return error instanceof PolicyCacheFailure && error.kind === 'locked' ? new DraftFailure('locked') : error;
}
