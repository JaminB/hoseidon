import { useState } from 'react';
import { Segmented } from '../ui/tabs';
import { Button } from '../ui/button';
import { Card, CardHeader } from '../ui/card';
import { Input } from '../ui/misc';
import { useAppSettings, useSetTimeZone } from '../../lib/queries';
import { useUnits, type UnitSystem } from '../../lib/units';
import { Row } from './row';

const zones = (): string[] => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
};

/** Settings > Units and time zone. Units live in this browser; the time zone is the server's. */
export function PreferencesCard() {
  const [units, setUnits] = useUnits();
  const settings = useAppSettings();
  const save = useSetTimeZone();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? settings.data?.timeZone ?? '';
  const changed = !!settings.data && value !== settings.data.timeZone;
  const needsRestart =
    !!settings.data && !changed && settings.data.timeZone !== settings.data.activeTimeZone;

  return (
    <Card>
      <CardHeader
        title="Units and time"
        description="How amounts are shown, and the server’s clock."
      />
      <dl className="divide-line border-line divide-y border-t">
        <Row label="Units" hint="Water, rain and temperature. Saved in this browser.">
          <Segmented<UnitSystem>
            label="Units"
            value={units}
            onChange={setUnits}
            options={[
              { value: 'metric', label: 'Metric' },
              { value: 'imperial', label: 'Imperial' },
            ]}
          />
        </Row>
        <div className="space-y-2 px-5 py-3 text-sm">
          <label htmlFor="tz" className="block">
            Server time zone
          </label>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (changed) save.mutate(value, { onSuccess: () => setDraft(null) });
            }}
          >
            <Input
              id="tz"
              list="tz-list"
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="America/New_York"
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id="tz-list">
              {zones().map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <Button type="submit" disabled={!changed} loading={save.isPending}>
              Save
            </Button>
          </form>
          <p className="text-subtle text-xs">
            {needsRestart
              ? `Saved. Restart Hoseidon to switch from ${settings.data?.activeTimeZone}.`
              : 'Used for schedules and daily totals when a gateway has no location of its own.'}
          </p>
        </div>
      </dl>
    </Card>
  );
}
