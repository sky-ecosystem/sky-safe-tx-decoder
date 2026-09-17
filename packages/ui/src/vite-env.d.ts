/// <reference types="vite/client" />

interface ImportMetaEnv {
  // No app configuration is baked in at build time. The hosted copy must be
  // byte-identical to the released artifact, so the remote address book URL is
  // read at run time from /sky-safe-config.json instead.
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
