import { ADAPTERS } from "./registry.ts";
import { createModelCatalog } from "./core/catalog.ts";
import { warnBeforeRuntime } from "./core/logger.ts";
import { createSyntheticAuthProvider } from "./core/synthetic-auth.ts";

/**
 * Provider-catalog entry named in `openclaw.plugin.json` (`providerCatalogEntry`). OpenClaw loads
 * it before the plugin runtime to ask whether each CLI's own login counts as auth, and which models
 * the account has. Composition root like `plugin.ts`.
 */
export default ADAPTERS.map((adapter) =>
  createSyntheticAuthProvider(adapter, createModelCatalog(adapter, { warn: warnBeforeRuntime })),
);
