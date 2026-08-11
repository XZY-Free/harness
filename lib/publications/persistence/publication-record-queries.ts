import { db } from "@/lib/db/client";
import type { PublicationSubjectType } from "@/lib/publications/domain/publication-record";
import {
 type PublicationRecord,
 type WithdrawalRecord,
 publicationRecord,
 withdrawalRecord,
} from "@/lib/publications/persistence/publication-record";
import { and, desc, eq } from "drizzle-orm";

export async function getPublicationRecordById(params: {
 tenantId: string;
 publicationRecordId: string;
}): Promise<PublicationRecord | null> {
 const [record] = await db
 .select()
 .from(publicationRecord)
 .where(
 and(
 eq(publicationRecord.tenantId, params.tenantId),
 eq(publicationRecord.id, params.publicationRecordId),
 ),
 )
 .limit(1);
 return record ?? null;
}

export async function getPublicationRecordBySubject(params: {
 tenantId: string;
 subjectType: PublicationSubjectType;
 subjectRevisionId: string;
}): Promise<PublicationRecord | null> {
 const [record] = await db
 .select()
 .from(publicationRecord)
 .where(
 and(
 eq(publicationRecord.tenantId, params.tenantId),
 eq(publicationRecord.subjectType, params.subjectType),
 eq(publicationRecord.subjectRevisionId, params.subjectRevisionId),
 ),
 )
 .limit(1);
 return record ?? null;
}

export async function listPublicationRecords(params: {
  tenantId: string;
  subjectType?: PublicationSubjectType;
  subjectRevisionId?: string;
}): Promise<PublicationRecord[]> {
  const conditions = [eq(publicationRecord.tenantId, params.tenantId)];
  if (params.subjectType) conditions.push(eq(publicationRecord.subjectType, params.subjectType));
  if (params.subjectRevisionId) {
    conditions.push(eq(publicationRecord.subjectRevisionId, params.subjectRevisionId));
  }
  return db
    .select()
    .from(publicationRecord)
    .where(and(...conditions))
    .orderBy(desc(publicationRecord.publicationSequence));
}

export async function getWithdrawalRecordBySubject(params: {
 tenantId: string;
 subjectType: PublicationSubjectType;
 subjectRevisionId: string;
}): Promise<WithdrawalRecord | null> {
 const [record] = await db
 .select()
 .from(withdrawalRecord)
 .where(
 and(
 eq(withdrawalRecord.tenantId, params.tenantId),
 eq(withdrawalRecord.subjectType, params.subjectType),
 eq(withdrawalRecord.subjectRevisionId, params.subjectRevisionId),
 ),
 )
 .limit(1);
 return record ?? null;
}

export async function getWithdrawalRecordById(params: {
  tenantId: string;
  withdrawalRecordId: string;
}): Promise<WithdrawalRecord | null> {
  const [record] = await db
    .select()
    .from(withdrawalRecord)
    .where(
      and(
        eq(withdrawalRecord.tenantId, params.tenantId),
        eq(withdrawalRecord.id, params.withdrawalRecordId),
      ),
    )
    .limit(1);
  return record ?? null;
}

export async function listWithdrawalRecords(params: {
  tenantId: string;
  subjectType?: PublicationSubjectType;
  subjectRevisionId?: string;
}): Promise<WithdrawalRecord[]> {
  const conditions = [eq(withdrawalRecord.tenantId, params.tenantId)];
  if (params.subjectType) conditions.push(eq(withdrawalRecord.subjectType, params.subjectType));
  if (params.subjectRevisionId) {
    conditions.push(eq(withdrawalRecord.subjectRevisionId, params.subjectRevisionId));
  }
  return db
    .select()
    .from(withdrawalRecord)
    .where(and(...conditions))
    .orderBy(desc(withdrawalRecord.withdrawnAt));
}
