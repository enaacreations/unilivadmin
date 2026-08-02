import { Request, Response, NextFunction } from "express";
import { can, type Module, type Permission, type UserRole } from "../lib/permissions.js";

export function authorize(module: Module, perm: Permission = "view") {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role as UserRole | undefined;
    if (!role) {
      res.status(401).json({ success: false, error: "Unauthenticated" });
      return;
    }
    if (!can(role, module, perm)) {
      res.status(403).json({ success: false, error: "Forbidden — insufficient permissions" });
      return;
    }
    next();
  };
}

/**
 * Passes when the role holds `perm` on ANY of the listed modules. Used by
 * shared endpoints that legitimately serve several surfaces — e.g. the
 * order-list feeds the All Orders page (FOOD_ALL_ORDERS), the Dispatch queue
 * (FOOD_DISPATCH) and the Kitchen board (FOOD_KITCHEN_SUMMARY). Gating on a
 * single module would lock operational roles (F&B managers) out of data they
 * must see, while granting them the "All Orders" module would wrongly light up
 * that page in their nav. An any-of gate keeps page access and data access
 * decoupled.
 */
export function authorizeAny(modules: Module[], perm: Permission = "view") {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role as UserRole | undefined;
    if (!role) {
      res.status(401).json({ success: false, error: "Unauthenticated" });
      return;
    }
    if (!modules.some((m) => can(role, m, perm))) {
      res.status(403).json({ success: false, error: "Forbidden — insufficient permissions" });
      return;
    }
    next();
  };
}
