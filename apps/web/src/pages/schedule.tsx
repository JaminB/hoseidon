import type { Schedule } from '@hoseidon/shared';
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, List, Plus } from 'lucide-react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { Page, PageHeader } from '../components/layout/app-shell';
import { QuickAddBar } from '../components/schedule/quick-add-bar';
import { ScheduleList } from '../components/schedule/schedule-list';
import { ScheduleSheet, type SheetState } from '../components/schedule/schedule-sheet';
import { WeekView } from '../components/schedule/week-view';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { EmptyState, ErrorBanner, Skeleton } from '../components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { addDays, startOfDay } from '../lib/calendar';
import { useDevices, usePreview, useSchedules } from '../lib/queries';
import {
  blankDraft,
  draftFromSchedule,
  draftFromSlot,
  draftFromTemplate,
  TEMPLATES,
} from '../lib/schedule-draft';

const rangeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function useIsPhone() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(max-width: 767px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(max-width: 767px)').matches,
  );
}

export function SchedulePage() {
  const phone = useIsPhone();
  const span = phone ? 3 : 7;
  // A rolling window from today: the plan ahead matters more than the calendar week.
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const days = useMemo(
    () => Array.from({ length: span }, (_, i) => addDays(anchor, i)),
    [anchor, span],
  );
  const from = days[0]!;
  const to = useMemo(() => addDays(from, span), [from, span]);

  const schedules = useSchedules();
  const preview = usePreview(from, to);
  const { devices } = useDevices();
  const [sheet, setSheet] = useState<SheetState>(null);
  const [tab, setTab] = useState('week');

  const nameOf = useMemo(() => new Map(devices.map((d) => [d.id, d.name])), [devices]);
  const zoneNames = useCallback((id: string) => nameOf.get(id) ?? 'Unknown zone', [nameOf]);

  const openSchedule = (s: Schedule) =>
    setSheet({ mode: 'edit', schedule: s, draft: draftFromSchedule(s) });
  const openById = (id: number) => {
    const s = schedules.data?.find((x) => x.id === id);
    if (s) openSchedule(s);
  };

  const isEmpty = schedules.data?.length === 0;

  return (
    <Page wide>
      <PageHeader
        title="Schedule"
        description="Hoseidon owns your watering plan and runs it through LinkTap."
        actions={
          <Button
            variant="primary"
            onClick={() => setSheet({ mode: 'create', draft: blankDraft() })}
          >
            <Plus className="size-4" /> New schedule
          </Button>
        }
      />

      <div className="mb-4">
        <QuickAddBar onEdit={(draft) => setSheet({ mode: 'create', draft })} />
      </div>

      <div className="scrollbar-none -mx-4 mb-6 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSheet({ mode: 'create', draft: draftFromTemplate(t) })}
            className="bg-surface border-line hover:border-line-strong group flex shrink-0 items-center gap-2.5 rounded-lg border py-2 pr-3.5 pl-2.5 text-left shadow-xs transition-colors"
          >
            <span className="size-2 rounded-full" style={{ background: t.draft.color }} />
            <span>
              <span className="block text-[13px] font-medium">{t.name}</span>
              <span className="text-subtle block text-xs">{t.blurb}</span>
            </span>
          </button>
        ))}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="week">
              <CalendarDays className="size-3.5" /> Week
            </TabsTrigger>
            <TabsTrigger value="list">
              <List className="size-3.5" /> List
              {schedules.data && <span className="text-subtle tnum">{schedules.data.length}</span>}
            </TabsTrigger>
          </TabsList>
          {tab === 'week' && (
            <WeekNav
              label={`${rangeFmt.format(from)} – ${rangeFmt.format(addDays(to, -1))}`}
              onPrev={() => setAnchor(addDays(anchor, -span))}
              onNext={() => setAnchor(addDays(anchor, span))}
              onToday={() => setAnchor(startOfDay(new Date()))}
            />
          )}
        </div>

        {schedules.isError && (
          <ErrorBanner title="Couldn't load schedules" error={schedules.error} />
        )}
        {preview.isError && !schedules.isError && (
          <ErrorBanner title="Couldn't load the week" error={preview.error} />
        )}

        <TabsContent value="week" className="outline-none">
          <WeekView
            days={days}
            occurrences={preview.data ?? []}
            zoneNames={zoneNames}
            onCreate={(day, s, e) => setSheet({ mode: 'create', draft: draftFromSlot(day, s, e) })}
            onOpen={openById}
          />
          <p className="text-subtle mt-2.5 text-xs">
            {phone ? 'Tap' : 'Drag across'} an empty slot to add a block. A red outline means two
            schedules share a gateway at the same time.
          </p>
        </TabsContent>

        <TabsContent value="list" className="outline-none">
          {schedules.isError ? null : schedules.isPending ? (
            <Card className="space-y-4 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </Card>
          ) : isEmpty ? (
            <Card>
              <EmptyState
                icon={CalendarPlus}
                title="No schedules yet"
                description="Type one in plain English above, start from a template, or drag on the week view."
              />
            </Card>
          ) : (
            <ScheduleList
              schedules={schedules.data ?? []}
              zoneNames={zoneNames}
              onOpen={openSchedule}
            />
          )}
        </TabsContent>
      </Tabs>

      <ScheduleSheet state={sheet} onClose={() => setSheet(null)} />
    </Page>
  );
}

function WeekNav({
  label,
  onPrev,
  onNext,
  onToday,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="tnum mr-1.5 text-sm font-medium">{label}</span>
      <Button size="sm" variant="secondary" onClick={onToday}>
        Today
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onPrev} aria-label="Previous">
        <ChevronLeft className="size-4" />
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onNext} aria-label="Next">
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
