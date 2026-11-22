import { randomUUID } from 'expo-crypto';

import { AssistanceRequestFlow } from '../application/assistance-request-flow';
import { createAssistanceApi } from './assistance-api';

type Session = { execute<T>(operation: (token: string) => Promise<T>): Promise<T> };

export function createAssistanceRequests(baseUrl: string, session: Session): AssistanceRequestFlow {
  const api = createAssistanceApi(baseUrl, session);
  return new AssistanceRequestFlow({ api: { create: api.createRequest, list: api.listRequests }, newKey: randomUUID });
}
