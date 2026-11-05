# Feeds, brokers and reconciliation

The worker protects strategies on its own (ADR 0014): stale prices for 60 s, a broker silent for
60 s or 3 rejected orders in a row pause the affected strategies, open an incident and notify the
person. Reconciliation runs every minute and pauses strategies when the app's orders or positions
disagree with the broker's.

- **Many people's prices stop at once.** The provider is down or refusing the app's keys. Check
  the provider's status page and the worker logs for the feed check's error. Feeds with a
  fallback switch over and return after 5 minutes healthy (ADR 0016). Nothing else to do; data
  incidents resolve themselves when prices return.
- **A broker stops answering.** Check the broker's status page (Alpaca paper). Strategies on that
  account pause; open orders stay with the broker. When it answers again, reconciliation brings
  the app's records up to date. People resume strategies themselves.
- **Reconciliation mismatch.** The person sees a banner on Orders. Compare the app's order
  timeline with the broker's own records. If the broker is right, the app has already applied
  its state (`source: reconciliation`); the person resolves the incident with a note. If the app
  shows something the broker never had, keep the strategy paused and look at the audit log for
  that order before resolving.
- **Simulated DEMO prices** come from inside the worker; if they stop, the worker is stuck
  ([stuck-worker.md](stuck-worker.md)).
