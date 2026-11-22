import type { WeatherDay } from '@hoseidon/shared';
import { WEATHER_ATTRIBUTION } from '@hoseidon/shared';
import { CloudRain, CloudSun, MapPin, Sun, Wind } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { addDays, startOfDay } from '../lib/calendar';
import { formatDepth, formatTemp, localDate, parseDate } from '../lib/analytics';
import { cn } from '../lib/cn';
import { useGateways, useWeather } from '../lib/queries';
import { Card } from './ui/card';
import { Skeleton } from './ui/misc';

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const DAYS = 6;

function Icon({ day }: { day: WeatherDay }) {
  const wet = (day.rainMm ?? 0) >= 1 || (day.rainProbPct ?? 0) >= 60;
  const Cmp = wet ? CloudRain : (day.rainMm ?? 0) > 0.1 ? CloudSun : Sun;
  return (
    <Cmp
      className={cn('size-5', wet ? 'text-rain' : 'text-et0')}
      aria-label={wet ? 'Rain' : 'Dry'}
    />
  );
}

/** Today plus the next few days for the first gateway that has a location. */
export function WeatherStrip({ now }: { now: number }) {
  const gateways = useGateways();
  const gateway = gateways.data?.find((g) => g.lat !== null && g.lon !== null);
  const today = useMemo(() => startOfDay(new Date(now)), [now]);
  const from = localDate(today);
  const to = localDate(addDays(today, DAYS - 1));
  const weather = useWeather(gateway?.id, from, to);

  if (gateways.isPending) return <Skeleton className="mb-6 h-[104px] rounded-xl" />;
  if (!gateway) {
    return (
      <Card className="mb-6 flex items-center gap-3 px-5 py-4">
        <MapPin className="text-subtle size-4 shrink-0" />
        <p className="text-muted text-[13px]">
          Add a location to a gateway to see the forecast here and let schedules skip for rain.{' '}
          <Link to="/devices" className="text-accent-strong font-medium hover:underline">
            Set location
          </Link>
        </p>
      </Card>
    );
  }
  const days = weather.data?.days ?? [];
  if (weather.isError || (weather.data && days.length === 0)) return null;

  return (
    <Card className="mb-6 px-3 py-3 md:px-4">
      <ol className="grid grid-cols-6 gap-1">
        {weather.isPending
          ? Array.from({ length: DAYS }, (_, i) => <Skeleton key={i} className="h-[72px]" />)
          : days.map((d) => {
              const isToday = d.date === from;
              return (
                <li
                  key={d.date}
                  className={cn(
                    'flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-2',
                    isToday && 'bg-accent-soft',
                  )}
                >
                  <span className="text-muted text-xs font-medium">
                    {isToday ? 'Today' : weekday.format(parseDate(d.date))}
                  </span>
                  <Icon day={d} />
                  <span className="tnum text-[13px] font-medium">
                    {formatTemp(d.tMaxC)}
                    <span className="text-subtle font-normal"> {formatTemp(d.tMinC)}</span>
                  </span>
                  <span
                    className={cn(
                      'tnum inline-flex items-center gap-0.5 text-[11px]',
                      (d.rainMm ?? 0) >= 0.1 ? 'text-rain' : 'text-subtle',
                    )}
                  >
                    {(d.rainMm ?? 0) >= 0.1 ? (
                      formatDepth(d.rainMm ?? 0)
                    ) : (
                      <>
                        <Wind className="size-3" />
                        {Math.round(d.windMaxKph ?? 0)}
                      </>
                    )}
                  </span>
                </li>
              );
            })}
      </ol>
      <p className="text-subtle mt-2 px-1 text-right text-[11px]">
        {gateway.name} ·{' '}
        <a
          href="https://open-meteo.com/"
          target="_blank"
          rel="noreferrer"
          className="hover:text-muted whitespace-nowrap underline-offset-2 hover:underline"
        >
          {WEATHER_ATTRIBUTION}
        </a>
      </p>
    </Card>
  );
}
