const Database = require('better-sqlite3')
const path = require('path')
const { app } = require('electron')
const fs = require('fs')

let db: any = null

function getDbPath(): string {
  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'podio-backup.db')
  return dbPath
}

function initDb(): void {
  if (db) return

  const dbPath = getDbPath()
  
  // Crear directorio si no existe
  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  
  // Crear tablas si no existen
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      method TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      rate_type TEXT CHECK(rate_type IN ('general','rateLimited')) NOT NULL,
      status INTEGER,
      bytes INTEGER,
      meta TEXT
    );

    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      user TEXT,
      org_id INTEGER,
      podio_backup_item_id INTEGER,
      title TEXT,
      summary TEXT,
      checkpoint TEXT,
      cancelled BOOLEAN DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS scan_apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL,
      org_name TEXT NOT NULL,
      space_id INTEGER NOT NULL,
      space_name TEXT NOT NULL,
      app_id INTEGER NOT NULL,
      app_name TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scan_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      item_id INTEGER,
      file_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      size INTEGER,
      mimetype TEXT,
      download_url TEXT NOT NULL,
      folder_path TEXT NOT NULL,
      FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL,
      file_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL,
      item_id INTEGER,
      path TEXT NOT NULL,
      size INTEGER,
      status TEXT CHECK(status IN ('pending','done','error')) NOT NULL DEFAULT 'pending',
      last_try_ms INTEGER,
      tries INTEGER DEFAULT 0,
      FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS rate_limit_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rate_type TEXT CHECK(rate_type IN ('general','rateLimited')) NOT NULL UNIQUE,
      triggered_at_ms INTEGER NOT NULL,
      reset_at_ms INTEGER NOT NULL,
      requests_used INTEGER NOT NULL,
      limit_value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_cache (
      endpoint TEXT PRIMARY KEY,
      response_data TEXT NOT NULL,
      cached_at_ms INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts_ms);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_type ON rate_limit_status(rate_type);
    CREATE INDEX IF NOT EXISTS idx_requests_rate_type ON requests(rate_type, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_scan_apps_scan ON scan_apps(scan_id);
    CREATE INDEX IF NOT EXISTS idx_scan_items_scan ON scan_items(scan_id);
    CREATE INDEX IF NOT EXISTS idx_scan_files_scan ON scan_files(scan_id);
    CREATE INDEX IF NOT EXISTS idx_downloads_scan ON downloads(scan_id);
    CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
    CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at_ms);
  `)
}

function getDb() {
  if (!db) initDb()
  return db
}

// Log de request a la API
function logRequest(params: {
  method: string
  endpoint: string
  rate_type: 'general' | 'rateLimited'
  status?: number
  bytes?: number
  meta?: any
}): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO requests (ts_ms, method, endpoint, rate_type, status, bytes, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      params.method,
      params.endpoint,
      params.rate_type,
      params.status || null,
      params.bytes || null,
      params.meta ? JSON.stringify(params.meta) : null
    )
  } catch (error) {
    console.error('Error logging request to DB:', error)
  }
}

// Obtener conteo de requests desde un timestamp
function getRequestCountsSince(sinceMs: number): { general: number; rateLimited: number } {
  try {
    const db = getDb()
    const general = db.prepare(`
      SELECT COUNT(*) as count FROM requests
      WHERE rate_type = 'general' AND ts_ms >= ?
    `).get(sinceMs) as { count: number }
    
    const rateLimited = db.prepare(`
      SELECT COUNT(*) as count FROM requests
      WHERE rate_type = 'rateLimited' AND ts_ms >= ?
    `).get(sinceMs) as { count: number }
    
    return {
      general: general?.count || 0,
      rateLimited: rateLimited?.count || 0
    }
  } catch (error) {
    console.error('Error getting request counts:', error)
    return { general: 0, rateLimited: 0 }
  }
}

// Obtener el primer request de la ventana de 1 hora para calcular cuándo se resetea
// Se basa en el primer request de la hora + 1 hora (ventana deslizante)
function getFirstRequestInHourWindow(rateType: 'general' | 'rateLimited'): number | null {
  try {
    const db = getDb()
    const oneHourAgo = Date.now() - (60 * 60 * 1000)
    
    const result = db.prepare(`
      SELECT MIN(ts_ms) as first_ts FROM requests
      WHERE rate_type = ? AND ts_ms >= ?
    `).get(rateType, oneHourAgo) as { first_ts: number | null }
    
    return result?.first_ts || null
  } catch (error) {
    console.error('Error getting first request in hour window:', error)
    return null
  }
}

// Calcular límites remanentes y cuándo se resetea la hora
function getRateLimitStatus(rateType: 'general' | 'rateLimited'): {
  used: number
  remaining: number
  limit: number
  resetAtMs: number | null
  resetInSeconds: number | null
  dailyUsed?: number
  dailyLimit?: number
  dailyRemaining?: number
} {
  // Unified limit: both general and rateLimited share the same limit now
  const RATE_LIMIT_HOUR = 5000
  const RATE_LIMIT_DAY = 60000
  const limits = {
    general: RATE_LIMIT_HOUR,
    rateLimited: RATE_LIMIT_HOUR
  }
  
  try {
    const db = getDb()
    const oneHourAgo = Date.now() - (60 * 60 * 1000)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000)
    
    // Contar requests en la última hora
    const used = db.prepare(`
      SELECT COUNT(*) as count FROM requests
      WHERE rate_type = ? AND ts_ms >= ?
    `).get(rateType, oneHourAgo) as { count: number }
    
    // Contar requests en las últimas 24 horas
    const dailyUsed = db.prepare(`
      SELECT COUNT(*) as count FROM requests
      WHERE rate_type = ? AND ts_ms >= ?
    `).get(rateType, oneDayAgo) as { count: number }
    
    const usedCount = used?.count || 0
    const dailyUsedCount = dailyUsed?.count || 0
    const limit = limits[rateType]
    const remaining = Math.max(0, limit - usedCount)
    const dailyRemaining = Math.max(0, RATE_LIMIT_DAY - dailyUsedCount)
    
    // Obtener el primer request de la ventana de 1 hora (para calcular reset desde la primera petición)
    const firstRequest = getFirstRequestInHourWindow(rateType)
    let resetAtMs: number | null = null
    let resetInSeconds: number | null = null
    
    if (firstRequest) {
      // El reset es 1 hora después del PRIMER request de la ventana
      resetAtMs = firstRequest + (60 * 60 * 1000)
      resetInSeconds = Math.max(0, Math.ceil((resetAtMs - Date.now()) / 1000))
      
      // Si ya pasó la hora, el reset es ahora
      if (resetInSeconds <= 0) {
        resetAtMs = Date.now()
        resetInSeconds = 0
      }
    }
    
    return {
      used: usedCount,
      remaining,
      limit,
      resetAtMs,
      resetInSeconds,
      dailyUsed: dailyUsedCount,
      dailyLimit: RATE_LIMIT_DAY,
      dailyRemaining
    }
  } catch (error) {
    console.error('Error getting rate limit status:', error)
    return {
      used: 0,
      remaining: limits[rateType],
      limit: limits[rateType],
      resetAtMs: null,
      resetInSeconds: null,
      dailyUsed: 0,
      dailyLimit: RATE_LIMIT_DAY,
      dailyRemaining: RATE_LIMIT_DAY
    }
  }
}

// Guardar estado de rate limit cuando ocurre un error
// Usa el primer request de la hora para calcular el reset (no el último)
function saveRateLimitStatus(params: {
  rate_type: 'general' | 'rateLimited'
  triggered_at_ms: number
  requests_used: number
  limit_value: number
}): void {
  try {
    const db = getDb()
    // Obtener el primer request de la ventana de 1 hora para calcular reset desde ahí
    const firstRequest = getFirstRequestInHourWindow(params.rate_type)
    // Si hay un primer request, usar ese para calcular el reset. Si no, usar el triggered_at_ms
    const resetAtMs = firstRequest 
      ? firstRequest + (60 * 60 * 1000) // 1 hora después del primer request
      : params.triggered_at_ms + (60 * 60 * 1000) // Fallback: 1 hora después del trigger
    
    db.prepare(`
      INSERT INTO rate_limit_status (rate_type, triggered_at_ms, reset_at_ms, requests_used, limit_value)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(rate_type) DO UPDATE SET
        triggered_at_ms = excluded.triggered_at_ms,
        reset_at_ms = excluded.reset_at_ms,
        requests_used = excluded.requests_used,
        limit_value = excluded.limit_value
    `).run(
      params.rate_type,
      params.triggered_at_ms,
      resetAtMs,
      params.requests_used,
      params.limit_value
    )
  } catch (error) {
    console.error('Error saving rate limit status:', error)
  }
}

// Obtener estado persistente de rate limit
function getRateLimitStatusFromDb(rateType: 'general' | 'rateLimited'): {
  active: boolean
  triggeredAtMs: number | null
  resetAtMs: number | null
  resetInSeconds: number | null
  requestsUsed: number | null
  limitValue: number | null
} {
  // CRÍTICO: Limpiar rate limits expirados ANTES de consultar
  clearExpiredRateLimits()
  try {
    const db = getDb()
    const now = Date.now()
    
    const result = db.prepare(`
      SELECT * FROM rate_limit_status
      WHERE rate_type = ? AND reset_at_ms > ?
    `).get(rateType, now) as any
    
    if (!result) {
      return {
        active: false,
        triggeredAtMs: null,
        resetAtMs: null,
        resetInSeconds: null,
        requestsUsed: null,
        limitValue: null
      }
    }
    
    const resetInSeconds = Math.max(0, Math.ceil((result.reset_at_ms - now) / 1000))
    
    return {
      active: resetInSeconds > 0,
      triggeredAtMs: result.triggered_at_ms,
      resetAtMs: result.reset_at_ms,
      resetInSeconds,
      requestsUsed: result.requests_used,
      limitValue: result.limit_value
    }
  } catch (error) {
    console.error('Error getting rate limit status from DB:', error)
    return {
      active: false,
      triggeredAtMs: null,
      resetAtMs: null,
      resetInSeconds: null,
      requestsUsed: null,
      limitValue: null
    }
  }
}

// Limpiar estados de rate limit expirados
function clearExpiredRateLimits(): void {
  try {
    const db = getDb()
    const now = Date.now()
    const result = db.prepare(`
      DELETE FROM rate_limit_status WHERE reset_at_ms <= ?
    `).run(now)
    if (result.changes > 0) {
      console.log(`Cleared ${result.changes} expired rate limit status records`)
    }
  } catch (error) {
    console.error('Error clearing expired rate limits:', error)
  }
}

// Limpiar rate limit específico (forzar reintento)
function clearRateLimitStatus(rateType: 'general' | 'rateLimited'): void {
  try {
    const db = getDb()
    const result = db.prepare(`
      DELETE FROM rate_limit_status WHERE rate_type = ?
    `).run(rateType)
    if (result.changes > 0) {
      console.log(`Cleared rate limit status for type: ${rateType}`)
    }
  } catch (error) {
    console.error(`Error clearing rate limit status for ${rateType}:`, error)
  }
}

/**
 * Limpiar TODAS las peticiones de autenticación (POST /oauth/token) de la BD
 * Esto resetea nuestro contador interno de peticiones de autenticación
 * ÚTIL cuando el servidor de Podio tiene un rate limit activo
 */
function clearAuthenticationRequests(): { success: boolean; cleared: number; error?: string } {
  try {
    const db = getDb()
    const result = db.prepare(`
      DELETE FROM requests 
      WHERE endpoint = '/oauth/token' AND method = 'POST'
    `).run()
    
    if (result.changes > 0) {
      console.log(`✅ Limpiadas ${result.changes} peticiones de autenticación de la BD`)
    }
    
    // También limpiar el estado de rate limit para rateLimited
    clearRateLimitStatus('rateLimited')
    
    return { success: true, cleared: result.changes }
  } catch (error) {
    console.error('❌ Error limpiando peticiones de autenticación:', error)
    return { success: false, cleared: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Limpiar TODAS las peticiones de la última hora
 * Útil para resetear contadores cuando hay rate limit del servidor
 */
function clearRecentRequests(): { success: boolean; cleared: number; error?: string } {
  try {
    const db = getDb()
    const oneHourAgo = Date.now() - (60 * 60 * 1000)
    const result = db.prepare(`
      DELETE FROM requests WHERE ts_ms >= ?
    `).run(oneHourAgo)
    
    if (result.changes > 0) {
      console.log(`✅ Limpiadas ${result.changes} peticiones recientes (última hora) de la BD`)
    }
    
    // Limpiar todos los estados de rate limit
    clearRateLimitStatus('general')
    clearRateLimitStatus('rateLimited')
    
    return { success: true, cleared: result.changes }
  } catch (error) {
    console.error('❌ Error limpiando peticiones recientes:', error)
    return { success: false, cleared: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

// ==================== FUNCIONES DE CACHÉ API ====================

// Obtener respuesta de API desde caché de BD
function getApiCache(endpoint: string): any | null {
  try {
    const db = getDb()
    const now = Date.now()
    
    const result = db.prepare(`
      SELECT response_data, expires_at_ms FROM api_cache
      WHERE endpoint = ? AND expires_at_ms > ?
    `).get(endpoint, now) as { response_data: string; expires_at_ms: number } | undefined
    
    if (result) {
      return JSON.parse(result.response_data)
    }
    return null
  } catch (error) {
    console.error('Error getting API cache from DB:', error)
    return null
  }
}

// Guardar respuesta de API en caché de BD
function setApiCache(endpoint: string, data: any, ttlMs: number = 3600000): void {
  try {
    const db = getDb()
    const now = Date.now()
    const expiresAt = now + ttlMs
    
    db.prepare(`
      INSERT OR REPLACE INTO api_cache (endpoint, response_data, cached_at_ms, ttl_ms, expires_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      endpoint,
      JSON.stringify(data),
      now,
      ttlMs,
      expiresAt
    )
  } catch (error) {
    console.error('Error setting API cache in DB:', error)
  }
}

