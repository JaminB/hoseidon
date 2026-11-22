import type { Device } from '@hoseidon/shared';
import { useState } from 'react';
import { formatRelative } from '../../lib/format';
import { WORK_MODE_LABEL } from '../../lib/linktap';
import { usePatchDevice } from '../../lib/queries';
import { Button } from '../ui/button';
import { Field, Input } from '../ui/misc';
import { Sheet } from '../ui/sheet';

/** Rename a timer and assign it to a zone. */
export function DeviceSheet({ device, onClose }: { device: Device | null; onClose: () => void }) {
  return (
    <Sheet
      open={device !== null}
      onOpenChange={(o) => !o && onClose()}
      title={device?.name ?? 'Timer'}
      description="Give the timer a name you'll recognize and group it into a zone."
    >
      {/* Keyed so the form resets when a different device opens. */}
      {device && <DeviceForm key={device.id} device={device} onDone={onClose} />}
    </Sheet>
  );
}

function DeviceForm({ device, onDone }: { device: Device; onDone: () => void }) {
  const [name, setName] = useState(device.name === device.linktapName ? '' : device.name);
  const [zone, setZone] = useState(device.zone ?? '');
  const patch = usePatchDevice();

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    patch.mutate({
      id: device.id,
      patch: { name: name.trim() || null, zone: zone.trim() || null },
    });
    onDone();
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <Field
        label="Name"
        htmlFor="dev-name"
        hint={`LinkTap calls it “${device.linktapName}”. Leave blank to use that.`}
      >
        <Input
          id="dev-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={device.linktapName}
          maxLength={80}
          autoComplete="off"
        />
      </Field>
      <Field label="Zone" htmlFor="dev-zone" hint="e.g. Front yard, Garden, Pots">
        <Input
          id="dev-zone"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          placeholder="No zone"
          maxLength={80}
          autoComplete="off"
        />
      </Field>

      <dl className="border-line bg-surface-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border px-4 py-3 text-[13px]">
        <dt className="text-muted">Device ID</dt>
        <dd className="truncate text-right font-mono text-xs leading-5">{device.id}</dd>
        <dt className="text-muted">Mode</dt>
        <dd className="text-right">{device.workMode ? WORK_MODE_LABEL[device.workMode] : '—'}</dd>
        <dt className="text-muted">Last seen</dt>
        <dd className="text-right">
          {device.lastSeenAt ? formatRelative(device.lastSeenAt) : '—'}
        </dd>
      </dl>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}
