const EMPLOYEE_CATALOG_ETAG_PREFIX = "employee-catalog.";

export interface EmployeeCatalogEtagFacts {
  tenantId: string;
  catalogRevision: number;
  authorizationDigest: string;
}

export function buildEmployeeCatalogEtag(facts: EmployeeCatalogEtagFacts): string {
  return `${EMPLOYEE_CATALOG_ETAG_PREFIX}${Buffer.from(
    JSON.stringify({
      tenantId: facts.tenantId,
      catalogRevision: facts.catalogRevision,
      authorizationDigest: facts.authorizationDigest,
    }),
    "utf8",
  ).toString("base64url")}`;
}

export function parseEmployeeCatalogEtag(etag: string): EmployeeCatalogEtagFacts {
  if (!etag.startsWith(EMPLOYEE_CATALOG_ETAG_PREFIX)) {
    throw new Error("非法 Employee Catalog ETag 前缀");
  }
  const encoded = etag.slice(EMPLOYEE_CATALOG_ETAG_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("非法 Employee Catalog ETag 内容");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("非法 Employee Catalog ETag facts");
  }
  const facts = parsed as Record<string, unknown>;
  if (
    Object.keys(facts).sort().join(",") !== "authorizationDigest,catalogRevision,tenantId" ||
    typeof facts.tenantId !== "string" ||
    facts.tenantId.length === 0 ||
    typeof facts.catalogRevision !== "number" ||
    !Number.isSafeInteger(facts.catalogRevision) ||
    facts.catalogRevision < 0 ||
    typeof facts.authorizationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(facts.authorizationDigest)
  ) {
    throw new Error("非法 Employee Catalog ETag facts");
  }
  return {
    tenantId: facts.tenantId,
    catalogRevision: facts.catalogRevision,
    authorizationDigest: facts.authorizationDigest,
  };
}