// Limpiar caché expirado
function clearExpiredApiCache(): void {
  try {
    const db = getDb()
    const now = Date.now()
    const result = db.prepare(`
      DELETE FROM api_cache WHERE expires_at_ms <= ?
    `).run(now)
    if (result.changes > 0) {
      console.log(`Cleared ${result.changes} expired API cache entries`)
    }
  } catch (error) {
    console.error('Error clearing expired API cache:', error)
  }
}

// Iniciar un nuevo escaneo
function beginScan(params: {
  user?: string
  org_id?: number
  podio_backup_item_id?: number
  title?: string
}): number {
  try {
    const db = getDb()
    const result = db.prepare(`
      INSERT INTO scans (created_at_ms, user, org_id, podio_backup_item_id, title)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      params.user || null,
      params.org_id || null,
      params.podio_backup_item_id || null,
      params.title || null
    )
    return result.lastInsertRowid as number
  } catch (error) {
    console.error('Error beginning scan:', error)
    throw error
  }
}

// Agregar app al escaneo
function addApp(scanId: number, params: {
  org_name: string
  space_id: number
  space_name: string
  app_id: number
  app_name: string
  folder_path: string
}): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO scan_apps (scan_id, org_name, space_id, space_name, app_id, app_name, folder_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      scanId,
      params.org_name,
      params.space_id,
      params.space_name,
      params.app_id,
      params.app_name,
      params.folder_path
    )
  } catch (error) {
    console.error('Error adding app to scan:', error)
  }
}

// Agregar item al escaneo
function addItem(scanId: number, appId: number, itemId: number): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO scan_items (scan_id, app_id, item_id)
      VALUES (?, ?, ?)
    `).run(scanId, appId, itemId)
  } catch (error) {
    console.error('Error adding item to scan:', error)
  }
}

