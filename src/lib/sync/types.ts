/** Sync diff types */
export interface SyncChange {
  type: 'added' | 'modified' | 'deleted';
  pageId: string;
  title: string;
  localPath?: string;
}

export interface SyncDiff {
  added: SyncChange[];
  modified: SyncChange[];
  deleted: SyncChange[];
}

/**
 * Progress reporter for sync operations
 */
export interface SyncProgressReporter {
  onFetchStart?: () => void;
  onFetchComplete?: (pageCount: number, folderCount: number) => void;
  onDiffComplete?: (added: number, modified: number, deleted: number) => void;
  onPageStart?: (index: number, total: number, title: string, type: 'added' | 'modified' | 'deleted') => void;
  onPageComplete?: (index: number, total: number, title: string, localPath: string) => void;
  onPageError?: (title: string, error: string) => void;
}

export interface SyncOptions {
  dryRun?: boolean;
  force?: boolean;
  forcePages?: string[]; // Page IDs or local paths to force resync
  depth?: number;
  progress?: SyncProgressReporter;
  signal?: { cancelled: boolean };
}

export interface SyncResult {
  success: boolean;
  changes: SyncDiff;
  warnings: string[];
  errors: string[];
  cancelled?: boolean;
}
