// API contract types (mirrors backend payloads).

export type Role = "buyer" | "seller" | "admin";
export type KycStatus = "pending" | "approved" | "rejected" | "suspended";

export interface User {
  id: number;
  email: string;
  full_name: string;
  phone: string | null;
  role: Role;
  created_at: string;
  seller: { id: number; status: KycStatus; display_name: string; note: string | null } | null;
}

export interface Session {
  user: User | null;
  csrf: string;
}

export interface Make { id: number; name: string; slug: string; model_count: number }
export interface Model { id: number; name: string; slug: string; body_type: string; year_from: number; year_to: number | null }

export interface Variant {
  id: number;
  code: string;
  name: string;
  generation: string | null;
  year_from: number;
  year_to: number | null;
  years: string;
  fuel: string;
  fuel_label: string;
  transmission: string;
  transmission_label: string;
  engine_cc: number | null;
  engine_code: string | null;
  model_id: number;
  model: string;
  body_type: string;
  make_id: number;
  make: string;
  label: string;
  is_active: boolean;
  part_count?: number;
  fitment_count?: number;
}

/** The buyer's selected car: a variant plus the model year they own. */
export interface Vehicle {
  variant: Variant;
  year: number;
}

export interface Category {
  id: number;
  parent_id: number | null;
  name: string;
  slug: string;
  icon: string;
  position: number;
  is_active: boolean;
  product_count: number;
  total_count: number;
  children: Category[];
}

export interface Brand { id: number; name: string; slug: string; is_oem: boolean; is_active?: boolean; product_count?: number }

export interface ProductCard {
  id: number;
  slug: string;
  title: string;
  part_number: string;
  condition: "new" | "oem_genuine";
  price_paise: number;
  mrp_paise: number;
  in_stock: boolean;
  low_stock: boolean;
  rating_avg: number;
  rating_count: number;
  is_universal: boolean;
  warranty_months: number;
  brand: string;
  brand_is_oem: boolean;
  category: string;
  category_slug: string;
  seller: { id: number; name: string; city: string };
  image: string | null;
  fits: boolean | null;
}

export interface FitmentGroup { make: string; model: string; model_id: number; variants: Variant[] }

export interface ProductDetail {
  id: number;
  sku: string;
  slug: string;
  title: string;
  description: string;
  part_number: string;
  condition: "new" | "oem_genuine";
  price_paise: number;
  mrp_paise: number;
  stock: number;
  in_stock: boolean;
  gst_rate_bps: number;
  hsn_code: string;
  warranty_months: number;
  weight_grams: number;
  is_universal: boolean;
  status: string;
  rating_avg: number;
  rating_count: number;
  rating_distribution: Record<string, number>;
  sold_count: number;
  brand: { name: string; slug: string; is_oem: boolean };
  category: { name: string; slug: string; parent: { name: string; slug: string } | null };
  seller: { id: number; name: string; city: string; state: string; rating_avg: number; rating_count: number; since: string };
  images: { id: number; url: string; thumb: string; width: number; height: number }[];
  specs: { label: string; value: string }[];
  part_numbers: { number: string; kind: "primary" | "oem" | "cross" }[];
  fitment: FitmentGroup[];
  fitment_count: number;
  vehicle: Variant | null;
  fits: boolean | null;
  other_sellers: ProductCard[];
  related: ProductCard[];
}

export interface Review {
  id: number;
  rating: number;
  title: string;
  body: string;
  vehicle_label: string | null;
  created_at: string;
  author: string;
  verified: boolean;
}

export interface Paged<T> { items: T[]; total: number; page: number; per_page: number; pages: number }

export interface SearchResult extends Paged<ProductCard> {
  facets: {
    brands: { slug: string; name: string; is_oem: boolean; count: number }[];
    categories: { slug: string; name: string; count: number }[];
    price: { min: number | null; max: number | null };
  };
  relaxed: boolean;
  vehicle: Variant | null;
  detected_model: { id: number; name: string; make: string } | null;
}

export interface CartLine {
  product_id: number;
  title: string;
  slug: string;
  brand: string;
  part_number: string;
  price_paise: number;
  mrp_paise: number;
  quantity: number;
  max_quantity: number;
  line_total_paise: number;
  image: string | null;
}

export interface Quote {
  groups: {
    seller: { id: number; name: string };
    items_paise: number;
    shipping_paise: number;
    free_shipping_remaining_paise: number;
    lines: CartLine[];
  }[];
  issues: { product_id: number; code: string; message: string; title: string | null; available?: number }[];
  summary: { items_paise: number; shipping_paise: number; total_paise: number; gst_paise: number; savings_paise: number; item_count: number };
  rules: { free_shipping_threshold_paise: number; shipping_fee_paise: number };
}

export interface Address {
  id: number;
  full_name: string;
  phone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  is_default: boolean;
}

export type FulfilmentStatus =
  | "pending_payment" | "placed" | "packed" | "shipped" | "delivered" | "cancelled" | "return_requested" | "returned";

export interface OrderItem {
  id: number;
  product_id: number;
  title: string;
  brand: string;
  part_number: string;
  sku: string;
  unit_price_paise: number;
  quantity: number;
  line_total_paise: number;
  gst_rate_bps: number;
  hsn_code: string;
  image: string | null;
}

export interface Fulfilment {
  id: number;
  status: FulfilmentStatus;
  status_label: string;
  seller: { id: number; name: string | null };
  items_paise: number;
  shipping_paise: number;
  carrier: string | null;
  tracking_number: string | null;
  cancel_reason: string | null;
  return_reason: string | null;
  refund_paise: number;
  shipped_at: string | null;
  delivered_at: string | null;
  items: OrderItem[];
  events: { status: string; note: string | null; created_at: string; label: string }[];
  can_cancel?: boolean;
  can_return?: boolean;
  commission_paise?: number;
  tcs_paise?: number;
  payout_id?: number | null;
}

export interface Order {
  id: number;
  number: string;
  created_at: string;
  payment_method: "cod" | "online";
  payment_status: string;
  items_paise: number;
  shipping_paise: number;
  total_paise: number;
  gst_paise: number;
  vehicle_label: string | null;
  address: Omit<Address, "id" | "is_default">;
  payment: { intent_id: string; status: string; provider: string } | null;
  fulfilments: Fulfilment[];
  buyer?: { id: number; email: string; name: string };
  payments?: { provider: string; intent_id: string; amount_paise: number; status: string; created_at: string }[];
}

export interface GarageEntry { id: number; year: number; nickname: string | null; variant: Variant; label: string }

export interface AppConfig { app_name: string; demo_mode: boolean; payments_test_mode: boolean }
