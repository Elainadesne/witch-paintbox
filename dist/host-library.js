import { initializeAnchorHostStorage } from './anchor-store.js';
import { initializeWorldbookHostStorage } from './worldbook-source.js';
/** Migrates validated local libraries once; existing native manifests remain authoritative. */
export async function initializeNativeLibraries() {
    await Promise.all([initializeAnchorHostStorage(), initializeWorldbookHostStorage()]);
}
