# API reference

Generated from the route registry (`server/src/api/*.ts`, registered through `api.route` in `server/src/http.ts`). All responses are JSON: `{"data": …}` on success, `{"error": {"code", "message", "fields"?, "request_id"?}}` on failure.

Every non-GET request needs the `X-CSRF-Token` header (value from `GET /api/auth/session`). Money is integer **paise**, GST-inclusive.

| Auth | Meaning |
|---|---|
| public | anyone (session optional) |
| user | any signed-in account |
| buyer | shopper accounts (buyers and sellers) |
| seller | seller accounts; some actions also need KYC approval |
| admin | administrators |


## Account

| Method | Path | Auth | Body / query | Rate limit |
|---|---|---|---|---|
| PATCH | `/api/me` | user | ProfileIn | — |
| GET | `/api/me/addresses` | user |  | — |
| POST | `/api/me/addresses` | user | AddressIn | write |
| DELETE | `/api/me/addresses/{address_id}` | user |  | — |
| PUT | `/api/me/addresses/{address_id}` | user | AddressIn | write |
| GET | `/api/me/garage` | user |  | — |
| POST | `/api/me/garage` | user | GarageIn | write |
| DELETE | `/api/me/garage/{garage_id}` | user |  | — |
| GET | `/api/me/wishlist` | user |  | — |
| GET | `/api/me/wishlist/ids` | user |  | — |
| DELETE | `/api/me/wishlist/{product_id}` | user |  | — |
| PUT | `/api/me/wishlist/{product_id}` | user |  | write |

## Admin

| Method | Path | Auth | Body / query | Rate limit |
|---|---|---|---|---|
| GET | `/api/admin/audit` | admin |  ?AuditQuery | — |
| GET | `/api/admin/brands` | admin |  | — |
| POST | `/api/admin/brands` | admin | BrandIn | write |
| PATCH | `/api/admin/brands/{brand_id}` | admin | BrandIn | write |
| GET | `/api/admin/categories` | admin |  | — |
| POST | `/api/admin/categories` | admin | CategoryIn | write |
| PATCH | `/api/admin/categories/{category_id}` | admin | CategoryIn | write |
| GET | `/api/admin/dashboard` | admin |  | — |
| POST | `/api/admin/fulfilments/{fulfilment_id}/{action}` | admin | FulfilmentActionIn | write |
| POST | `/api/admin/makes` | admin | MakeIn | write |
| PATCH | `/api/admin/makes/{make_id}` | admin | MakeIn | write |
| POST | `/api/admin/models` | admin | ModelIn | write |
| PATCH | `/api/admin/models/{model_id}` | admin | ModelIn | write |
| GET | `/api/admin/orders` | admin |  ?PageQuery | — |
| GET | `/api/admin/orders/{order_id}` | admin |  | — |
| GET | `/api/admin/payouts` | admin |  | — |
| POST | `/api/admin/payouts` | admin | PayoutIn | write |
| GET | `/api/admin/products` | admin |  ?PageQuery | — |
| GET | `/api/admin/products/{product_id}` | admin |  | — |
| POST | `/api/admin/products/{product_id}/moderate` | admin | ModerateIn | write |
| GET | `/api/admin/sellers` | admin |  ?PageQuery | — |
| GET | `/api/admin/sellers/{seller_id}` | admin |  | — |
| POST | `/api/admin/sellers/{seller_id}/review` | admin | SellerReviewIn | write |
| GET | `/api/admin/settings` | admin |  | — |
| PUT | `/api/admin/settings` | admin | SettingsIn | write |
| GET | `/api/admin/users` | admin |  ?PageQuery | — |
| POST | `/api/admin/users/{user_id}/status` | admin | UserStatusIn | write |
| POST | `/api/admin/variants` | admin | VariantIn | write |
| PATCH | `/api/admin/variants/{variant_id}` | admin | VariantIn | write |
| GET | `/api/admin/vehicles` | admin |  | — |

## Auth

