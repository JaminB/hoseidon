import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CommandResult,
  Device,
  DismissableAlarm,
  GatewayWithDevices,
  GcalStatus,
  Schedule,
  ScheduleInput,
  SchedulePatch,
} from '@hoseidon/shared';
import { api } from './api';
import { formatDuration } from './format';
import { toast } from '../components/ui/toast';

export const keys = {
  health: ['health'] as const,
  gateways: ['gateways'] as const,
  schedules: ['schedules'] as const,
  preview: (from: Date, to: Date) => ['preview', from.toISOString(), to.toISOString()] as const,
  plannedRuns: (from: Date, to: Date) =>
    ['planned-runs', from.toISOString(), to.toISOString()] as const,
  weather: (gatewayId: string, from: string, to: string) =>
    ['weather', gatewayId, from, to] as const,
  analytics: (target: string, from: string, to: string) => ['analytics', target, from, to] as const,
  events: ['events'] as const,
  network: (days: number) => ['network', days] as const,
  linktapStatus: ['linktap-status'] as const,
  gcal: ['gcal'] as const,
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---- reads --------------------------------------------------------------------------------------

export const useHealth = () => useQuery({ queryKey: keys.health, queryFn: api.health });

/** Gateways with nested devices. Polls faster while something is watering. */
export function useGateways() {
  return useQuery({
    queryKey: keys.gateways,
    queryFn: api.gateways,
    refetchInterval: (q) =>
      q.state.data?.some((g) => g.devices.some((d) => d.watering)) ? 10_000 : 60_000,
  });
}

export function useDevices(): { devices: Device[]; isPending: boolean } {
  const { data, isPending } = useGateways();
  return { devices: data?.flatMap((g) => g.devices) ?? [], isPending };
}

export const useSchedules = () => useQuery({ queryKey: keys.schedules, queryFn: api.schedules });

export const usePreview = (from: Date, to: Date) =>
  useQuery({
    queryKey: keys.preview(from, to),
    queryFn: () => api.preview(from, to),
    placeholderData: (prev) => prev,
  });

export const usePlannedRuns = (from: Date, to: Date) =>
  useQuery({
    queryKey: keys.plannedRuns(from, to),
    queryFn: () => api.plannedRuns(from, to),
    refetchInterval: 30_000,
  });

export const useEvents = () =>
  useQuery({ queryKey: keys.events, queryFn: () => api.events(20), refetchInterval: 60_000 });

export const useLinkTapStatus = () =>
  useQuery({ queryKey: keys.linktapStatus, queryFn: api.linktapStatus, refetchInterval: 15_000 });

/** Network health for the last `days` days. Derived from polls, so a minute is plenty fresh. */
export const useNetwork = (days: number) =>
  useQuery({
    queryKey: keys.network(days),
    queryFn: () => api.networkOverview(days),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

/** Google Calendar connection + sync state. Polls faster while a sync is queued or running. */
export const useGcalStatus = () =>
  useQuery({
    queryKey: keys.gcal,
    queryFn: api.gcalStatus,
    refetchInterval: (q) =>
      ['pending', 'running'].includes(q.state.data?.sync.state ?? '') ? 3_000 : 60_000,
  });

/** Google Calendar writes run one at a time, so the last toggle the user made is what's saved. */
const gcalScope = { id: 'gcal' };

function useGcalMutation<T>(fn: (arg: T) => Promise<GcalStatus>, failure: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    scope: gcalScope,
    onSuccess: (status) => qc.setQueryData(keys.gcal, status),
    onError: (err) => toast.error(failure, errorMessage(err)),
  });
}

export const useGcalDisconnect = () =>
  useGcalMutation(() => api.gcalDisconnect(), 'Could not disconnect');
export const useGcalResync = () => useGcalMutation(() => api.gcalResync(), 'Resync failed');
export const useGcalLogRuns = () =>
  useGcalMutation((on: boolean) => api.gcalSettings(on), 'Could not save');

/** Runs the troubleshooting checklist for one timer. */
export const useDiagnose = () =>
  useMutation({
    mutationFn: (deviceId: string) => api.diagnose(deviceId),
    onError: (err) => toast.error('Diagnosis failed', errorMessage(err)),
  });

/** The weak-signal threshold. Changing it re-derives everything on the Network page. */
export function useSetWeakSignal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pct: number) => api.patchNetworkSettings(pct),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['network'] }),
    onError: (err) => toast.error('Could not save', errorMessage(err)),
  });
}

