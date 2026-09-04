import { computeCanonicalDigest } from "@/lib/crypto/rfc-8785-canonicalize";
import type { ExecutionSubject } from "@/lib/runtime/transport/execution-subject";

export const KNOWLEDGE_ACL_VERSION = "1" as const;

export interface KnowledgeAclSnapshot {
  version: typeof KNOWLEDGE_ACL_VERSION;
  grants: {
    users: string[];
    services: string[];
    roles: KnowledgeAclMembershipGrant[];
    scopes: KnowledgeAclMembershipGrant[];
  };
}

export interface KnowledgeAclMembershipGrant {
  id: string;
  users: string[];
  services: string[];
}

export type KnowledgeAclDecision =
  | { status: "allowed" }
  | { status: "denied"; reasonCode: string }
  | { status: "unavailable"; reasonCode: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isUniqueStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0) &&
    new Set(value).size === value.length
  );
}

function parseMembershipGrants(value: unknown): KnowledgeAclMembershipGrant[] | null {
  if (!Array.isArray(value)) return null;
  const grants: KnowledgeAclMembershipGrant[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !isPlainObject(item) ||
      !hasOnlyKeys(item, ["id", "users", "services"]) ||
      typeof item.id !== "string" ||
      item.id.trim().length === 0 ||
      ids.has(item.id) ||
      !isUniqueStringArray(item.users) ||
      !isUniqueStringArray(item.services)
    ) {
      return null;
    }
    ids.add(item.id);
    grants.push({ id: item.id, users: item.users, services: item.services });
  }
  return grants;
}

function parseSnapshot(value: unknown): KnowledgeAclSnapshot | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["version", "grants"])) return null;
  if (value.version !== KNOWLEDGE_ACL_VERSION || !isPlainObject(value.grants)) return null;
  if (!hasOnlyKeys(value.grants, ["users", "services", "roles", "scopes"])) return null;
  const { users, services, roles, scopes } = value.grants;
  const parsedRoles = parseMembershipGrants(roles);
  const parsedScopes = parseMembershipGrants(scopes);
  if (
    !isUniqueStringArray(users) ||
    !isUniqueStringArray(services) ||
    !parsedRoles ||
    !parsedScopes
  ) {
    return null;
  }
  return {
    version: KNOWLEDGE_ACL_VERSION,
    grants: { users, services, roles: parsedRoles, scopes: parsedScopes },
  };
}

/**
 * Revision 冻结 ACL 的唯一 evaluator。Role/scope 授权同时冻结当时的成员主体，
 * 恢复时不读取最新角色或 scope 配置，避免改写已发布 Revision 的权限语义。
 */
export function evaluateKnowledgeRevisionAcl(input: {
  tenantId: string;
  executionSubject: ExecutionSubject;
  aclSnapshotJson: unknown;
  aclSnapshotHash: string | null;
}): KnowledgeAclDecision {
  if (
    input.executionSubject.tenantId !== input.tenantId ||
    !input.executionSubject.subjectId ||
    (input.executionSubject.subjectType !== "user" &&
      input.executionSubject.subjectType !== "service")
  ) {
    return { status: "denied", reasonCode: "knowledge_subject_invalid" };
  }
  const snapshot = parseSnapshot(input.aclSnapshotJson);
  if (!snapshot || !input.aclSnapshotHash) {
    return { status: "unavailable", reasonCode: "knowledge_acl_schema_invalid" };
  }
  if (computeCanonicalDigest(snapshot) !== input.aclSnapshotHash) {
    return { status: "unavailable", reasonCode: "knowledge_acl_integrity_mismatch" };
  }
  const membershipGrants = [...snapshot.grants.roles, ...snapshot.grants.scopes];
  const allowed =
    input.executionSubject.subjectType === "user"
      ? snapshot.grants.users.includes(input.executionSubject.subjectId) ||
        membershipGrants.some((grant) => grant.users.includes(input.executionSubject.subjectId))
      : snapshot.grants.services.includes(input.executionSubject.subjectId) ||
        membershipGrants.some((grant) => grant.services.includes(input.executionSubject.subjectId));
  return allowed ? { status: "allowed" } : { status: "denied", reasonCode: "knowledge_acl_denied" };
}
