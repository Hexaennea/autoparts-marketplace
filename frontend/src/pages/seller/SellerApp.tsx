import { LuChartColumn, LuFileSpreadsheet, LuPackage, LuSettings, LuTag, LuWallet } from "react-icons/lu";
import { PortalLayout } from "../../layouts/PortalLayout";
import { useQuery } from "../../lib/query";
import { Routes } from "../../lib/router";
import { useAuth } from "../../state/app";
import { Alert } from "../../ui/core";
import { NotFound } from "../store/NotFound";
import { SellerDashboard } from "./Dashboard";
import { ImportPage } from "./Import";
import { ListingEditor } from "./ListingEditor";
import { ListingsPage } from "./Listings";
import { SellerOrderPage, SellerOrdersPage } from "./Orders";
import { PayoutsPage } from "./Payouts";
import { SellerSettings } from "./Settings";

export default function SellerApp() {
  const { user } = useAuth();
  const counts = useQuery<{ kpis: { to_ship: number; returns_open: number } }>("/api/seller/dashboard");
  const status = user?.seller?.status;
  const banner =
    status && status !== "approved" ? (
      <div className="portal-banner">
        <Alert kind={status === "pending" ? "info" : "warn"} title={status === "pending" ? "Your seller account is being verified" : `Seller account ${status}`}>
          {status === "pending"
            ? "We're checking your GSTIN and bank details. You can prepare draft listings now; submitting them for review unlocks after approval."
            : user?.seller?.note ?? "Contact support to resolve this."}
        </Alert>
      </div>
    ) : undefined;
  const k = counts.data?.kpis;

  return (
    <PortalLayout
      area="Seller"
      banner={banner}
      nav={[
        { to: "/seller", label: "Overview", icon: LuChartColumn, exact: true },
        { to: "/seller/orders", label: "Orders", icon: LuPackage, badge: k ? k.to_ship + k.returns_open : undefined },
        { to: "/seller/listings", label: "Listings", icon: LuTag },
        { to: "/seller/import", label: "Bulk import", icon: LuFileSpreadsheet },
        { to: "/seller/payouts", label: "Payouts", icon: LuWallet },
        { to: "/seller/settings", label: "Shop settings", icon: LuSettings },
      ]}
    >
      <Routes
        fallback={<NotFound />}
        routes={[
          { path: "/seller", render: () => <SellerDashboard /> },
          { path: "/seller/orders", render: () => <SellerOrdersPage /> },
          { path: "/seller/orders/:id", render: (p) => <SellerOrderPage id={Number(p.id)} /> },
          { path: "/seller/listings", render: () => <ListingsPage /> },
          { path: "/seller/listings/new", render: () => <ListingEditor /> },
          { path: "/seller/listings/:id", render: (p) => <ListingEditor id={Number(p.id)} /> },
          { path: "/seller/import", render: () => <ImportPage /> },
          { path: "/seller/payouts", render: () => <PayoutsPage /> },
          { path: "/seller/settings", render: () => <SellerSettings /> },
        ]}
      />
    </PortalLayout>
  );
}
