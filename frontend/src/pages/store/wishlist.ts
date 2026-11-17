import { useCallback, useMemo } from "react";
import { api, errorMessage } from "../../lib/api";
import { invalidate, useQuery } from "../../lib/query";
import { useRouter } from "../../lib/router";
import { useAuth, useToast } from "../../state/app";

/** Saved-part ids for heart toggles. Guests are sent to sign in. */
export function useWishlist() {
  const { user } = useAuth();
  const toast = useToast();
  const { navigate, pathname, search } = useRouter();
  const query = useQuery<number[]>(user ? "/api/me/wishlist/ids" : null);
  const ids = useMemo(() => new Set(query.data ?? []), [query.data]);

  const toggle = useCallback(
    async (id: number, on: boolean) => {
      if (!user) {
        navigate(`/login?next=${encodeURIComponent(pathname + search)}`);
        return;
      }
      query.mutate((prev) => (on ? [...(prev ?? []), id] : (prev ?? []).filter((x) => x !== id)));
      try {
        if (on) await api.put(`/api/me/wishlist/${id}`);
        else await api.del(`/api/me/wishlist/${id}`);
        invalidate("/api/me/wishlist");
        toast(on ? "Saved to your wishlist." : "Removed from your wishlist.");
      } catch (err) {
        query.reload();
        toast(errorMessage(err), "bad");
      }
    },
    [user, navigate, pathname, search, query, toast],
  );

  return { ids, toggle };
}
