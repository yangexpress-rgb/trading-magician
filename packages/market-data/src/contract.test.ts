import { createDemoHistoryProvider } from './demo-history';
import { createDemoLiveFeed } from './demo-live';
import { describeHistoryContract, describeLiveQuoteContract } from './testing';

describeLiveQuoteContract('demo feed', async () => {
  let now = new Date();
  return {
    provider: createDemoLiveFeed({ now: () => now }),
    instrument: { instrumentId: 'a', symbol: 'DEMO-A' },
    setNow: (at) => (now = at),
  };
});

describeHistoryContract('demo history', async () => ({
  provider: createDemoHistoryProvider({ now: () => new Date('2026-10-05T00:00:00Z') }),
  instrument: { instrumentId: 'a', symbol: 'DEMO-A', assetClass: 'stock' },
}));
