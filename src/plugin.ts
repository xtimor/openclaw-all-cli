import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createConfigValidator, registerAdapters } from "./core/register.ts";
import { PLUGIN_ID } from "./core/synthetic-auth.ts";
import { ADAPTERS } from "./registry.ts";

/** Composition root: the OpenClaw plugin entry. */
export default definePluginEntry({
  id: PLUGIN_ID,
  name: "OpenClaw All CLI",
  description: "Run local coding CLIs as OpenClaw models",
  configSchema: createConfigValidator(ADAPTERS),
  register: (api) => registerAdapters(api, ADAPTERS),
});
const ciRedCheck: number = "not a number"; // deliberate type error (ticket 3.2 verify); reverted next commit
