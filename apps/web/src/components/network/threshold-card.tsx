import { useState } from 'react';
import { useSetWeakSignal } from '../../lib/queries';
import { Card, CardHeader } from '../ui/card';

export function ThresholdCard({ pct }: { pct: number }) {
  // While dragging we show the draft; once saved the server value takes over again.
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? pct;
  const save = useSetWeakSignal();
  const commit = () => {
    if (draft !== null && draft !== pct) save.mutate(draft, { onSettled: () => setDraft(null) });
    else setDraft(null);
  };

  return (
    <Card>
      <CardHeader
        title="Weak-signal threshold"
        description="Timers below this are flagged, and you get an event when one drops under it."
      />
      <div className="flex items-center gap-4 px-5 pb-5">
        <input
          type="range"
          min={10}
          max={90}
          step={5}
          value={value}
          onChange={(e) => setDraft(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="accent-accent h-2 flex-1"
          aria-label="Weak-signal threshold"
        />
        <span className="tnum w-12 text-right text-sm font-semibold">{value}%</span>
      </div>
    </Card>
  );
}
