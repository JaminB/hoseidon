import { ChartColumn, Network } from 'lucide-react';
import { Page, PageHeader } from '../components/layout/app-shell';
import { Card } from '../components/ui/card';
import { EmptyState } from '../components/ui/misc';

export function AnalyticsPage() {
  return (
    <Page>
      <PageHeader
        title="Analytics"
        description="Per-zone water use against rain and evapotranspiration."
      />
      <Card>
        <EmptyState
          icon={ChartColumn}
          title="Analytics are on their way"
          description="Water used vs. rainfall and ET₀, run history, flow rate, a calendar heatmap and how much water the skips saved. Hoseidon is already collecting the history."
        />
      </Card>
    </Page>
  );
}

export function NetworkPage() {
  return (
    <Page>
      <PageHeader
        title="Network"
        description="Gateway uptime, timer signal and battery over time."
      />
      <Card>
        <EmptyState
          icon={Network}
          title="Network health is coming"
          description="Uptime timelines, signal sparklines, battery drain trends, an offline incident log and a Diagnose panel. Until then, Devices shows the live signal and battery."
        />
      </Card>
    </Page>
  );
}
