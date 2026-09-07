import { createIdentityExtension } from "@/lib/deployment/identity-extension";
import {
  type IdentityExtension,
  IdentityExtensionBootstrap,
} from "@/lib/identity/identity-extension";

const runtimeBootstrap = new IdentityExtensionBootstrap(async () => createIdentityExtension());

export function initializeIdentityExtensions(): Promise<IdentityExtension> {
  return runtimeBootstrap.initialize();
}

export async function getIdentityExtensions(): Promise<IdentityExtension> {
  return initializeIdentityExtensions();
}

export function assertIdentityExtensionsReady(): Promise<IdentityExtension> {
  return initializeIdentityExtensions();
}