// Agregar archivo al escaneo (individual)
function addFile(scanId: number, params: {
  app_id: number
  item_id?: number
  file_id: number
  name: string
  size?: number
  mimetype?: string
  download_url: string
  folder_path: string
}): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT INTO scan_files (scan_id, app_id, item_id, file_id, name, size, mimetype, download_url, folder_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scanId,
      params.app_id,
      params.item_id || null,
      params.file_id,
      params.name,
      params.size || null,
      params.mimetype || null,
      params.download_url,
      params.folder_path
    )
  } catch (error) {
    console.error('Error adding file to scan:', error)
  }
}

// Agregar múltiples archivos en batch
function addFilesBulk(scanId: number, files: Array<{
  app_id: number
  item_id?: number
  file_id: number
  name: string
  size?: number
  mimetype?: string
  download_url: string
  folder_path: string
}>): void {
  if (files.length === 0) return
  
  try {
    const db = getDb()
    const stmt = db.prepare(`
      INSERT INTO scan_files (scan_id, app_id, item_id, file_id, name, size, mimetype, download_url, folder_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    
    const insertMany = db.transaction((filesToInsert: Array<{
      app_id: number
      item_id?: number
      file_id: number
      name: string
      size?: number
      mimetype?: string
      download_url: string
      folder_path: string
    }>) => {
      for (const file of filesToInsert) {
        stmt.run(
          scanId,
          file.app_id,
          file.item_id || null,
          file.file_id,
          file.name,
          file.size || null,
          file.mimetype || null,
          file.download_url,
          file.folder_path
        )
      }
    })
    
    insertMany(files)
  } catch (error) {
    console.error('Error adding files bulk to scan:', error)
  }
}

// Finalizar escaneo con resumen
function finalizeScan(scanId: number, summary: {
  organizations: number
  workspaces: number
  applications: number
  items: number
  files: number
  backupSize: number
}): void {
  try {
    const db = getDb()
    db.prepare(`
      UPDATE scans SET summary = ? WHERE id = ?
    `).run(JSON.stringify(summary), scanId)
  } catch (error) {
    console.error('Error finalizing scan:', error)
  }
}

// Obtener último escaneo
function getLastScan(): any {
  try {
    const db = getDb()
    const scan = db.prepare(`
      SELECT * FROM scans ORDER BY created_at_ms DESC LIMIT 1
    `).get() as any
    
    if (!scan) return null
    
    return {
      ...scan,
      summary: scan.summary ? JSON.parse(scan.summary) : null
    }
  } catch (error) {
    console.error('Error getting last scan:', error)
    return null
  }
}

// Obtener apps del último escaneo
function getLastScanApps(): any[] {
  try {
    const db = getDb()
    const lastScan = getLastScan()
    if (!lastScan) return []
    
    return db.prepare(`
      SELECT * FROM scan_apps WHERE scan_id = ?
    `).all(lastScan.id) as any[]
  } catch (error) {
    console.error('Error getting last scan apps:', error)
    return []
  }
}

// Obtener archivos del último escaneo
function getLastScanFiles(): any[] {
  try {
    const db = getDb()
    const lastScan = getLastScan()
    if (!lastScan) return []
    
    return db.prepare(`
      SELECT * FROM scan_files WHERE scan_id = ?
    `).all(lastScan.id) as any[]
  } catch (error) {
    console.error('Error getting last scan files:', error)
    return []
  }
}

// Obtener count de items del último escaneo
function getLastScanItemsCount(): number {
  try {
    const db = getDb()
    const lastScan = getLastScan()
    if (!lastScan) return 0
    
    const result = db.prepare(`
      SELECT COUNT(DISTINCT item_id) as count FROM scan_items WHERE scan_id = ?
    `).get(lastScan.id) as { count: number }
    
    return result?.count || 0
  } catch (error) {
    console.error('Error getting last scan items count:', error)
    return 0
  }
}

// ========== SCAN CHECKPOINTS ==========

// Guardar checkpoint de escaneo (org, workspace, app)
function saveScanCheckpoint(scanId: number, checkpoint: {
  orgIndex: number
  orgTotal: number
  workspaceIndex: number
  workspaceTotal: number
  appIndex: number
  appTotal: number
  workspacesCounted: boolean
  appsCounted: boolean
}): void {
  try {
    const db = getDb()
    db.prepare(`
      UPDATE scans SET checkpoint = ? WHERE id = ?
    `).run(JSON.stringify(checkpoint), scanId)
  } catch (error) {
    console.error('Error saving scan checkpoint:', error)
  }
}

// Obtener checkpoint de escaneo
function getScanCheckpoint(scanId: number): {
  orgIndex: number
  orgTotal: number
  workspaceIndex: number
  workspaceTotal: number
  appIndex: number
  appTotal: number
  workspacesCounted: boolean
  appsCounted: boolean
} | null {
  try {
    const db = getDb()
    const result = db.prepare(`
      SELECT checkpoint FROM scans WHERE id = ?
    `).get(scanId) as { checkpoint: string | null } | undefined
    
    if (result && result.checkpoint) {
      return JSON.parse(result.checkpoint)
    }
    return null
  } catch (error) {
    console.error('Error getting scan checkpoint:', error)
    return null
  }
}

// Marcar scan como cancelado
function markScanAsCancelled(scanId: number): void {
  try {
    const db = getDb()
    db.prepare(`
      UPDATE scans SET cancelled = 1 WHERE id = ?
    `).run(scanId)
    
    // También limpiar el checkpoint del scan cancelado
    db.prepare(`
      UPDATE scans SET checkpoint = NULL WHERE id = ?
    `).run(scanId)
    
    console.log(`✅ Scan ${scanId} marcado como cancelado`)
  } catch (error) {
    console.error('Error marking scan as cancelled:', error)
  }
}

// ========== DOWNLOAD CHECKPOINTS ==========

// Agregar checkpoint de descarga (al iniciar)
function addDownloadCheckpoint(params: {
  scan_id: number
  file_id: number
  app_id: number
  item_id?: number
  path: string
  size?: number
}): void {
  try {
    const db = getDb()
    db.prepare(`
      INSERT OR IGNORE INTO downloads (scan_id, file_id, app_id, item_id, path, size, status, last_try_ms, tries)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0)
    `).run(
      params.scan_id,
      params.file_id,
      params.app_id,
      params.item_id || null,
      params.path,
      params.size || null,
      Date.now()
    )
  } catch (error) {
    console.error('Error adding download checkpoint:', error)
  }
}

// Actualizar estado de descarga
function updateDownloadStatus(params: {
  file_id: number
  scan_id: number
  status: 'pending' | 'done' | 'error'
  size?: number
  error?: string
}): void {
  try {
    const db = getDb()
    const now = Date.now()
    
    if (params.status === 'done') {
      db.prepare(`
        UPDATE downloads 
        SET status = 'done', size = ?, last_try_ms = ?
        WHERE file_id = ? AND scan_id = ?
      `).run(params.size || null, now, params.file_id, params.scan_id)
    } else if (params.status === 'error') {
      db.prepare(`
        UPDATE downloads 
        SET status = 'error', tries = tries + 1, last_try_ms = ?
        WHERE file_id = ? AND scan_id = ?
      `).run(now, params.file_id, params.scan_id)
    } else {
      db.prepare(`
        UPDATE downloads 
        SET status = 'pending', last_try_ms = ?
        WHERE file_id = ? AND scan_id = ?
      `).run(now, params.file_id, params.scan_id)
    }
  } catch (error) {
    console.error('Error updating download status:', error)
  }
}

// Verificar si un archivo ya fue descargado exitosamente
function isDownloadDone(fileId: number, scanId: number): boolean {
  try {
    const db = getDb()
    const result = db.prepare(`
      SELECT status FROM downloads 
      WHERE file_id = ? AND scan_id = ? AND status = 'done'
    `).get(fileId, scanId) as { status: string } | undefined
    
    return !!result
  } catch (error) {
    console.error('Error checking download status:', error)
    return false
  }
}

// Obtener descargas pendientes de un escaneo
function getPendingDownloads(scanId: number): any[] {
  try {
    const db = getDb()
    return db.prepare(`
      SELECT * FROM downloads 
      WHERE scan_id = ? AND status = 'pending'
      ORDER BY id ASC
    `).all(scanId) as any[]
  } catch (error) {
    console.error('Error getting pending downloads:', error)
    return []
  }
}

// Obtener descargas fallidas de un escaneo (para reintentar)
function getFailedDownloads(scanId: number, maxTries: number = 3): any[] {
  try {
    const db = getDb()
    return db.prepare(`
      SELECT * FROM downloads 
      WHERE scan_id = ? AND status = 'error' AND tries < ?
      ORDER BY last_try_ms ASC
    `).all(scanId, maxTries) as any[]
  } catch (error) {
    console.error('Error getting failed downloads:', error)
    return []
  }
}

// Obtener información de descarga por file_id y scan_id
function getDownloadInfo(fileId: number, scanId: number): any | null {
  try {
    const db = getDb()
    return db.prepare(`
      SELECT * FROM downloads 
      WHERE file_id = ? AND scan_id = ?
    `).get(fileId, scanId) as any | null
  } catch (error) {
    console.error('Error getting download info:', error)
    return null
  }
}

// Obtener estadísticas de descargas de un escaneo
function getDownloadStats(scanId: number): {
  total: number
  done: number
  pending: number
  error: number
} {
  try {
    const db = getDb()
    const result = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
      FROM downloads 
      WHERE scan_id = ?
    `).get(scanId) as any
    
    return {
      total: result?.total || 0,
      done: result?.done || 0,
      pending: result?.pending || 0,
      error: result?.error || 0
    }
  } catch (error) {
    console.error('Error getting download stats:', error)
    return { total: 0, done: 0, pending: 0, error: 0 }
  }
}

