import { date, rupees } from "../../lib/format";
import { useQuery } from "../../lib/query";
import { Card, ErrorState, PageHeader, Skeleton } from "../../ui/core";

interface Line { id: number; number: string; items_paise: number; shipping_paise: number; commission_paise: number; tcs_paise: number; net_paise: number; delivered_at: string }
interface Payouts {
  eligible_paise: number; holding_paise: number; in_transit_paise: number; paid_paise: number; return_window_days: number;
  eligible: Line[]; holding: Line[];
  history: { id: number; reference: string; gross_paise: number; commission_paise: number; tcs_paise: number; net_paise: number; fulfilment_count: number; created_at: string }[];
}

function Lines({ lines, empty }: { lines: Line[]; empty: string }) {
  if (!lines.length) return <p className="card__body muted">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Order</th><th>Delivered</th><th className="right">Sale</th><th className="right">Commission</th><th className="right">TCS</th><th className="right">Net</th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.id}><td className="pn strong">{l.number}</td><td>{date(l.delivered_at)}</td><td className="right">{rupees(l.items_paise + l.shipping_paise)}</td><td className="right">− {rupees(l.commission_paise)}</td><td className="right">− {rupees(l.tcs_paise)}</td><td className="right strong">{rupees(l.net_paise)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function PayoutsPage() {
  const q = useQuery<Payouts>("/api/seller/payouts");
  const d = q.data;
  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  return (
    <>
      <PageHeader title="Payouts" subtitle="Orders become payable once delivered and past the return window. Settlements go to your registered bank account." />
      {!d ? <Skeleton height={96} /> : (
        <div className="kpis" style={{ "--n": 4 }}>
          <div className="kpi"><span className="micro">Ready for payout</span><span className="kpi__value">{rupees(d.eligible_paise)}</span><span className="kpi__note">{d.eligible.length} orders</span></div>
          <div className="kpi"><span className="micro">In return window</span><span className="kpi__value">{rupees(d.holding_paise)}</span><span className="kpi__note">{d.return_window_days}-day window</span></div>
          <div className="kpi"><span className="micro">On the way to buyers</span><span className="kpi__value">{rupees(d.in_transit_paise)}</span><span className="kpi__note">Placed, packed or shipped</span></div>
          <div className="kpi"><span className="micro">Paid to date</span><span className="kpi__value">{rupees(d.paid_paise)}</span><span className="kpi__note">{d.history.length} settlements</span></div>
        </div>
      )}
      <div className="stack-lg" style={{ marginTop: 20 }}>
        <Card title="Ready for the next payout">{d ? <Lines lines={d.eligible} empty="Nothing is past the return window yet." /> : <Skeleton height={120} />}</Card>
        <Card title="Waiting out the return window">{d ? <Lines lines={d.holding} empty="No delivered orders are inside the return window." /> : <Skeleton height={120} />}</Card>
        <Card title="Settlements">
          {d && d.history.length === 0 && <p className="card__body muted">Your settlements will be listed here with their bank reference.</p>}
          {d && d.history.length > 0 && (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Reference</th><th>Date</th><th className="right">Orders</th><th className="right">Gross</th><th className="right">Commission</th><th className="right">TCS</th><th className="right">Paid</th></tr></thead>
              <tbody>{d.history.map((p) => <tr key={p.id}><td className="pn strong">{p.reference}</td><td>{date(p.created_at)}</td><td className="right">{p.fulfilment_count}</td><td className="right">{rupees(p.gross_paise)}</td><td className="right">− {rupees(p.commission_paise)}</td><td className="right">− {rupees(p.tcs_paise)}</td><td className="right strong">{rupees(p.net_paise)}</td></tr>)}</tbody>
            </table></div>
          )}
        </Card>
      </div>
    </>
  );
}
