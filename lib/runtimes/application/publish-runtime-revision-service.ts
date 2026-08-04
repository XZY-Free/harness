import {
  type PublishRuntimeRevisionCommand,
  createPublishRuntimeRevision,
} from "@/lib/runtimes/application/publish-runtime-revision";
import { mysqlRuntimePublicationStore } from "@/lib/runtimes/persistence/mysql-runtime-publication-store";

const publishRuntimeRevision = createPublishRuntimeRevision({
  store: mysqlRuntimePublicationStore,
});

export function publishRuntimeRevisionThroughControlPlane(command: PublishRuntimeRevisionCommand) {
  return publishRuntimeRevision(command);
}
