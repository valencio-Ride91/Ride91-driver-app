// Daily earnings (fleet-wide) — thin wrapper over the shared EarningsGrid.
// Hub-managers see only their own hub's drivers (server-scoped); owners see the
// whole fleet here, or go hub-by-hub via the Hub detail page's Earnings tab.
import EarningsGrid from "../components/EarningsGrid";

export default function DailyEarnings() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Daily earnings</h1>
          <div className="sub">Enter each driver's earnings for the day. Earnings drive the 30% share, rewards and cash owed.</div>
        </div>
      </div>
      <EarningsGrid />
    </div>
  );
}
