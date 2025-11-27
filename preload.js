const { contextBridge, ipcRenderer } = require("electron")

// Exponer APIs seguras a la ventana del navegador
contextBridge.exposeInMainWorld("electron", {
  // Funciones del sistema de archivos
  fileSystem: {
    createDirectory: (dirPath) => ipcRenderer.invoke("create-directory", dirPath),
    selectDirectory: () => ipcRenderer.invoke("select-directory"),
    downloadFile: (url, filePath, headers = {}) => ipcRenderer.invoke("download-file", { url, filePath, headers }),
    saveFile: (content, filePath) => ipcRenderer.invoke("save-file", { content, filePath }),
    deleteFile: (filePath) => ipcRenderer.invoke("delete-file", filePath),
    cancelAllDownloads: () => ipcRenderer.invoke("cancel-all-downloads"),
    existsSync: (filePath) => ipcRenderer.invoke('fileSystem:existsSync', filePath),
    getFileSize: (filePath) => ipcRenderer.invoke('fileSystem:getFileSize', filePath),
    readFile: (filePath) => ipcRenderer.invoke('fileSystem:readFile', filePath),
    getHomePath: () => ipcRenderer.invoke('fileSystem:getHomePath'),
  },
  // Funciones de base de datos
  db: {
    logRequest: (params) => ipcRenderer.invoke('db:logRequest', params),
    getRequestCountsSince: (sinceMs) => ipcRenderer.invoke('db:getRequestCountsSince', sinceMs),
    getRateLimitStatus: (rateType) => ipcRenderer.invoke('db:getRateLimitStatus', rateType),
    saveRateLimitStatus: (params) => ipcRenderer.invoke('db:saveRateLimitStatus', params),
    getRateLimitStatusFromDb: (rateType) => ipcRenderer.invoke('db:getRateLimitStatusFromDb', rateType),
    clearRateLimitStatus: (rateType) => ipcRenderer.invoke('db:clearRateLimitStatus', rateType),
    clearExpiredRateLimits: () => ipcRenderer.invoke('db:clearExpiredRateLimits'),
    clearAuthenticationRequests: () => ipcRenderer.invoke('db:clearAuthenticationRequests'),
    clearRecentRequests: () => ipcRenderer.invoke('db:clearRecentRequests'),
    clearAllRateLimits: () => ipcRenderer.invoke('db:clearAllRateLimits'),
    beginScan: (params) => ipcRenderer.invoke('db:beginScan', params),
    addApp: (scanId, params) => ipcRenderer.invoke('db:addApp', scanId, params),
    addItem: (scanId, appId, itemId) => ipcRenderer.invoke('db:addItem', scanId, appId, itemId),
    addFile: (scanId, params) => ipcRenderer.invoke('db:addFile', scanId, params),
    addFilesBulk: (scanId, files) => ipcRenderer.invoke('db:addFilesBulk', scanId, files),
    finalizeScan: (scanId, summary) => ipcRenderer.invoke('db:finalizeScan', scanId, summary),
    getLastScan: () => ipcRenderer.invoke('db:getLastScan'),
    getLastScanApps: () => ipcRenderer.invoke('db:getLastScanApps'),
    getLastScanFiles: () => ipcRenderer.invoke('db:getLastScanFiles'),
    getLastScanItemsCount: () => ipcRenderer.invoke('db:getLastScanItemsCount'),
    // Scan checkpoints
    saveScanCheckpoint: (scanId, checkpoint) => ipcRenderer.invoke('db:saveScanCheckpoint', scanId, checkpoint),
    getScanCheckpoint: (scanId) => ipcRenderer.invoke('db:getScanCheckpoint', scanId),
    markScanAsCancelled: (scanId) => ipcRenderer.invoke('db:markScanAsCancelled', scanId),
    // Download checkpoints
    addDownloadCheckpoint: (params) => ipcRenderer.invoke('db:addDownloadCheckpoint', params),
    updateDownloadStatus: (params) => ipcRenderer.invoke('db:updateDownloadStatus', params),
    isDownloadDone: (fileId, scanId) => ipcRenderer.invoke('db:isDownloadDone', fileId, scanId),
    getPendingDownloads: (scanId) => ipcRenderer.invoke('db:getPendingDownloads', scanId),
    getFailedDownloads: (scanId, maxTries) => ipcRenderer.invoke('db:getFailedDownloads', scanId, maxTries),
    getDownloadInfo: (fileId, scanId) => ipcRenderer.invoke('db:getDownloadInfo', fileId, scanId),
    getDownloadStats: (scanId) => ipcRenderer.invoke('db:getDownloadStats', scanId),
    hasIncompleteBackup: () => ipcRenderer.invoke('db:hasIncompleteBackup'),
    getScanStatus: (scanId) => ipcRenderer.invoke('db:getScanStatus', scanId),
    // Funciones para ver detalles de backups
    getScanByPodioItemId: (podioItemId) => ipcRenderer.invoke('db:getScanByPodioItemId', podioItemId),
    getScanAppsByScanId: (scanId) => ipcRenderer.invoke('db:getScanAppsByScanId', scanId),
    getScanFilesByScanId: (scanId) => ipcRenderer.invoke('db:getScanFilesByScanId', scanId),
    checkDownloadUrls: (scanId) => ipcRenderer.invoke('db:checkDownloadUrls', scanId),
    // Funciones de caché API
    getApiCache: (endpoint) => ipcRenderer.invoke('db:getApiCache', endpoint),
    setApiCache: (endpoint, data, ttlMs) => ipcRenderer.invoke('db:setApiCache', endpoint, data, ttlMs),
    clearExpiredApiCache: () => ipcRenderer.invoke('db:clearExpiredApiCache'),
    // Historial local de backups
    getLocalBackupHistory: (limit) => ipcRenderer.invoke('db:getLocalBackupHistory', limit),
    clearAllData: () => ipcRenderer.invoke('db:clearAllData'),
    clearBackupHistory: () => ipcRenderer.invoke('db:clearBackupHistory'),
  },
  // Funciones de logging
  log: {
    write: (level, message) => ipcRenderer.invoke('log:write', level, message),
    getLogsDirectory: () => ipcRenderer.invoke('log:getLogsDirectory'),
    getLogFilePath: () => ipcRenderer.invoke('log:getLogFilePath'),
  },
  // Información del entorno
  isElectron: true,
})
