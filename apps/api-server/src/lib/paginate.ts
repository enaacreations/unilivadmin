export function getPagination(query: Record<string, unknown>) {
  const page = Math.max(1, Number(query["page"]) || 1);
  const limit = Math.min(100, Math.max(1, Number(query["limit"]) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

export function buildMeta(total: number, page: number, limit: number) {
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}
