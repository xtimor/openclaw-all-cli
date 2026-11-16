import type { ManagedInstallSpec } from "../../core/ports.ts";

// Written by scripts/pin-cursor-agent.mjs from Cursor's install script and its `.sha256` files; rerun it to move the pin.
/**
 * The cursor-agent package the cursor-cli Connect methods may install (AD-17). The version moves with
 * plugin releases, never on its own. `bytes` is the package size, `unpackedBytes` the size of the files it
 * unpacks to (measured from the package).
 */
export const CURSOR_MANAGED_INSTALL: ManagedInstallSpec = {
  version: "2026.11.11-b912975",
  origin: "https://downloads.cursor.com",
  platforms: {
    "linux-x64": {
      url: "https://downloads.cursor.com/lab/2026.11.11-b912975/linux/x64/agent-cli-package.tar.gz",
      sha256: "be01f42ad334f81d05a9992fcf060a52cc746f52cc451e849eb652146a6e3c91",
      bytes: 176703341,
      unpackedBytes: 562236246,
    },
    "linux-arm64": {
      url: "https://downloads.cursor.com/lab/2026.11.11-b912975/linux/arm64/agent-cli-package.tar.gz",
      sha256: "f068af64ed91b5304605976586f690579679f740a41f388091a6b3a2e776987c",
      bytes: 175384019,
      unpackedBytes: 552211752,
    },
    "darwin-x64": {
      url: "https://downloads.cursor.com/lab/2026.11.11-b912975/darwin/x64/agent-cli-package.tar.gz",
      sha256: "38578cf7f2a7c67679cffaf95818b58fa3e21ff95f8883ad0af012b5d5460489",
      bytes: 182777324,
      unpackedBytes: 631059528,
    },
    "darwin-arm64": {
      url: "https://downloads.cursor.com/lab/2026.11.11-b912975/darwin/arm64/agent-cli-package.tar.gz",
      sha256: "2c60b58fb7d9a54c7cb9460f0cbb10d451d4af025d4451f252e5f1d956f8c66f",
      bytes: 175088185,
      unpackedBytes: 617644214,
    },
  },
  stripComponents: 1,
  launcher: "cursor-agent",
  docsUrl: "https://github.com/xtimor/openclaw-all-cli/blob/main/docs/setup.md#install-the-requirements",
};
