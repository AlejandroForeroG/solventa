import { randomUUID } from 'expo-crypto';
import { IdentityVerification } from '../application/identity-verification';
import type { AuthenticatedSession } from '../application/ports';
import type { Locale } from '../domain/verification';
import { createVerificationApi } from './verification-api';

export function createIdentityVerification(baseUrl: string, session: AuthenticatedSession, locale: Locale) {
  return new IdentityVerification(createVerificationApi(baseUrl, session), locale, randomUUID);
}
