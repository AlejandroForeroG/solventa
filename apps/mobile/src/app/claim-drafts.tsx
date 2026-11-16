import { useLocalSearchParams } from 'expo-router';
import { DraftsScreen } from '@/features/claim-drafts/presentation/DraftsScreen';

export default function ClaimDraftsRoute() {
  const { policyId } = useLocalSearchParams<{ policyId?: string }>();
  return <DraftsScreen policyId={typeof policyId === 'string' ? policyId : undefined} />;
}
