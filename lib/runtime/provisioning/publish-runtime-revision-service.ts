import {
 type PublishRuntimeRevisionCommand,
 createPublishRuntimeRevision,
} from "@/lib/runtime/provisioning/publish-runtime-revision";
import { mysqlRuntimePublicationStore } from "@/lib/runtime/persistence/mysql-runtime-publication-store";

const publishRuntimeRevision = createPublishRuntimeRevision({
 store: mysqlRuntimePublicationStore,
});

export function publishRuntimeRevisionThroughControlPlane(command: PublishRuntimeRevisionCommand) {
 return publishRuntimeRevision(command);
}