// ---- device commands (optimistic) ---------------------------------------------------------------

const mapDevice = (qc: QueryClient, id: string, fn: (d: Device) => Device) =>
  qc.setQueryData<GatewayWithDevices[]>(keys.gateways, (gws) =>
    gws?.map((g) => ({ ...g, devices: g.devices.map((d) => (d.id === id ? fn(d) : d)) })),
  );

/**
 * Applies `fn` to one device inside the cached gateway tree. The rollback restores only that
 * device, so other in-flight optimistic changes survive.
 */
function patchDeviceCache(qc: QueryClient, id: string, fn: (d: Device) => Device) {
  const prev = qc
    .getQueryData<GatewayWithDevices[]>(keys.gateways)
    ?.flatMap((g) => g.devices)
    .find((d) => d.id === id);
  mapDevice(qc, id, fn);
  return () => {
    if (prev) mapDevice(qc, id, () => prev);
  };
}

/** Same idea for the schedule list: restore just the one schedule (re-adding it if removed). */
function scheduleRollback(qc: QueryClient, id: number) {
  const prev = qc.getQueryData<Schedule[]>(keys.schedules)?.find((s) => s.id === id);
  return () =>
    qc.setQueryData<Schedule[]>(keys.schedules, (list) => {
      if (!list || !prev) return list;
      return list.some((s) => s.id === id)
        ? list.map((s) => (s.id === id ? prev : s))
        : [...list, prev].sort((a, b) => a.name.localeCompare(b.name));
    });
}

/** Schedule writes run one after another, so two quick edits can't land out of order. */
const scheduleScope = { id: 'schedules' };

function afterCommand(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: keys.gateways });
  void qc.invalidateQueries({ queryKey: ['planned-runs'] });
  void qc.invalidateQueries({ queryKey: keys.linktapStatus });
}

/** "Next command in 12 s" when LinkTap's 15 s command spacing is still running. */
function cooldownNote(res: CommandResult): string | undefined {
  const wait = Math.ceil((Date.parse(res.nextCommandAt) - Date.now()) / 1000);
  return wait > 1 ? `LinkTap accepts the next command in ${wait} s.` : undefined;
}

export function useRunDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ device, seconds }: { device: Device; seconds: number }) =>
      api.run(device.id, seconds),
    onMutate: async ({ device, seconds }) => {
      await qc.cancelQueries({ queryKey: keys.gateways });
      const rollback = patchDeviceCache(qc, device.id, (d) => ({
        ...d,
        watering: { remainingSec: seconds, totalSec: seconds, flowMlPerMin: null, volumeMl: null },
      }));
      return { rollback };
    },
    onSuccess: (res, { device, seconds }) =>
      toast.success(
        `${device.name} is watering`,
        `${formatDuration(seconds)} · ${cooldownNote(res) ?? 'Started just now.'}`,
      ),
    onError: (err, { device }, ctx) => {
      ctx?.rollback();
      toast.error(`Couldn't start ${device.name}`, errorMessage(err));
    },
    onSettled: () => afterCommand(qc),
  });
}

export function useStopDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (device: Device) => api.stop(device.id),
    onMutate: async (device) => {
      await qc.cancelQueries({ queryKey: keys.gateways });
      return { rollback: patchDeviceCache(qc, device.id, (d) => ({ ...d, watering: null })) };
    },
    onSuccess: (_res, device) => toast(`${device.name} stopped`),
    onError: (err, device, ctx) => {
      ctx?.rollback();
      toast.error(`Couldn't stop ${device.name}`, errorMessage(err));
    },
    onSettled: () => afterCommand(qc),
  });
}

export function useDismissAlarm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ device, alarm }: { device: Device; alarm: DismissableAlarm }) =>
      api.dismissAlarm(device.id, alarm),
    onMutate: async ({ device, alarm }) => {
      await qc.cancelQueries({ queryKey: keys.gateways });
      const rollback = patchDeviceCache(qc, device.id, (d) => ({
        ...d,
        alarms: d.alarms.filter((a) => a !== alarm),
      }));
      return { rollback };
    },
    onError: (err, { device }, ctx) => {
      ctx?.rollback();
      toast.error(`Couldn't clear the alarm on ${device.name}`, errorMessage(err));
    },
    onSettled: () => afterCommand(qc),
  });
}

