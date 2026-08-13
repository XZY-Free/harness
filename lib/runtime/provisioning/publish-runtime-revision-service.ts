import { mysqlRuntimePublicationStore } from "@/lib/runtime/persistence/mysql-runtime-publication-store";
import {
  type PublishRuntimeRevisionCommand,
  createPublishRuntimeRevision,
} from "@/lib/runtime/provisioning/publish-runtime-revision";

const publishRuntimeRevision = createPublishRuntimeRevision({
  store: mysqlRuntimePublicationStore,
});

export function publishRuntimeRevisionThroughControlPlane(command: PublishRuntimeRevisionCommand) {
  return publishRuntimeRevision(command);
}
