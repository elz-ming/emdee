import type { VaultStorage } from "../../storage/VaultStorage";

export type ToolContext =
  | { mode: "local"; docsDir: string }
  | { mode: "cloud"; storage: VaultStorage; userId: string };

export type { DocIndex, DocNode, Link } from "../../../core/indexer";
