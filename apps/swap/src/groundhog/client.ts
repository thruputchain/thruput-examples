import {
  createGroundhogClient,
  HttpTransport,
  type GroundhogClient,
} from "@groundhogchain/client";

import type { AppConfig } from "@/config";

export function createReadClient(config: AppConfig): GroundhogClient {
  return createGroundhogClient(new HttpTransport(config.rpcUrl.href));
}
