import { useLocalSearchParams } from 'expo-router';

import { ClaimReportScreen } from '@/features/claim-report/presentation/ClaimReportScreen';

// The policy id is optional: without it the screen asks which policy the report is about.
export default function ClaimReportRoute() {
  const { policyId } = useLocalSearchParams<{ policyId?: string }>();
  return <ClaimReportScreen policyId={typeof policyId === 'string' ? policyId : undefined} />;
}
