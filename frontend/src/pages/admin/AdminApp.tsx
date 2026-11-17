import { LuArrowRight, LuCar, LuChartColumn, LuClipboardCheck, LuHistory, LuPackage, LuSettings, LuStore, LuUsers, LuWallet } from "react-icons/lu";
import { PortalLayout } from "../../layouts/PortalLayout";
import { rupees, rupeesShort } from "../../lib/format";
import { useQuery } from "../../lib/query";
import { Link, Routes } from "../../lib/router";
import { DailyBars } from "../../ui/chart";
import { Card, ErrorState, PageHeader, Skeleton } from "../../ui/core";
import { NotFound } from "../store/NotFound";
import { CatalogPage } from "./Catalog";
import { AdminListingPage, AdminOrderPage, AdminOrdersPage, ModerationPage, PayoutsAdminPage, SettingsPage } from "./Operations";
import { AuditPage, SellerReviewPage, SellersPage, UsersPage } from "./People";

interface Dash {
  kpis: { gmv_30d: number; commission_30d: number; orders_30d: number; new_buyers_30d: number; active_sellers: number; pending_sellers: number; pending_listings: number; active_listings: number; open_returns: number; late_shipments: number };
  series: { day: string; gmv_paise: number; orders: number }[];
  top_sellers: { id: number; display_name: string; city: string; sales: number; orders: number }[];
  top_categories: { name: string; sales: number }[];
}

function Dashboard() {
  const q = useQuery<Dash>("/api/admin/dashboard");
  const d = q.data;
  if (q.error) return <ErrorState message={q.error.message} onRetry={q.reload} />;
  const queues = d ? [
    { to: "/admin/sellers?status=pending", label: "Sellers waiting for verification", n: d.kpis.pending_sellers },
    { to: "/admin/listings?status=pending", label: "Listings waiting for review", n: d.kpis.pending_listings },
    { to: "/admin/orders?status=return_requested", label: "Open return requests", n: d.kpis.open_returns },
    { to: "/admin/orders?status=placed", label: "Orders not shipped after 2 days", n: d.kpis.late_shipments },
  ] : [];
  return (
    <>
      <PageHeader title="Marketplace overview" subtitle="Last 30 days" />
      {!d ? <Skeleton height={96} /> : (
        <div className="kpis" style={{ "--n": 4 }}>
          <div className="kpi"><span className="micro">GMV</span><span className="kpi__value">{rupeesShort(d.kpis.gmv_30d)}</span><span className="kpi__note">{d.kpis.orders_30d} orders</span></div>
          <div className="kpi"><span className="micro">Commission earned</span><span className="kpi__value">{rupeesShort(d.kpis.commission_30d)}</span><span className="kpi__note">Before refunds</span></div>
          <Link to="/admin/sellers" className="kpi"><span className="micro">Active sellers</span><span className="kpi__value">{d.kpis.active_sellers}</span><span className="kpi__note">{d.kpis.active_listings} live listings</span></Link>
          <Link to="/admin/users" className="kpi"><span className="micro">New shoppers</span><span className="kpi__value">{d.kpis.new_buyers_30d}</span><span className="kpi__note">Registered accounts</span></Link>
        </div>
      )}
      <div className="grid-2" style={{ marginTop: 20 }}>
        <Card title="Gross merchandise value per day">
          {d ? <DailyBars points={d.series.map((s) => ({ day: s.day, value: s.gmv_paise }))} format={rupeesShort} label="GMV" /> : <div className="card__body"><Skeleton height={200} /></div>}
        </Card>
        <Card title="Work queues">
          <ul className="queue">
            {queues.map((x) => (
              <li key={x.to}><Link to={x.to}><span className="grow">{x.label}</span><span className={`kpi__value ${x.n ? "warn-text" : "muted"}`} style={{ fontSize: "1.25rem" }}>{x.n}</span><LuArrowRight aria-hidden="true" size={16} /></Link></li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="grid-2 grid-2--even" style={{ marginTop: 20 }}>
        <Card title="Top sellers">
          <ol className="rank">{d?.top_sellers.map((s) => <li key={s.id}><span className="grow"><Link to={`/admin/sellers/${s.id}`} className="table-title">{s.display_name}</Link><span className="cell-sub">{s.city} · {s.orders} orders</span></span><strong>{rupees(s.sales)}</strong></li>)}</ol>
        </Card>
        <Card title="Top categories">
          <ol className="rank">{d?.top_categories.map((c) => <li key={c.name}><span className="grow">{c.name}</span><strong>{rupees(c.sales)}</strong></li>)}</ol>
        </Card>
      </div>
    </>
  );
}

export default function AdminApp() {
  const q = useQuery<Dash>("/api/admin/dashboard");
  const k = q.data?.kpis;
  return (
    <PortalLayout
      area="Admin"
      nav={[
        { to: "/admin", label: "Overview", icon: LuChartColumn, exact: true },
        { to: "/admin/sellers", label: "Sellers", icon: LuStore, badge: k?.pending_sellers },
        { to: "/admin/listings", label: "Listing review", icon: LuClipboardCheck, badge: k?.pending_listings },
        { to: "/admin/orders", label: "Orders", icon: LuPackage, badge: k?.open_returns },
        { to: "/admin/payouts", label: "Payouts", icon: LuWallet },
        { to: "/admin/catalog", label: "Vehicles & catalogue", icon: LuCar },
        { to: "/admin/users", label: "Users", icon: LuUsers },
        { to: "/admin/audit", label: "Audit log", icon: LuHistory },
        { to: "/admin/settings", label: "Settings", icon: LuSettings },
      ]}
    >
      <Routes
        fallback={<NotFound />}
        routes={[
          { path: "/admin", render: () => <Dashboard /> },
          { path: "/admin/sellers", render: () => <SellersPage /> },
          { path: "/admin/sellers/:id", render: (p) => <SellerReviewPage id={Number(p.id)} /> },
          { path: "/admin/listings", render: () => <ModerationPage /> },
          { path: "/admin/listings/:id", render: (p) => <AdminListingPage id={Number(p.id)} /> },
          { path: "/admin/orders", render: () => <AdminOrdersPage /> },
          { path: "/admin/orders/:id", render: (p) => <AdminOrderPage id={Number(p.id)} /> },
          { path: "/admin/payouts", render: () => <PayoutsAdminPage /> },
          { path: "/admin/catalog", render: () => <CatalogPage /> },
          { path: "/admin/users", render: () => <UsersPage /> },
          { path: "/admin/audit", render: () => <AuditPage /> },
          { path: "/admin/settings", render: () => <SettingsPage /> },
        ]}
      />
    </PortalLayout>
  );
}
