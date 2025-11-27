interface ElectronAPI {
  fileSystem: {
    createDirectory: (dirPath: string) => Promise<{ success: boolean; path?: string; error?: string }>
    selectDirectory: () => Promise<{ canceled: boolean; filePath?: string; error?: string }>
    downloadFile: (url: string, filePath: string, headers?: Record<string, string>) => Promise<{ success: boolean; path?: string; error?: string }>
    saveFile: (content: string, filePath: string) => Promise<{ success: boolean; path?: string; error?: string }>
    deleteFile: (filePath: string) => Promise<{ success: boolean; path?: string; error?: string }>
    cancelAllDownloads: () => Promise<{ success: boolean; message?: string; error?: string }>
    existsSync: (filePath: string) => Promise<boolean>
    getFileSize: (filePath: string) => Promise<number>
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
    getHomePath: () => Promise<string | null>
  }
  db: {
    logRequest: (params: { method: string; endpoint: string; rate_type: 'general' | 'rateLimited'; status?: number; bytes?: number; meta?: any }) => Promise<{ success: boolean; error?: string }>
    getRequestCountsSince: (sinceMs: number) => Promise<{ general: number; rateLimited: number }>
    getRateLimitStatus: (rateType: 'general' | 'rateLimited') => Promise<{ used: number; remaining: number; limit: number; resetAtMs: number | null; resetInSeconds: number | null }>
    saveRateLimitStatus: (params: { rate_type: 'general' | 'rateLimited'; triggered_at_ms: number; requests_used: number; limit_value: number }) => Promise<{ success: boolean; error?: string }>
    getRateLimitStatusFromDb: (rateType: 'general' | 'rateLimited') => Promise<{ active: boolean; triggeredAtMs: number | null; resetAtMs: number | null; resetInSeconds: number | null; requestsUsed: number | null; limitValue: number | null }>
    clearRateLimitStatus: (rateType: 'general' | 'rateLimited') => Promise<{ success: boolean; error?: string }>
    clearAuthenticationRequests: () => Promise<{ success: boolean; cleared: number; error?: string }>
    clearRecentRequests: () => Promise<{ success: boolean; cleared: number; error?: string }>
    clearAllRateLimits: () => Promise<{ success: boolean; cleared: number; error?: string }>
    beginScan: (params: { user?: string; org_id?: number; podio_backup_item_id?: number; title?: string }) => Promise<{ success: boolean; scanId?: number; error?: string }>
    addApp: (scanId: number, params: { org_name: string; space_id: number; space_name: string; app_id: number; app_name: string; folder_path: string }) => Promise<{ success: boolean; error?: string }>
    addItem: (scanId: number, appId: number, itemId: number) => Promise<{ success: boolean; error?: string }>
    addFile: (scanId: number, params: { app_id: number; item_id?: number; file_id: number; name: string; size?: number; mimetype?: string; download_url: string; folder_path: string }) => Promise<{ success: boolean; error?: string }>
    addFilesBulk: (scanId: number, files: Array<{ app_id: number; item_id?: number; file_id: number; name: string; size?: number; mimetype?: string; download_url: string; folder_path: string }>) => Promise<{ success: boolean; error?: string }>
    finalizeScan: (scanId: number, summary: { organizations: number; workspaces: number; applications: number; items: number; files: number; backupSize: number }) => Promise<{ success: boolean; error?: string }>
    getLastScan: () => Promise<any | null>
    getLastScanApps: () => Promise<any[]>
    getLastScanFiles: () => Promise<any[]>
    getLastScanItemsCount: () => Promise<number>
    // Scan checkpoints
    saveScanCheckpoint: (scanId: number, checkpoint: { orgIndex: number; orgTotal: number; workspaceIndex: number; workspaceTotal: number; appIndex: number; appTotal: number; workspacesCounted: boolean; appsCounted: boolean }) => Promise<{ success: boolean; error?: string }>
    getScanCheckpoint: (scanId: number) => Promise<{ orgIndex: number; orgTotal: number; workspaceIndex: number; workspaceTotal: number; appIndex: number; appTotal: number; workspacesCounted: boolean; appsCounted: boolean } | null>
    markScanAsCancelled: (scanId: number) => Promise<{ success: boolean; error?: string }>
    // Download checkpoints
    addDownloadCheckpoint: (params: { scan_id: number; file_id: number; app_id: number; item_id?: number; path: string; size?: number }) => Promise<{ success: boolean; error?: string }>
    updateDownloadStatus: (params: { file_id: number; scan_id: number; status: 'pending' | 'done' | 'error'; size?: number; error?: string }) => Promise<{ success: boolean; error?: string }>
    isDownloadDone: (fileId: number, scanId: number) => Promise<boolean>
    getPendingDownloads: (scanId: number) => Promise<any[]>
    getFailedDownloads: (scanId: number, maxTries?: number) => Promise<any[]>
    getDownloadInfo: (fileId: number, scanId: number) => Promise<any | null>
    getDownloadStats: (scanId: number) => Promise<{ total: number; done: number; pending: number; error: number }>
    hasIncompleteBackup: () => Promise<{ hasIncomplete: boolean; scanId: number | null; scanDate: number | null; stats: { total: number; done: number; pending: number; error: number } | null }>
    getScanStatus: (scanId: number) => Promise<{ scan: any | null; stats: { total: number; done: number; pending: number; error: number }; apps: any[] }>
    // Funciones para ver detalles de backups
    getScanByPodioItemId: (podioItemId: number) => Promise<any | null>
    getScanAppsByScanId: (scanId: number) => Promise<any[]>
    getScanFilesByScanId: (scanId: number) => Promise<any[]>
    checkDownloadUrls: (scanId: number) => Promise<{ success: boolean; total?: number; withUrl?: number; withoutUrl?: number; apiUrls?: number; sample?: Array<{ file_id: number; name: string; has_url: boolean; url_preview: string; size: number; item_id: number | null }>; error?: string }>
    // Funciones de caché API
    getApiCache: (endpoint: string) => Promise<any | null>
    setApiCache: (endpoint: string, data: any, ttlMs?: number) => Promise<{ success: boolean; error?: string }>
    clearExpiredApiCache: () => Promise<{ success: boolean; error?: string }>
    // Historial local de backups
    getLocalBackupHistory: (limit?: number) => Promise<{ success: boolean; data: any[]; error?: string }>
    clearAllData: () => Promise<{ success: boolean; message?: string; error?: string }>
    clearBackupHistory: () => Promise<{ success: boolean; message?: string; error?: string }>
  }
  // Funciones de logging
  log: {
    write: (level: string, message: string) => Promise<{ success: boolean; error?: string }>
    getLogsDirectory: () => Promise<{ success: boolean; path?: string; error?: string }>
    getLogFilePath: () => Promise<{ success: boolean; path?: string; error?: string }>
  }
  isElectron: boolean
}

interface Window {
  electron: ElectronAPI
}
