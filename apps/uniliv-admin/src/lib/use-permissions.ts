import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./api-fetch";
import { useAuthStore } from "./store";
import { can, moduleForPath, type Module, type Permission, type UserRole } from "./permissions";

/**
 * The caller's RESOLVED capabilities, served by /auth/me (PRD §32).
 *
 * A HINT, never an authority — the server refuses regardless. It is served
 * rather than bundled for three reasons: a bundled copy cannot follow a
 * database-backed matrix and goes stale the moment an admin saves; it removes
 * the second source of truth entirely; and it leaks strictly less, since a user
 * receives only their own surface rather than the whole 22x54 matrix.
 */
export interface MeAccess {
  version: number;
  capabilities: Record<string, string[]>;
  scope: {
    unrestricted: boolean;
    propertyIds: string[] | null;
    dataScope: string;
    primaryPropertyId: string | null;
  } | null;
}

interface Me {
  id: string;
  name: string;
  email: string;
  username?: string | null;
  designation?: string | null;
  phone?: string | null;
  role: UserRole;
  propertyId?: string | null;
  access?: MeAccess;
}

export function useMe() {
  // Key by token so a different signed-in user never reads the previous
  // user's cached identity (root cause of the "always super admin" bug).
  const token = useAuthStore((s) => s.token);
  return useQuery<{ data: Me }>({
    queryKey: ["/auth/me", token],
    queryFn: () => apiFetch("/auth/me"),
    enabled: !!token,
    // 60s, not 5 minutes: a revoked grant should not keep lighting up the nav
    // for five minutes after it is gone.
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function usePermissions() {
  const { data, isLoading } = useMe();
  const role = data?.data?.role;
  const propertyId = data?.data?.propertyId ?? null;
  const access = data?.data?.access;

  /**
   * Prefer the SERVED capabilities; fall back to the bundled matrix only until
   * the blob arrives. The bundled copy cannot see a matrix edit, so trusting it
   * once the server has spoken would show a stale answer indefinitely.
   */
  const check = (module: Module, action: string): boolean => {
    if (access?.capabilities) return (access.capabilities[module] ?? []).includes(action);
    return can(role, module, action as Permission);
  };

  return {
    role,
    propertyId,
    me: data?.data,
    access,
    isLoading,
    can: (module: Module, perm: string = "view") => check(module, perm),
    /**
     * FAIL CLOSED on an unmapped path.
     *
     * This returned `true` for anything PATH_TO_MODULE did not list, so every
     * route added without a mapping was ungated — and the mapping is a separate
     * hand-maintained list, so that happened silently. An unmapped path is now
     * a refusal, and routes.test.ts makes it impossible to ship one.
     */
    canPath: (path: string, perm: string = "view") => {
      const m = moduleForPath(path);
      if (!m) return false;
      return check(m, perm);
    },
  };
}