// Detectar si hay un backup incompleto (con descargas pendientes o con errores)
function hasIncompleteBackup(): {
  hasIncomplete: boolean
  scanId: number | null
  scanDate: number | null
  stats: { total: number; done: number; pending: number; error: number } | null
} {
  try {
    const db = getDb()
    
    // Buscar el último scan (dentro de las últimas 48 horas) que tenga descargas pendientes o con errores
    const scan = db.prepare(`
      SELECT s.id, s.created_at_ms,
        (SELECT COUNT(*) FROM downloads WHERE scan_id = s.id) as total,
        (SELECT COUNT(*) FROM downloads WHERE scan_id = s.id AND status = 'done') as done,
        (SELECT COUNT(*) FROM downloads WHERE scan_id = s.id AND status = 'pending') as pending,
        (SELECT COUNT(*) FROM downloads WHERE scan_id = s.id AND status = 'error') as error
      FROM scans s
      WHERE s.created_at_ms > ?
        AND (SELECT COUNT(*) FROM downloads WHERE scan_id = s.id AND status IN ('pending', 'error')) > 0
      ORDER BY s.created_at_ms DESC
      LIMIT 1
    `).get(Date.now() - (48 * 60 * 60 * 1000)) as any
    
    if (!scan || scan.total === 0) {
      return {
        hasIncomplete: false,
        scanId: null,
        scanDate: null,
        stats: null
      }
    }
    
    return {
      hasIncomplete: true,
      scanId: scan.id,
      scanDate: scan.created_at_ms,
      stats: {
        total: scan.total || 0,
        done: scan.done || 0,
        pending: scan.pending || 0,
        error: scan.error || 0
      }
    }
  } catch (error) {
    console.error('Error checking for incomplete backup:', error)
    return {
      hasIncomplete: false,
      scanId: null,
      scanDate: null,
      stats: null
    }
  }
}

