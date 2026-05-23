export interface VaultFile {
  path: string;       // relative path, e.g. "projects/SILENTMANE/BUILD.md"
  content: string;
  updatedAt: string;  // ISO 8601
}

export interface VaultStorage {
  /** List all .md files, optionally filtered to a path prefix. */
  list(prefix?: string): Promise<VaultFile[]>;
  /**
   * Metadata-only list (path + updatedAt, no body). Cheaper than `list()`
   * for cloud — pulls from the vault_files cache instead of recursing
   * Storage. Use this whenever the caller doesn't need bodies (change
   * polling, summary endpoints). Returns the same VaultFile shape with
   * `content: ""` for compat.
   *
   * SPRINT-024 Phase 2.
   */
  listMeta(prefix?: string): Promise<VaultFile[]>;
  /**
   * Bulk-read every .md file under `prefix` in one shot. Implementations
   * are encouraged to use a single round-trip — SupabaseStorage hits the
   * vault_files Postgres cache so /api/index doesn't pay per-file HTTPS.
   * FilesystemStorage just reads from disk.
   */
  listWithContent(prefix?: string): Promise<VaultFile[]>;
  /** Read a single file. Returns null if not found. */
  read(path: string): Promise<string | null>;
  /** Write (create or overwrite) a file. */
  write(path: string, content: string): Promise<void>;
  /** Delete a file. No-op if not found. */
  delete(path: string): Promise<void>;
  /** Returns true if a file exists at path. */
  exists(path: string): Promise<boolean>;
}
