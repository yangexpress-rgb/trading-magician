import type { Metadata } from 'next';
import { TabHost } from '@/components/tabs/tab-host';

export const metadata: Metadata = { title: { absolute: 'Trading Magician' } };

/**
 * The installed desktop app's window (N253, ADR 0089): a tab bar over frames
 * of the normal app. `?open=/path` opens or selects a tab for that page.
 */
export default async function TabsPage({
  searchParams,
}: {
  searchParams: Promise<{ open?: string | string[] }>;
}) {
  const { open } = await searchParams;
  return <TabHost open={typeof open === 'string' ? open : null} />;
}
