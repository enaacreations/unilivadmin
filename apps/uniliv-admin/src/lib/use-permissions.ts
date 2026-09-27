import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./api-fetch";
import { useAuthStore } from "./store";
import {
  can, canModule, functionalityForPath, functionalitiesOf,
  readActionOf,
  type Functionality, type Module, type NamedAction, type UserRole,
} from "./permissions";

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
  /** functionality key → the actions held on it. The enforced unit. */
  capabilities: Record<string, string[]>;
  /**
   * module key → the union of actions held anywhere inside it. A ROLLUP the
   * server folds from `capabilities`, sent so the sidebar and launcher do not
   * each re-derive the tree. Never a grant: holding a module says nothing about
   * which of its screens may be opened.
   */
  modules?: Record<string, string[]>;
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
  const check = (functionality: Functionality, action?: string): boolean => {
    // Omitting the action means "can they SEE this", which is that
    // functionality's own read — there is no global "view" to fall back on.
    const a = action ?? readActionOf(functionality);
    if (!a) return false;
    if (access?.capabilities) return (access.capabilities[functionality] ?? []).includes(a);
    return can(role, functionality, a as NamedAction);
  };

  /**
   * The MODULE question — "is there anything here for this person?" — which is
   * what decides whether a nav section or a launcher card appears.
   *
   * Folded from the same `capabilities` the functionality check reads, falling
   * back to the served rollup and then to the bundled matrix, in that order. It
   * is never a separate lookup, so it cannot disagree with `can()`.
   */
  const checkModule = (module: Module, action?: string): boolean => {
    if (access?.capabilities) {
      return functionalitiesOf(module).some((f) => {
        const a = action ?? readActionOf(f);
        return a != null && (access.capabilities[f] ?? []).includes(a);
      });
    }
    if (action && access?.modules) return (access.modules[module] ?? []).includes(action);
    return canModule(role, module, action as NamedAction | undefined);
  };

  return {
    role,
    propertyId,
    me: data?.data,
    access,
    isLoading,
    /** Does the caller hold `perm` on this FUNCTIONALITY? Gates a screen or a control. */
    can: (functionality: Functionality, perm?: string) => check(functionality, perm),
    /** Does the caller hold `perm` on ANYTHING in this MODULE? Gates a nav section. */
    canModule: (module: Module, perm?: string) => checkModule(module, perm),
    /**
     * FAIL CLOSED on an unmapped path.
     *
     * This returned `true` for anything the path map did not list, so every
     * route added without a mapping was ungated — and the mapping is a separate
     * hand-maintained list, so that happened silently. An unmapped path is now
     * a refusal, and routes.test.ts makes it impossible to ship one.
     *
     * Resolves to a FUNCTIONALITY, not a module: a route is one screen, and
     * gating it on its module would let anyone with any Audit access open the
     * review queue.
     */
    canPath: (path: string, perm?: string) => {
      const f = functionalityForPath(path);
      if (!f) return false;
      return check(f, perm);
    },
  };
}