// Obtener estado detallado de un scan específico
function getScanStatus(scanId: number): {
  scan: any | null
  stats: { total: number; done: number; pending: number; error: number }
  apps: any[]
} {
  try {
    const db = getDb()
    
    // Obtener información del scan
    const scan = db.prepare(`
      SELECT * FROM scans WHERE id = ?
    `).get(scanId) as any
    
    if (!scan) {
      return {
        scan: null,
        stats: { total: 0, done: 0, pending: 0, error: 0 },
        apps: []
      }
    }
    
    // Obtener estadísticas de descargas
    const stats = getDownloadStats(scanId)
    
    // Obtener apps del scan
    const apps = db.prepare(`
      SELECT * FROM scan_apps WHERE scan_id = ?
    `).all(scanId) as any[]
    
    return {
      scan: {
        ...scan,
        summary: scan.summary ? JSON.parse(scan.summary) : null
      },
      stats,
      apps
    }
  } catch (error) {
    console.error('Error getting scan status:', error)
    return {
      scan: null,
      stats: { total: 0, done: 0, pending: 0, error: 0 },
      apps: []
    }
  }
}

// Purgar requests antiguos (>24h)
function pruneOldRequests(): void {
  try {
    const db = getDb()
    const cutoff = Date.now() - (24 * 60 * 60 * 1000)
    const result = db.prepare(`
      DELETE FROM requests WHERE ts_ms < ?
    `).run(cutoff)
    console.log(`Pruned ${result.changes} old request records`)
  } catch (error) {
    console.error('Error pruning old requests:', error)
  }
}

