import { Suspense, lazy } from "react";
import type { ReactNode } from "react";
import { StoreLayout } from "./layouts/StoreLayout";
import { Redirect, Routes, useRouter } from "./lib/router";
import { AccountPage } from "./pages/store/Account";
import { LoginPage, RegisterPage } from "./pages/store/Auth";
import { CartPage } from "./pages/store/Cart";
import { CheckoutPage, PaymentPage } from "./pages/store/Checkout";
import { HomePage } from "./pages/store/Home";
import { NotFound } from "./pages/store/NotFound";
import { OrderPage, OrdersPage } from "./pages/store/Orders";
import { ProductPage } from "./pages/store/Product";
import { SearchPage } from "./pages/store/Search";
import { SellPage } from "./pages/store/Sell";
import { useAuth } from "./state/app";
import { NotificationsPage } from "./ui/notifications";
import type { Role } from "./lib/types";

const SellerApp = lazy(() => import("./pages/seller/SellerApp"));
const AdminApp = lazy(() => import("./pages/admin/AdminApp"));

function PageLoading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="page-loading__bar" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

export function RequireAuth({ children, role }: { children: ReactNode; role?: Role }) {
  const { user, ready } = useAuth();
  const { pathname, search } = useRouter();
  if (!ready) return <PageLoading />;
  if (!user) return <Redirect to={`/login?next=${encodeURIComponent(pathname + search)}`} />;
  if (role && user.role !== role) {
    if (role === "seller" && user.role === "buyer") return <Redirect to="/sell" />;
    return <Redirect to="/" />;
  }
  return <>{children}</>;
}

export function App() {
  const { pathname } = useRouter();

  if (pathname === "/seller" || pathname.startsWith("/seller/")) {
    return (
      <RequireAuth role="seller">
        <Suspense fallback={<PageLoading />}><SellerApp /></Suspense>
      </RequireAuth>
    );
  }
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return (
      <RequireAuth role="admin">
        <Suspense fallback={<PageLoading />}><AdminApp /></Suspense>
      </RequireAuth>
    );
  }

  return (
    <StoreLayout>
      <Routes
        fallback={<NotFound />}
        routes={[
          { path: "/", render: () => <HomePage /> },
          { path: "/search", render: () => <SearchPage /> },
          { path: "/p/:id/:slug", render: (p) => <ProductPage id={Number(p.id)} /> },
          { path: "/p/:id", render: (p) => <ProductPage id={Number(p.id)} /> },
          { path: "/cart", render: () => <CartPage /> },
          { path: "/checkout", render: () => <RequireAuth><CheckoutPage /></RequireAuth> },
          { path: "/orders", render: () => <RequireAuth><OrdersPage /></RequireAuth> },
          { path: "/orders/:id", render: (p) => <RequireAuth><OrderPage id={Number(p.id)} /></RequireAuth> },
          { path: "/orders/:id/pay", render: (p) => <RequireAuth><PaymentPage id={Number(p.id)} /></RequireAuth> },
          { path: "/account", render: () => <RequireAuth><AccountPage /></RequireAuth> },
          { path: "/notifications", render: () => <RequireAuth><div className="container page"><NotificationsPage /></div></RequireAuth> },
          { path: "/login", render: () => <LoginPage /> },
          { path: "/register", render: () => <RegisterPage /> },
          { path: "/sell", render: () => <SellPage /> },
        ]}
      />
    </StoreLayout>
  );
}
