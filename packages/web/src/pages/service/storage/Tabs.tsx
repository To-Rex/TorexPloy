/** Route components for the file store's own tabs (they read the service from the layout). */
import { useServiceContext } from '../ServiceLayout.tsx';
import { StorageDocsTab } from './StorageDocs.tsx';
import { StorageDomainsTab } from './StorageDomains.tsx';
import { StorageFilesTab } from './StorageFiles.tsx';
import { StorageKeysTab } from './StorageKeys.tsx';

export function FilesTab() {
  return <StorageFilesTab service={useServiceContext()} />;
}
export function KeysTab() {
  return <StorageKeysTab service={useServiceContext()} />;
}
export function DomainsTab() {
  return <StorageDomainsTab service={useServiceContext()} />;
}
export function DocsTab() {
  return <StorageDocsTab service={useServiceContext()} />;
}