// Purgar scans antiguos (>7 días)
function pruneOldScans(): void {
  try {
    const db = getDb()
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000)
    const result = db.prepare(`
      DELETE FROM scans WHERE created_at_ms < ?
    `).run(cutoff)
    console.log(`Pruned ${result.changes} old scan records`)
  } catch (error) {
    console.error('Error pruning old scans:', error)
  }
}

module.exports = {
  initDb,
  getDb,
  logRequest,
  getRequestCountsSince,
  getLastRequestInHourWindow,
  getRateLimitStatus,
  saveRateLimitStatus,
  getRateLimitStatusFromDb,
  clearExpiredRateLimits,
  clearRateLimitStatus,
  clearAuthenticationRequests,
  clearRecentRequests,
  getApiCache,
  setApiCache,
  clearExpiredApiCache,
  beginScan,
  addApp,
  addItem,
  addFile,
  addFilesBulk,
  finalizeScan,
  getLastScan,
  getLastScanApps,
  getLastScanFiles,
  getLastScanItemsCount,
  // Scan checkpoints
  saveScanCheckpoint,
  getScanCheckpoint,
  markScanAsCancelled,
  // Download checkpoints
  addDownloadCheckpoint,
  updateDownloadStatus,
  isDownloadDone,
  getPendingDownloads,
  getFailedDownloads,
  getDownloadInfo,
  getDownloadStats,
  hasIncompleteBackup,
  getScanStatus,
  pruneOldRequests,
  pruneOldScans
}
