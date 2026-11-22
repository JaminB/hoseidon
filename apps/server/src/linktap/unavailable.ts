import type { LinkTapClient } from './client';

/**
 * Stand-in client for a live deployment whose LinkTap credentials are not set yet. Nothing
 * reaches the network; every call fails. BrainCore answers 503 before any of it is used.
 */
export function noLinkTap(): LinkTapClient {
  const fail = () => Promise.reject(new Error('LinkTap credentials are not configured'));
  return {
    getAllDevices: fail,
    getWateringStatus: fail,
    getWateringHistory: fail,
    startWatering: fail,
    stopWatering: fail,
    pauseWateringPlan: fail,
    dismissAlarm: fail,
    setWebHookUrl: fail,
    nextAvailableAt: () => new Date(Number.MAX_SAFE_INTEGER),
    stats: () => ({}) as ReturnType<LinkTapClient['stats']>,
  };
}
