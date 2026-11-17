import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RouterProvider } from "./lib/router";
import { AuthProvider, CartProvider, ConfigProvider, ToastProvider, VehicleProvider } from "./state/app";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/store.css";
import "./styles/portal.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider>
        <ConfigProvider>
          <ToastProvider>
            <AuthProvider>
              <VehicleProvider>
                <CartProvider>
                  <App />
                </CartProvider>
              </VehicleProvider>
            </AuthProvider>
          </ToastProvider>
        </ConfigProvider>
      </RouterProvider>
    </StrictMode>,
  );
}
