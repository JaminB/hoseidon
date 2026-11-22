import { healthSchema, type Health } from '@hoseidon/shared';

export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return healthSchema.parse(await res.json());
}
