import { ADAPTERS } from "./registry.ts";
import { createSyntheticAuthProvider } from "./core/synthetic-auth.ts";

/**
 * Provider-catalog entry named in `openclaw.plugin.json` (`providerCatalogEntry`). OpenClaw loads
 * it before the plugin runtime to ask whether each CLI's own login counts as auth. Composition
 * root like `plugin.ts`, and it imports no OpenClaw runtime code.
 */
export default ADAPTERS.map(createSyntheticAuthProvider);
