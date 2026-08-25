import type { ToolPackage } from '@gtm/mcp-runtime/types';
import { kbArticlesPackage } from './kb_articles/mcp-tools';

// Support-domain tool packages: the knowledge tools search the published docs
// site through the Mintlify discovery index. No local corpus, no fallback.
export const supportPackages: ToolPackage[] = [kbArticlesPackage];

// The retrieval functions themselves, for the kb-eval golden suite (tests/):
// it calls the exact code the worker's localHandler runs, minus transport.
export {
  asMintlifyExtension,
  contentHash,
  fetchArticleMd,
  searchKbMintlify,
} from './kb_articles/mintlify-retriever';
export type { KbHit, KbHitIoMeta, KbSearchIo } from './kb_articles/mintlify-retriever';
