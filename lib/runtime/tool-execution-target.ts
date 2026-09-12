import type { NetworkPolicy, ResourceQuota } from "./types";

/** 冻结在能力目录中；不接受模型通过工具参数覆盖。 */
export type ToolExecutionTarget =
  | {
      kind: "host" | "container";
      threadId: string;
      workspaceRoot: string;
      quota: ResourceQuota;
      networkPolicy: NetworkPolicy;
    }
  | {
      kind: "desktop";
      threadId: string;
      workspaceBindingId: string;
      deviceId: string;
      ownerUserId: string;
      bindingVersion: string;
    };
