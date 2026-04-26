// Public exports for @supermemory/bash.
// Populated as milestones B2-B6 land.
export { sgrepCommand } from "./commands/sgrep.js";
export { SupermemoryFs } from "./supermemory-fs.js";
export type {
  DocResult,
  DocStat,
  DocStatus,
  DocSummary,
  ListByPrefixOpts,
  RemoveByPrefixResult,
  SearchParams,
  SearchResp,
  SearchResult,
} from "./volume.js";
export { SupermemoryVolume } from "./volume.js";
