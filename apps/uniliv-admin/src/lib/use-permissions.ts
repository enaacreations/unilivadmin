import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./api-fetch";
import { useAuthStore } from "./store";
import { can, moduleForPath, type Module, type Permission, type UserRole } from "./permissions";

interface Me {
  id: string;
  name: string;
  email: string;
  username?: string | null;
  designation?: string | null;
  phone?: string | null;
  role: UserRole;
  propertyId?: string | null;
}

export function useMe() {
  // Key by token so a different signed-in user never reads the previous
  // user's cached identity (root cause of the "always super admin" bug).
  const token = useAuthStore((s) => s.token);
  return useQuery<{ data: Me }>({
    queryKey: ["/auth/me", token],
    queryFn: () => apiFetch("/auth/me"),
    enabled: !!token,
    staleTime: 5 * 60_000,
  });
}

export function usePermissions() {
  const { data } = useMe();
  const role = data?.data?.role;
  const propertyId = data?.data?.propertyId ?? null;
  return {
    role,
    propertyId,
    me: data?.data,
    can: (module: Module, perm: Permission = "view") => can(role, module, perm),
    canPath: (path: string, perm: Permission = "view") => {
      const m = moduleForPath(path);
      return m ? can(role, m, perm) : true;
    },
  };
}