export function usePatchDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { name?: string | null; zone?: string | null };
    }) => api.patchDevice(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.gateways });
      const rollback = patchDeviceCache(qc, id, (d) => ({
        ...d,
        ...(patch.name !== undefined ? { name: patch.name ?? d.linktapName } : {}),
        ...(patch.zone !== undefined ? { zone: patch.zone } : {}),
      }));
      return { rollback };
    },
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      toast.error("Couldn't save the timer", errorMessage(err));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: keys.gateways });
      void qc.invalidateQueries({ queryKey: keys.schedules });
    },
  });
}

export function usePatchGateway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.patchGateway>[1] }) =>
      api.patchGateway(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.gateways });
      const prev = qc.getQueryData<GatewayWithDevices[]>(keys.gateways)?.find((g) => g.id === id);
      qc.setQueryData<GatewayWithDevices[]>(keys.gateways, (gws) =>
        gws?.map((g) =>
          g.id === id
            ? {
                ...g,
                ...patch,
                name: patch.name === undefined ? g.name : (patch.name ?? g.linktapName),
              }
            : g,
        ),
      );
      const rollback = () =>
        qc.setQueryData<GatewayWithDevices[]>(keys.gateways, (gws) =>
          gws?.map((g) => (g.id === id && prev ? { ...prev, devices: g.devices } : g)),
        );
      return { rollback };
    },
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      toast.error("Couldn't save the gateway", errorMessage(err));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: keys.gateways }),
  });
}

// ---- schedules ----------------------------------------------------------------------------------

function afterScheduleChange(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: keys.schedules });
  void qc.invalidateQueries({ queryKey: ['preview'] });
  void qc.invalidateQueries({ queryKey: ['planned-runs'] });
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleInput) => api.createSchedule(input),
    scope: scheduleScope,
    onSuccess: (s) =>
      toast.success(`Scheduled “${s.name}”`, s.nextAt ? undefined : 'No upcoming runs.'),
    onError: (err) => toast.error("Couldn't create the schedule", errorMessage(err)),
    onSettled: () => afterScheduleChange(qc),
  });
}

export function usePatchSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: SchedulePatch }) =>
      api.patchSchedule(id, patch),
    scope: scheduleScope,
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.schedules });
      const rollback = scheduleRollback(qc, id);
      qc.setQueryData<Schedule[]>(keys.schedules, (list) =>
        list?.map((s) => (s.id === id ? ({ ...s, ...patch } as Schedule) : s)),
      );
      return { rollback };
    },
    onError: (err, _v, ctx) => {
      ctx?.rollback();
      toast.error("Couldn't save the schedule", errorMessage(err));
    },
    onSettled: () => afterScheduleChange(qc),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: Schedule) => api.deleteSchedule(s.id),
    scope: scheduleScope,
    onMutate: async (s) => {
      await qc.cancelQueries({ queryKey: keys.schedules });
      const rollback = scheduleRollback(qc, s.id);
      qc.setQueryData<Schedule[]>(keys.schedules, (list) => list?.filter((x) => x.id !== s.id));
      return { rollback };
    },
    onSuccess: (_r, s) => toast(`Deleted “${s.name}”`),
    onError: (err, _s, ctx) => {
      ctx?.rollback();
      toast.error("Couldn't delete the schedule", errorMessage(err));
    },
    onSettled: () => afterScheduleChange(qc),
  });
}

export function useSkipPlannedRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.skipPlannedRun(id),
    onSuccess: () => toast('Skipped this run'),
    onError: (err) => toast.error("Couldn't skip", errorMessage(err)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['planned-runs'] }),
  });
}

// ---- weather + analytics -------------------------------------------------------------------------

/** Daily weather for a gateway. The server caches it, so this is cheap to keep fresh. */
export const useWeather = (gatewayId: string | undefined, from: string, to: string) =>
  useQuery({
    queryKey: keys.weather(gatewayId ?? '', from, to),
    queryFn: () => api.weather(gatewayId!, from, to),
    enabled: !!gatewayId,
    staleTime: 15 * 60_000,
    placeholderData: (prev) => prev,
  });

/** Usage analytics for one device, or every device when `target` is "all". */
export const useAnalytics = (target: string, from: string, to: string) =>
  useQuery({
    queryKey: keys.analytics(target, from, to),
    queryFn: () =>
      target === 'all' ? api.analyticsSummary(from, to) : api.deviceAnalytics(target, from, to),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
