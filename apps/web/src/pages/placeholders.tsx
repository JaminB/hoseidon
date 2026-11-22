import { Network } from 'lucide-react';
import { Page, PageHeader } from '../components/layout/app-shell';
import { Card } from '../components/ui/card';
import { EmptyState } from '../components/ui/misc';

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
