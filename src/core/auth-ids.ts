/**
 * The IDs of a CLI provider's auth methods. A leaf module: the backend, the registrar, and the auth
 * methods all name them, and none of them may import another just for a constant.
 */

/** The ID of the method that reuses the CLI's own login (terminal only). */
export const LOGIN_METHOD_ID = "login";
/**
 * The ID of the method that saves an API key as an auth profile. Not `api-key`: OpenClaw gives that
 * ID a quick-entry path (`models.authSetApiKey`, checked against OpenClaw 2026.10.3) that stores the
 * key without running the method, so the install offer and the key check would be skipped.
 */
export const API_KEY_METHOD_ID = "api-key-env";
/** The ID of the method that removes a key left in the plugin config and the managed CLI, each after a yes (terminal only). */
export const REMOVE_METHOD_ID = "remove";
