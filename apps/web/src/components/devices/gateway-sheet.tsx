import type { Gateway } from '@hoseidon/shared';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, LocateFixed, MapPin, Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import { geocode, type GeocodeResult } from '../../lib/api';
import { cn } from '../../lib/cn';
import { usePatchGateway } from '../../lib/queries';
import { Button } from '../ui/button';
import { inputClass } from '../ui/misc';
import { Sheet } from '../ui/sheet';
import { toast } from '../ui/toast';

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * LinkTap doesn't know where a gateway is, so the user sets it once: browser geolocation or a
 * ZIP/city search (Open-Meteo geocoding). Weather skips and analytics use it.
 */
export function GatewaySheet({
  gateway,
  onClose,
}: {
  gateway: Gateway | null;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={gateway !== null}
      onOpenChange={(o) => !o && onClose()}
      title={gateway?.name ?? 'Gateway'}
      description="LinkTap doesn't know where your gateway is. Set it once for rain, freeze and wind skips."
    >
      {gateway && (
        <div className="space-y-7">
          <NameForm key={`n-${gateway.id}`} gateway={gateway} />
          <LocationForm key={gateway.id} gateway={gateway} onDone={onClose} />
        </div>
      )}
    </Sheet>
  );
}

function NameForm({ gateway }: { gateway: Gateway }) {
  const [name, setName] = useState(gateway.name === gateway.linktapName ? '' : gateway.name);
  const patch = usePatchGateway();
  const current = gateway.name === gateway.linktapName ? '' : gateway.name;
  const dirty = name.trim() !== current;
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) patch.mutate({ id: gateway.id, patch: { name: name.trim() || null } });
      }}
    >
      <label htmlFor="gw-name" className="block text-[13px] font-medium">
        Name
      </label>
      <div className="flex gap-2">
        <input
          id="gw-name"
          className={inputClass}
          value={name}
          placeholder={gateway.linktapName}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoComplete="off"
        />
        <Button type="submit" variant="secondary" disabled={!dirty}>
          Rename
        </Button>
      </div>
    </form>
  );
}

function LocationForm({ gateway, onDone }: { gateway: Gateway; onDone: () => void }) {
  const [query, setQuery] = useState('');
  const [locating, setLocating] = useState(false);
  const deferred = useDeferredValue(query.trim());
  const patch = usePatchGateway();

  const results = useQuery({
    queryKey: ['geocode', deferred],
    queryFn: ({ signal }) => geocode(deferred, signal),
    enabled: deferred.length >= 3,
    staleTime: Infinity,
  });

  const save = (lat: number, lon: number, timezone: string, label: string) => {
    patch.mutate(
      { id: gateway.id, patch: { lat: round(lat), lon: round(lon), timezone } },
      { onSuccess: () => toast.success(`${gateway.name} is in ${label}`) },
    );
    onDone();
  };

  const locate = () => {
    if (!('geolocation' in navigator)) return toast.error('This browser has no location access');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        save(pos.coords.latitude, pos.coords.longitude, browserZone(), 'your current location');
      },
      (err) => {
        setLocating(false);
        toast.error("Couldn't get your location", err.message);
      },
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  };

  return (
    <div className="space-y-4">
      <div className="text-[13px] font-medium">Location</div>
      {gateway.lat !== null && gateway.lon !== null && (
        <div className="border-line bg-surface-2 flex items-center gap-3 rounded-lg border px-3.5 py-3">
          <MapPin className="text-accent-strong size-4 shrink-0" />
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="tnum font-medium">
              {gateway.lat.toFixed(3)}, {gateway.lon.toFixed(3)}
            </div>
            <div className="text-muted">{gateway.timezone ?? 'No time zone'}</div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              patch.mutate({ id: gateway.id, patch: { lat: null, lon: null } });
              onDone();
            }}
          >
            Clear
          </Button>
        </div>
      )}

      <Button variant="secondary" className="w-full" onClick={locate} loading={locating}>
        {!locating && <LocateFixed className="size-4" />}
        Use my current location
      </Button>

      <div className="text-subtle flex items-center gap-3 text-xs">
        <span className="bg-line h-px flex-1" /> or search <span className="bg-line h-px flex-1" />
      </div>

      <div>
        <div className="relative">
          <Search className="text-subtle pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <input
            className={cn(inputClass, 'pl-9')}
            placeholder="ZIP code or city"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="ZIP code or city"
          />
          {results.isFetching && (
            <LoaderCircle className="text-subtle absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin" />
          )}
        </div>
        <ul className="mt-2 space-y-0.5">
          {results.data?.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => save(r.latitude, r.longitude, r.timezone ?? browserZone(), r.name)}
                className="hover:bg-surface-2 flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors"
              >
                <MapPin className="text-subtle size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{r.name}</span>
                  <span className="text-muted block truncate text-xs">{placeLine(r)}</span>
                </span>
              </button>
            </li>
          ))}
          {results.data?.length === 0 && (
            <li className="text-muted px-2.5 py-3 text-sm">No places match “{deferred}”.</li>
          )}
          {results.isError && (
            <li className="text-danger px-2.5 py-3 text-sm">Search is unavailable right now.</li>
          )}
        </ul>
        <p className="text-subtle mt-3 text-[11px]">
          Geocoding by{' '}
          <a
            className="underline underline-offset-2"
            href="https://open-meteo.com/"
            target="_blank"
            rel="noreferrer"
          >
            Open-Meteo
          </a>{' '}
          (CC BY 4.0).
        </p>
      </div>
    </div>
  );
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

function placeLine(r: GeocodeResult) {
  return [r.admin1, r.country, r.postcodes?.[0]].filter(Boolean).join(' · ');
}
