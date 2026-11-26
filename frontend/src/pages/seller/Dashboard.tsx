import { LuArrowRight, LuPlus } from "react-icons/lu";
import { dateTime, rupees, rupeesShort } from "../../lib/format";
import { useQuery } from "../../lib/query";
import { Link } from "../../lib/router";
import { useAuth } from "../../state/app";
import { StatusBadge } from "../../ui/commerce";
import { DailyBars } from "../../ui/chart";
import { Button, Card, ErrorState, PageHeader, Skeleton } from "../../ui/core";

interface Dashboard {
  kpis: { sales_30d: number; orders_30d: number; to_ship: number; returns_open: number; active_listings: number; pending_listings: number; rejected_listings: number; low_stock: number };
  series: { day: string; sales_paise: number; orders: number }[];
  top_products: { product_id: number; title: string; part_number: string; units: number; revenue: number }[];
  queue: { id: number; status: string; status_label: string; items_paise: number; created_at: string; number: string; ship_city: string; units: number }[];
}

export function SellerDashboard() {
  const { user } = useAuth();
  const q = useQuery<Dashboard>("/api/seller/dashboard");
  const d = q.data;
  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={`${user?.seller?.display_name ?? "Your shop"} · last 30 days`}
        actions={<Button to="/seller/listings/new" variant="primary" icon={LuPlus}>New listing</Button>}
      />
      {!d ? <Skeleton height={96} /> : (
        <div className="kpis" style={{ "--n": 4 }}>
          <div className="kpi"><span className="micro">Sales · 30 days</span><span className="kpi__value">{rupeesShort(d.kpis.sales_30d)}</span><span className="kpi__note">{d.kpis.orders_30d} orders</span></div>
          <Link to="/seller/orders?status=to_ship" className={`kpi ${d.kpis.to_ship ? "kpi--alert" : ""}`}><span className="micro">To pack &amp; ship</span><span className="kpi__value">{d.kpis.to_ship}</span><span className="kpi__note">Ship within 2 days</span></Link>
          <Link to="/seller/orders?status=returns" className={`kpi ${d.kpis.returns_open ? "kpi--alert" : ""}`}><span className="micro">Return requests</span><span className="kpi__value">{d.kpis.returns_open}</span><span className="kpi__note">Respond within 48 h</span></Link>
          <Link to="/seller/listings" className="kpi"><span className="micro">Live listings</span><span className="kpi__value">{d.kpis.active_listings}</span><span className="kpi__note">{d.kpis.pending_listings} in review · {d.kpis.low_stock} low stock</span></Link>
        </div>
      )}
      <div className="grid-2" style={{ marginTop: 20 }}>
        <Card title="Sales, last 30 days">
          {d ? <DailyBars points={d.series.map((s) => ({ day: s.day, value: s.sales_paise }))} format={rupeesShort} label="Sales" /> : <div className="card__body"><Skeleton height={200} /></div>}
        </Card>
        <Card title="Needs your attention" actions={<Link to="/seller/orders" className="small">All orders</Link>}>
          {d && d.queue.length === 0 && <p className="card__body muted">You're all caught up — no orders waiting.</p>}
          <ul className="queue">
            {d?.queue.map((o) => (
              <li key={o.id}>
                <Link to={`/seller/orders/${o.id}`}>
                  <div className="grow"><div className="strong pn">{o.number}</div><div className="xs muted">{o.units} item{o.units === 1 ? "" : "s"} · {o.ship_city} · {dateTime(o.created_at)}</div></div>
                  <StatusBadge status={o.status} />
                  <LuArrowRight aria-hidden="true" size={16} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="grid-2--even grid-2" style={{ marginTop: 20 }}>
        <Card title="Best sellers, 30 days">
          {d && d.top_products.length === 0 && <p className="card__body muted">Sales will appear here.</p>}
          <ol className="rank">
            {d?.top_products.map((p) => (
              <li key={p.product_id}><span className="grow"><Link to={`/seller/listings/${p.product_id}`} className="table-title">{p.title}</Link><span className="cell-sub pn">{p.part_number}</span></span><span className="nowrap">{p.units} sold</span><span className="strong nowrap">{rupees(p.revenue)}</span></li>
            ))}
          </ol>
        </Card>
        <Card title="Listing health">
          {d && (
            <ul className="queue">
              <li><Link to="/seller/listings?status=rejected"><span className="grow">Need changes after review</span><StatusBadge status={d.kpis.rejected_listings ? "rejected" : "active"} label={String(d.kpis.rejected_listings)} /></Link></li>
              <li><Link to="/seller/listings?status=pending"><span className="grow">Waiting for review</span><StatusBadge status="pending" label={String(d.kpis.pending_listings)} /></Link></li>
              <li><Link to="/seller/listings?status=low_stock"><span className="grow">Live with 3 or fewer in stock</span><StatusBadge status={d.kpis.low_stock ? "pending" : "active"} label={String(d.kpis.low_stock)} /></Link></li>
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
