import type { AlarmFlag, DismissableAlarm, WorkMode } from '@hoseidon/shared';
import { dismissableAlarmSchema } from '@hoseidon/shared';

export const WORK_MODE_LABEL: Record<WorkMode, string> = {
  M: 'Instant',
  I: 'Interval plan',
  T: '7-day plan',
  O: 'Odd/even plan',
  D: 'Calendar plan',
  Y: 'Month plan',
  N: 'No mode',
};

/** A LinkTap-app plan is active, so the timer may water on its own on top of Hoseidon. */
export function isLinkTapPlan(mode: WorkMode | null): boolean {
  return mode !== null && mode !== 'M' && mode !== 'N';
}

export const ALARM_LABEL: Record<AlarmFlag, string> = {
  noWater: 'No water',
  valveBroken: 'Valve broken',
  fallFlag: 'Fell over',
  leakFlag: 'Leak',
  clogFlag: 'Clogged',
  pcFlag: 'Water cut off',
  pbFlag: 'Burst pipe',
  freezeFlag: 'Freeze',
};

export function isDismissable(alarm: AlarmFlag): alarm is DismissableAlarm {
  return dismissableAlarmSchema.safeParse(alarm).success;
}
