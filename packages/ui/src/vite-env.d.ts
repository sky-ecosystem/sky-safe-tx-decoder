/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Default URL for the remote address book. Baked in at build time so the
   * hosted copy behind the auth proxy ships pointing at its own service; the
   * signer can still change or clear it for the session on the Settings page.
   */
  readonly VITE_REMOTE_ADDRESS_BOOK_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
