import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V7 S3-1：messages GET 接口 activeRun 字段测试。
 *
 * 覆盖：
 * - 无活跃 run → activeRun = null
 * - DB 活跃 run + 内存也在 → canSubscribe = true
 * - DB 活跃 run + 内存不在 → canSubscribe = false（进程失联）
 */

const queries = vi.hoisted(() => ({
  getMessagesByThreadIdForUser: vi.fn(),
  getThreadByIdForUser: vi.fn(),
  getActiveThreadRun: vi.fn(),
}));
const runner = vi.hoisted(() => ({ getRunStatus: vi.fn() }));
const auth = vi.hoisted(() => ({ getCurrentUserFromRequest: vi.fn() }));
const utils = vi.hoisted(() => ({ convertToUIMessages: vi.fn() }));

vi.mock("@/lib/auth", () => ({ getCurrentUserFromRequest: auth.getCurrentUserFromRequest }));
vi.mock("@/lib/db/queries", () => ({
  getMessagesByThreadIdForUser: queries.getMessagesByThreadIdForUser,
  getThreadByIdForUser: queries.getThreadByIdForUser,
  getActiveThreadRun: queries.getActiveThreadRun,
}));
vi.mock("@/lib/runtime/thread-runner", () => ({ getRunStatus: runner.getRunStatus }));
vi.mock("@/lib/utils", () => ({ convertToUIMessages: utils.convertToUIMessages }));

import { GET } from "@/app/api/threads/[id]/messages/route";

const USER = { id: "u1", email: "a@x", name: "A", externalId: "u1", createdAt: new Date() };
const THREAD_ID = "tid-s31";

function makeRequest() {
  return new Request("http://localhost/api/threads/x/messages");
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.getCurrentUserFromRequest.mockResolvedValue(USER);
  queries.getMessagesByThreadIdForUser.mockResolvedValue([]);
  queries.getThreadByIdForUser.mockResolvedValue({
    model: "gpt-4",
    status: "idle",
    previewUrl: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });
  utils.convertToUIMessages.mockReturnValue([]);
  queries.getActiveThreadRun.mockResolvedValue(null);
  runner.getRunStatus.mockReturnValue(null);
});

describe("V7 S3-1: messages GET activeRun", () => {
  it("无活跃 run → activeRun = null", async () => {
    const res = await GET(makeRequest(), { params: Promise.resolve({ id: THREAD_ID }) });
    const body = await res.json();
    expect(body.activeRun).toBeNull();
  });

  it("DB 活跃 run + 内存也在 → canSubscribe = true", async () => {
    queries.getActiveThreadRun.mockResolvedValue({
      id: "run-001",
      status: "running",
      startedAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-01T00:01:00Z"),
    });
    runner.getRunStatus.mockReturnValue("running");

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: THREAD_ID }) });
    const body = await res.json();
    expect(body.activeRun).toEqual({
      id: "run-001",
      status: "running",
      startedAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-01T00:01:00.000Z",
      canSubscribe: true,
    });
  });

  it("DB 活跃 run + 内存不在 → canSubscribe = false", async () => {
    queries.getActiveThreadRun.mockResolvedValue({
      id: "run-002",
      status: "running",
      startedAt: new Date("2026-07-01T00:00:00Z"),
      lastSeenAt: new Date("2026-06-30T23:50:00Z"),
    });
    runner.getRunStatus.mockReturnValue(null);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: THREAD_ID }) });
    const body = await res.json();
    expect(body.activeRun).toEqual({
      id: "run-002",
      status: "running",
      startedAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-06-30T23:50:00.000Z",
      canSubscribe: false,
    });
  });

  it("DB 活跃 run startedAt/lastSeenAt 为 null → 安全处理", async () => {
    queries.getActiveThreadRun.mockResolvedValue({
      id: "run-003",
      status: "queued",
      startedAt: null,
      lastSeenAt: null,
    });
    runner.getRunStatus.mockReturnValue(null);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: THREAD_ID }) });
    const body = await res.json();
    expect(body.activeRun).toEqual({
      id: "run-003",
      status: "queued",
      startedAt: null,
      lastSeenAt: null,
      canSubscribe: false,
    });
  });
});