| Method | Path | Auth | Body / query | Rate limit |
|---|---|---|---|---|
| POST | `/api/auth/login` | public | LoginIn | login |
| POST | `/api/auth/logout` | user |  | — |
| POST | `/api/auth/password` | user | PasswordIn | password |
| POST | `/api/auth/register` | public | RegisterIn | register |
| GET | `/api/auth/session` | public |  | — |

## Cart

| Method | Path | Auth | Body / query | Rate limit |
|---|---|---|---|---|
| GET | `/api/cart` | user |  | — |
| DELETE | `/api/cart/items/{product_id}` | user |  | — |
| PUT | `/api/cart/items/{product_id}` | user | QuantityIn | write |
| POST | `/api/cart/merge` | user | LinesIn | write |
| POST | `/api/cart/preview` | public | LinesIn | write |

## Catalog

| Method | Path | Auth | Body / query | Rate limit |
|---|---|---|---|---|
| GET | `/api/brands` | public |  | — |
| GET | `/api/categories` | public |  | — |
| GET | `/api/home` | public |  ?HomeQuery | — |
| GET | `/api/products/{product_id}` | public |  ?ProductQuery | — |
| GET | `/api/products/{product_id}/reviews` | public |  ?ReviewsQuery | — |
| POST | `/api/products/{product_id}/reviews` | buyer | ReviewIn | review |
| GET | `/api/search` | public |  ?SearchQuery | — |
| GET | `/api/search/suggest` | public |  ?SearchQuery | — |
| GET | `/api/vehicles/makes` | public |  | — |
| GET | `/api/vehicles/makes/{make_id}/models` | public |  | — |
| GET | `/api/vehicles/models/{model_id}/variants` | public |  ?VariantQuery | — |
| GET | `/api/vehicles/models/{model_id}/years` | public |  | — |
| GET | `/api/vehicles/variants/{variant_id}` | public |  | — |

## Orders

| Method | Path | Auth | Body / query | Rate limit |
|---|---|---|---|---|
| GET | `/api/orders` | user |  ?OrdersQuery | — |
| POST | `/api/orders` | buyer | CheckoutIn | checkout |
| GET | `/api/orders/{order_id}` | user |  | — |
| POST | `/api/orders/{order_id}/fulfilments/{fulfilment_id}/cancel` | user | ReasonIn | write |
| POST | `/api/orders/{order_id}/fulfilments/{fulfilment_id}/return` | user | ReasonIn | write |
| POST | `/api/orders/{order_id}/payment/confirm` | user | PaymentConfirmIn | checkout |
| POST | `/api/orders/{order_id}/payment/retry` | user |  | checkout |

## Seller

| Method | Path | Auth | Body / query | Rate limit |
|---|---|---|---|---|
| POST | `/api/seller/apply` | user | ApplyIn | register |
| GET | `/api/seller/dashboard` | seller |  | — |
| POST | `/api/seller/import` | seller | multipart:csv ?ImportQuery | upload |
| GET | `/api/seller/import/reference.csv` | seller |  | — |
| GET | `/api/seller/import/template.csv` | seller |  | — |
| POST | `/api/seller/media` | seller | multipart:image | upload |
| GET | `/api/seller/orders` | seller |  ?SellerOrdersQuery | — |
| GET | `/api/seller/orders/{fulfilment_id}` | seller |  | — |
| POST | `/api/seller/orders/{fulfilment_id}/{action}` | seller | FulfilmentActionIn | write |
| GET | `/api/seller/payouts` | seller |  | — |
| GET | `/api/seller/products` | seller |  ?ListingsQuery | — |
| POST | `/api/seller/products` | seller | ListingIn | write |
| GET | `/api/seller/products/{product_id}` | seller |  | — |
| PUT | `/api/seller/products/{product_id}` | seller | ListingIn | write |
| PATCH | `/api/seller/products/{product_id}/inventory` | seller | InventoryIn | write |
| POST | `/api/seller/products/{product_id}/{action}` | seller |  | write |
| GET | `/api/seller/profile` | seller |  | — |
| PATCH | `/api/seller/profile` | seller | ProfileIn | write |

Plus: `GET /api/health`, `GET /api/config`, static `/media/*` (re-encoded images) and the SPA for every other path.
