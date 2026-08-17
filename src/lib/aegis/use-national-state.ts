import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getNationalState } from "@/server-fn/aegis";

export const NATIONAL_STATE_QUERY_KEY = ["aegis", "national-state"] as const;

/**
 * Single source of truth for every route. Because it's a shared React Query
 * cache key, approving a manifest on the National Dashboard and then
 * navigating to Field view no longer loses the change — invalidating this
 * key (see useInvalidateNationalState) refetches once and every consumer
 * updates together.
 */
export function useNationalState() {
  return useQuery({
    queryKey: NATIONAL_STATE_QUERY_KEY,
    queryFn: () => getNationalState(),
    // Polling until a Supabase Realtime subscription replaces it — see the
    // TODO in repository.ts. 15s keeps the heatmap/pulse-strip feeling live
    // without hammering the server function on every render.
    refetchInterval: 15_000,
  });
}

export function useInvalidateNationalState() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: NATIONAL_STATE_QUERY_KEY });
}
