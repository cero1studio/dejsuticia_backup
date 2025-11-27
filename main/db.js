const Database = require('better-sqlite3')
const path = require('path')
const { app } = require('electron')
const fs = require('fs')

// Unified rate limit (both general and rateLimited use the same limit)
const RATE_LIMIT_HOUR = 5000
const RATE_LIMIT_DAY = 60000

let db = null

function getDbPath() {
  const userDataPath = app.getPath('userData')
  const dbPath = path.join(userDataPath, 'podio-backup.db')
  return dbPath
}

function initDb() {
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
      checkpoint TEXT
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
  
  // Migraciones: Agregar columnas que pueden no existir en bases de datos antiguas
  try {
    const tableInfo = db.prepare(`PRAGMA table_info(scans)`).all()
    
    // Verificar si la columna checkpoint existe en la tabla scans
    const hasCheckpoint = tableInfo.some(col => col.name === 'checkpoint')
    if (!hasCheckpoint) {
      console.log('🔄 Agregando columna checkpoint a la tabla scans...')
      db.exec(`ALTER TABLE scans ADD COLUMN checkpoint TEXT`)
      console.log('✅ Columna checkpoint agregada exitosamente')
    }
    
    // Verificar si la columna cancelled existe en la tabla scans
    const hasCancelled = tableInfo.some(col => col.name === 'cancelled')
    if (!hasCancelled) {
      console.log('🔄 Agregando columna cancelled a la tabla scans...')
      db.exec(`ALTER TABLE scans ADD COLUMN cancelled BOOLEAN DEFAULT 0`)
      console.log('✅ Columna cancelled agregada exitosamente')
    }
  } catch (migrationError) {
    console.warn('⚠️ Error en migración de columnas (no crítico):', migrationError)
  }
  
  // IMPORTANTE: Inicializar estados vacíos después de crear las tablas
  // Esto asegura que las funciones manejen correctamente los casos cuando la BD está vacía
  try {
    initializeEmptyStates()
  } catch (initError) {
    console.warn('⚠️ Error inicializando estados vacíos (no crítico):', initError)
    // No fallar si hay error, las funciones ya manejan estados vacíos
  }
}

function getDb() {
  if (!db) initDb()
  return db
}

// Log de request a la API
function logRequest(params) {
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
function getRequestCountsSince(sinceMs) {
  try {
    const db = getDb()
    const general = db.prepare(`
      SELECT COUNT(*) as count FROM requests
      WHERE rate_type = 'general' AND ts_ms >= ?
    `).get(sinceMs)
    
    const rateLimited = db.prepare(`
      SELECT COUNT(*) as count FROM requests
      WHERE rate_type = 'rateLimited' AND ts_ms >= ?
    `).get(sinceMs)
    
    return {
      general: general?.count || 0,
      rateLimited: rateLimited?.count || 0
    }
  } catch (error) {
    console.error('Error getting request counts:', error)
    return { general: 0, rateLimited: 0 }
  }
}

// Obtener el último request de la ventana de 1 hora para calcular cuándo se resetea
// Se basa en el último request (cuando salió el error) + 1 hora
function getLastRequestInHourWindow(rateType) {
  try {
    const db = getDb()
    const oneHourAgo = Date.now() - (60 * 60 * 1000)
    
    const result = db.prepare(`
      SELECT MAX(ts_ms) as last_ts FROM requests
      WHERE rate_type = ? AND ts_ms >= ?
    `).get(rateType, oneHourAgo)
    
    return result?.last_ts || null
  } catch (error) {
    console.error('Error getting last request in hour window:', error)
    return null
  }
}

// Obtener el PRIMER request de la ventana de 1 hora para calcular cuándo se resetea normalmente
// Se basa en el primer request (inicio de la ventana) + 1 hora
// IMPORTANTE: Si no hay requests en la última hora, busca el último request antes de esa hora
// para mantener el reloj corriendo desde el primer request, no retroceder
function getFirstRequestInHourWindow(rateType) {
  try {
    const db = getDb()
    const now = Date.now()
    const oneHourAgo = now - (60 * 60 * 1000)
    
    // Primero intentar encontrar el primer request en la última hora
    const result = db.prepare(`
      SELECT MIN(ts_ms) as first_ts FROM requests
      WHERE rate_type = ? AND ts_ms >= ?
    `).get(rateType, oneHourAgo)
    
    if (result?.first_ts) {
      return result.first_ts
    }
    
    // Si no hay requests en la última hora, buscar el último request antes de esa hora
    // Esto asegura que el reloj no retroceda: si el último request fue hace 2 horas,
    // el reset ya debería haber ocurrido (hace 1 hora), así que no hay reset pendiente
    const lastRequestBefore = db.prepare(`
      SELECT MAX(ts_ms) as last_ts FROM requests
      WHERE rate_type = ? AND ts_ms < ?
    `).get(rateType, oneHourAgo)
    
    if (lastRequestBefore?.last_ts) {
      const resetTime = lastRequestBefore.last_ts + (60 * 60 * 1000)
      // Si el reset ya pasó (hace más de 1 hora del último request), retornar null
      // porque no hay reset pendiente
      if (resetTime <= now) {
        return null // El reset ya pasó, no hay ventana activa
      }
      // Si el reset aún no ha pasado, usar el último request como referencia
      // pero esto no debería pasar normalmente si no hay requests en la última hora
      return lastRequestBefore.last_ts
    }
    
    return null
  } catch (error) {
    console.error('Error getting first request in hour window:', error)
    return null
  }
}

// Calcular límites remanentes y cuándo se resetea la hora
function getRateLimitStatus(rateType) {
  try {
    const db = getDb()
    const oneHourAgo = Date.now() - (60 * 60 * 1000)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000)
    const limits = {
      general: RATE_LIMIT_HOUR,
      rateLimited: RATE_LIMIT_HOUR
    }
    
    // ========================================================================
    // LIMPIEZA AUTOMÁTICA: Eliminar requests > 1 hora para mantener BD limpia
    // ========================================================================
    // Esto asegura que los contadores sean precisos y se reseteen correctamente
    try {
      const deleted = db.prepare(`
        DELETE FROM requests WHERE ts_ms < ?
      `).run(oneHourAgo)
      
      if (deleted.changes > 0) {
        console.log(`🧹 Limpieza automática: ${deleted.changes} requests viejos eliminados`)
      }
    } catch (cleanupError) {
      console.warn('Error en limpieza automática de requests:', cleanupError)
      // Continuar aunque falle la limpieza
    }
    
    // Primero verificar si hay un error activo guardado (cuando ya salió un 429)
    // En ese caso, usamos el reset del error (desde el primer request de la hora)
    const errorStatus = getRateLimitStatusFromDb(rateType)
    if (errorStatus.active && errorStatus.resetAtMs) {
      // Contar requests diarios también
      const dailyUsed = db.prepare(`
        SELECT COUNT(*) as count FROM requests
        WHERE rate_type = ? AND ts_ms >= ?
      `).get(rateType, oneDayAgo)
      const dailyUsedCount = dailyUsed?.count || 0
      
      return {
        used: errorStatus.requestsUsed || 0,
        remaining: Math.max(0, (errorStatus.limitValue || limits[rateType]) - (errorStatus.requestsUsed || 0)),
        limit: errorStatus.limitValue || limits[rateType],
        resetAtMs: errorStatus.resetAtMs,
        resetInSeconds: errorStatus.resetInSeconds,
        dailyUsed: dailyUsedCount,
        dailyLimit: RATE_LIMIT_DAY,
        dailyRemaining: Math.max(0, RATE_LIMIT_DAY - dailyUsedCount)
      }
    }
    
    // Si no hay error activo, calcular normalmente desde el PRIMER request
    const used = db.prepare(`
      SELECT COUNT(*) as count FROM requests
      WHERE rate_type = ? AND ts_ms >= ?
    `).get(rateType, oneHourAgo)
    
    // Contar requests en las últimas 24 horas
    const dailyUsed = db.prepare(`
      SELECT COUNT(*) as count FROM requests
      WHERE rate_type = ? AND ts_ms >= ?
    `).get(rateType, oneDayAgo)
    
    const usedCount = used?.count || 0
    const dailyUsedCount = dailyUsed?.count || 0
    const limit = limits[rateType]
    const remaining = Math.max(0, limit - usedCount)
    const dailyRemaining = Math.max(0, RATE_LIMIT_DAY - dailyUsedCount)
    
    // Obtener el PRIMER request de la ventana de 1 hora (normalmente)
    const firstRequest = getFirstRequestInHourWindow(rateType)
    let resetAtMs = null
    let resetInSeconds = null
    
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
// IMPORTANTE: El reset se calcula desde el PRIMER request de la ventana de 1 hora
// Si no hay requests en la última hora, el reset se calcula desde el momento del error
// pero el reloj no retrocede: si pasó más de 1 hora desde el último request, el reset ya ocurrió
function saveRateLimitStatus(params) {
  try {
    const db = getDb()
    const now = Date.now()
    
    // Obtener el primer request de la ventana de 1 hora para calcular reset desde ahí
    const firstRequest = getFirstRequestInHourWindow(params.rate_type)
    
    let resetAtMs
    if (firstRequest) {
      // Si hay un primer request en la ventana, el reset es 1 hora después de ese primer request
      resetAtMs = firstRequest + (60 * 60 * 1000)
    } else {
      // Si no hay requests en la ventana, el reset es 1 hora después del momento del error
      // Esto solo debería pasar si es el primer request del día o si pasó más de 1 hora sin requests
      resetAtMs = params.triggered_at_ms + (60 * 60 * 1000)
    }
    
    // IMPORTANTE: Si el reset ya pasó (más de 1 hora desde el último request), no guardar el error
    // porque el límite ya se reseteó
    if (resetAtMs <= now) {
      // El reset ya pasó, no hay necesidad de guardar el error
      console.log(`Rate limit reset ya pasó para ${params.rate_type}, no guardando error`)
      return
    }
    
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
function getRateLimitStatusFromDb(rateType) {
  try {
    const db = getDb()
    const now = Date.now()
    
    // CRÍTICO: Limpiar rate limits expirados ANTES de consultar
    // Esto asegura que no retornemos rate limits que ya expiraron
    try {
      const deleted = db.prepare(`
        DELETE FROM rate_limit_status
        WHERE rate_type = ? AND reset_at_ms <= ?
      `).run(rateType, now)
      
      if (deleted.changes > 0) {
        console.log(`🧹 Limpiados ${deleted.changes} rate limit(s) expirado(s) para ${rateType}`)
      }
    } catch (cleanupError) {
      console.warn('Error limpiando rate limits expirados:', cleanupError)
      // Continuar de todas formas
    }
    
    // Ahora buscar rate limits activos (solo los que no expiraron)
    const result = db.prepare(`
      SELECT * FROM rate_limit_status
      WHERE rate_type = ? AND reset_at_ms > ?
    `).get(rateType, now)
    
    // Si no hay resultado (BD vacía o sin rate limit activo), retornar estado inactivo con valores por defecto
    if (!result) {
      return {
        active: false,
        triggeredAtMs: null,
        resetAtMs: null,
        resetInSeconds: 0, // 0 en lugar de null para evitar problemas
        requestsUsed: 0,   // 0 en lugar de null para evitar problemas
        limitValue: RATE_LIMIT_HOUR, // Valor por defecto
        type: "none"
      }
    }
    
    const resetInSeconds = Math.max(0, Math.ceil((result.reset_at_ms - now) / 1000))
    
    // Si el reset ya pasó (aunque la consulta debería haberlo filtrado), retornar inactivo
    if (resetInSeconds <= 0) {
      // Limpiar este registro también
      try {
        db.prepare(`DELETE FROM rate_limit_status WHERE rate_type = ?`).run(rateType)
      } catch (e) {
        // Ignorar errores de limpieza
      }
      
      return {
        active: false,
        triggeredAtMs: null,
        resetAtMs: null,
        resetInSeconds: 0,
        requestsUsed: 0,
        limitValue: RATE_LIMIT_HOUR,
        type: "none"
      }
    }
    
    return {
      active: resetInSeconds > 0,
      triggeredAtMs: result.triggered_at_ms,
      resetAtMs: result.reset_at_ms,
      resetInSeconds,
      requestsUsed: result.requests_used || 0,
      limitValue: result.limit_value || RATE_LIMIT_HOUR,
      type: result.rate_type || "none"
    }
  } catch (error) {
    console.error('Error getting rate limit status from DB:', error)
    // Retornar estado inactivo con valores por defecto en caso de error
    return {
      active: false,
      triggeredAtMs: null,
      resetAtMs: null,
      resetInSeconds: 0, // 0 en lugar de null
      requestsUsed: 0,   // 0 en lugar de null
      limitValue: RATE_LIMIT_HOUR, // Valor por defecto
      type: "none"
    }
  }
}

// Limpiar estados de rate limit expirados
function clearExpiredRateLimits() {
  try {
    const db = getDb()
    const now = Date.now()
    const result = db.prepare(`
      DELETE FROM rate_limit_status WHERE reset_at_ms <= ?
    `).run(now)
    if (result.changes > 0) {
      console.log(`🧹 Limpiados ${result.changes} rate limit(s) expirado(s)`)
    }
    return { success: true, cleared: result.changes }
  } catch (error) {
    console.error('Error clearing expired rate limits:', error)
    return { success: false, cleared: 0, error: error.message }
  }
}

/**
 * Limpiar TODOS los rate limits (útil cuando el usuario quiere resetear completamente)
 */
function clearAllRateLimits() {
  try {
    const db = getDb()
    const result = db.prepare(`DELETE FROM rate_limit_status`).run()
    if (result.changes > 0) {
      console.log(`🧹 Limpiados todos los rate limits (${result.changes} registros)`)
    }
    return { success: true, cleared: result.changes }
  } catch (error) {
    console.error('Error clearing all rate limits:', error)
    return { success: false, cleared: 0, error: error.message }
  }
}

// ==================== FUNCIONES DE CACHÉ API ====================

// Obtener respuesta de API desde caché de BD
function getApiCache(endpoint) {
  try {
    const db = getDb()
    const now = Date.now()
    
    const result = db.prepare(`
      SELECT response_data, expires_at_ms FROM api_cache
      WHERE endpoint = ? AND expires_at_ms > ?
    `).get(endpoint, now)
    
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
function setApiCache(endpoint, data, ttlMs = 3600000) {
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
function clearExpiredApiCache() {
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
function beginScan(params) {
  try {
    const db = getDb()
    
    // Log para debug
    console.log(`📦 BD: beginScan llamado con:`, {
      podio_backup_item_id: params.podio_backup_item_id,
      title: params.title,
      user: params.user,
      org_id: params.org_id
    });
    
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
    
    const scanId = result.lastInsertRowid;
    console.log(`✅ BD: Scan creado con ID: ${scanId}, podio_backup_item_id: ${params.podio_backup_item_id || 'NULL'}`);
    
    // Verificar que se guardó correctamente
    const verify = db.prepare(`
      SELECT id, podio_backup_item_id, title FROM scans WHERE id = ?
    `).get(scanId);
    console.log(`🔍 BD: Scan verificado:`, verify);
    
    return scanId
  } catch (error) {
    console.error('❌ Error beginning scan:', error)
    throw error
  }
}

// Agregar app al escaneo
function addApp(scanId, params) {
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
function addItem(scanId, appId, itemId) {
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
function addFile(scanId, params) {
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
function addFilesBulk(scanId, files) {
  if (files.length === 0) return
  
  try {
    const db = getDb()
    const stmt = db.prepare(`
      INSERT INTO scan_files (scan_id, app_id, item_id, file_id, name, size, mimetype, download_url, folder_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    
    const insertMany = db.transaction((files) => {
      for (const file of files) {
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
function finalizeScan(scanId, summary) {
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
function getLastScan() {
  try {
    const db = getDb()
    const scan = db.prepare(`
      SELECT * FROM scans ORDER BY created_at_ms DESC LIMIT 1
    `).get()
    
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
function getLastScanApps() {
  try {
    const db = getDb()
    const lastScan = getLastScan()
    if (!lastScan) return []
    
    return db.prepare(`
      SELECT * FROM scan_apps WHERE scan_id = ?
    `).all(lastScan.id)
  } catch (error) {
    console.error('Error getting last scan apps:', error)
    return []
  }
}

// Obtener archivos del último escaneo
function getLastScanFiles() {
  try {
    const db = getDb()
    const lastScan = getLastScan()
    if (!lastScan) return []
    
    return db.prepare(`
      SELECT * FROM scan_files WHERE scan_id = ?
    `).all(lastScan.id)
  } catch (error) {
    console.error('Error getting last scan files:', error)
    return []
  }
}

// Obtener count de items del último escaneo
function getLastScanItemsCount() {
  try {
    const db = getDb()
    const lastScan = getLastScan()
    if (!lastScan) return 0
    
    const result = db.prepare(`
      SELECT COUNT(DISTINCT item_id) as count FROM scan_items WHERE scan_id = ?
    `).get(lastScan.id)
    
    return result?.count || 0
  } catch (error) {
    console.error('Error getting last scan items count:', error)
    return 0
  }
}

// ========== SCAN CHECKPOINTS ==========

// Guardar checkpoint de escaneo (org, workspace, app)
function saveScanCheckpoint(scanId, checkpoint) {
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
function getScanCheckpoint(scanId) {
  try {
    const db = getDb()
    const result = db.prepare(`
      SELECT checkpoint FROM scans WHERE id = ?
    `).get(scanId)
    
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
function markScanAsCancelled(scanId) {
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
function addDownloadCheckpoint(params) {
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
function updateDownloadStatus(params) {
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
function isDownloadDone(fileId, scanId) {
  try {
    const db = getDb()
    const result = db.prepare(`
      SELECT status FROM downloads 
      WHERE file_id = ? AND scan_id = ? AND status = 'done'
    `).get(fileId, scanId)
    
    return !!result
  } catch (error) {
    console.error('Error checking download status:', error)
    return false
  }
}

// Obtener descargas pendientes de un escaneo
function getPendingDownloads(scanId) {
  try {
    const db = getDb()
    return db.prepare(`
      SELECT * FROM downloads 
      WHERE scan_id = ? AND status = 'pending'
      ORDER BY id ASC
    `).all(scanId)
  } catch (error) {
    console.error('Error getting pending downloads:', error)
    return []
  }
}

// Obtener descargas fallidas de un escaneo (para reintentar)
function getFailedDownloads(scanId, maxTries = 3) {
  try {
    const db = getDb()
    return db.prepare(`
      SELECT * FROM downloads 
      WHERE scan_id = ? AND status = 'error' AND tries < ?
      ORDER BY last_try_ms ASC
    `).all(scanId, maxTries)
  } catch (error) {
    console.error('Error getting failed downloads:', error)
    return []
  }
}

// Obtener información de descarga por file_id y scan_id
function getDownloadInfo(fileId, scanId) {
  try {
    const db = getDb()
    return db.prepare(`
      SELECT * FROM downloads 
      WHERE file_id = ? AND scan_id = ?
    `).get(fileId, scanId)
  } catch (error) {
    console.error('Error getting download info:', error)
    return null
  }
}

// Obtener estadísticas de descargas de un escaneo
function getDownloadStats(scanId) {
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
    `).get(scanId)
    
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

// Purgar requests antiguos (>24h)
function pruneOldRequests() {
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
function pruneOldScans() {
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

// ========== FUNCIONES PARA OBTENER DETALLES DE BACKUPS ==========

// Obtener scan por podio_backup_item_id
function getScanByPodioItemId(podioItemId) {
  try {
    const db = getDb()
    
    // Asegurarse de que el ID sea un número
    const itemId = Number(podioItemId)
    if (isNaN(itemId)) {
      console.error('getScanByPodioItemId: ID inválido:', podioItemId)
      return null
    }
    
    console.log(`🔍 BD: Buscando scan con podio_backup_item_id = ${itemId}`)
    
    const scan = db.prepare(`
      SELECT * FROM scans WHERE podio_backup_item_id = ? ORDER BY created_at_ms DESC LIMIT 1
    `).get(itemId)
    
    if (!scan) {
      console.log(`⚠️ BD: No se encontró scan con podio_backup_item_id = ${itemId}`)
      
      // Debug: mostrar todos los scans disponibles para verificar
      const allScans = db.prepare(`
        SELECT id, podio_backup_item_id, title, created_at_ms FROM scans ORDER BY created_at_ms DESC LIMIT 5
      `).all()
      console.log('📋 BD: Últimos 5 scans en BD:', allScans)
      return null
    }
    
    console.log(`✅ BD: Scan encontrado - ID: ${scan.id}, podio_backup_item_id: ${scan.podio_backup_item_id}`)
    
    return {
      ...scan,
      summary: scan.summary ? JSON.parse(scan.summary) : null
    }
  } catch (error) {
    console.error('❌ Error getting scan by podio item id:', error)
    return null
  }
}

// Obtener apps de un scan específico
function getScanAppsByScanId(scanId) {
  try {
    const db = getDb()
    return db.prepare(`
      SELECT * FROM scan_apps WHERE scan_id = ? ORDER BY org_name, space_name, app_name
    `).all(scanId)
  } catch (error) {
    console.error('Error getting scan apps by scan id:', error)
    return []
  }
}

// Obtener archivos de un scan específico
function getScanFilesByScanId(scanId) {
  try {
    const db = getDb()
    return db.prepare(`
      SELECT * FROM scan_files WHERE scan_id = ? ORDER BY app_id, item_id, name
    `).all(scanId)
  } catch (error) {
    console.error('Error getting scan files by scan id:', error)
    return []
  }
}

// ========================================================================
// RATE LIMIT STATUS
// ========================================================================

/**
 * Limpiar estado de rate limit para un tipo específico
 */
function clearRateLimitStatus(rateType) {
  try {
    const db = getDb()
    const result = db.prepare(`
      DELETE FROM rate_limit_status WHERE rate_type = ?
    `).run(rateType)
    if (result.changes > 0) {
      console.log(`✅ Cleared rate limit status for type: ${rateType}`)
    }
  } catch (error) {
    console.error(`❌ Error clearing rate limit status for ${rateType}:`, error)
  }
}

/**
 * Limpiar TODAS las peticiones de autenticación (POST /oauth/token) de la BD
 * Esto resetea nuestro contador interno de peticiones de autenticación
 * ÚTIL cuando el servidor de Podio tiene un rate limit activo
 */
function clearAuthenticationRequests() {
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
    return { success: false, error: error.message }
  }
}

/**
 * Limpiar TODAS las peticiones de la última hora
 * Útil para resetear contadores cuando hay rate limit del servidor
 */
function clearRecentRequests() {
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
    return { success: false, error: error.message }
  }
}

// ========================================================================
// HISTORIAL LOCAL DE BACKUPS
// ========================================================================

/**
 * Obtener historial de backups desde la BD local
 * Retorna los últimos N scans con sus estadísticas
 */
function getLocalBackupHistory(limit = 10) {
  try {
    const db = getDb()
    
    const scans = db.prepare(`
      SELECT 
        id,
        created_at_ms,
        podio_backup_item_id,
        summary
      FROM scans
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(limit)
    
    // Formatear cada scan como un item de historial
    return scans.map(scan => {
      const summary = scan.summary ? JSON.parse(scan.summary) : {}
      const createdAt = new Date(scan.created_at_ms)
      
      // Determinar estado basándose en el summary
      let estado = 'Pendiente'
      if (summary.error) {
        estado = 'Error'
      } else if (summary.success !== undefined && summary.success === false) {
        estado = 'Error'
      } else if (summary.organizations !== undefined || summary.applications !== undefined) {
        // Si tiene datos en el summary, asumimos que está completado
        estado = 'Completado'
      }
      
      return {
        id: scan.id,
        item_id: scan.id, // Usar ID de BD como item_id
        titulo: `Respaldo ${createdAt.toLocaleString('es-ES')}`,
        fecha: createdAt.toISOString(),
        estado: estado,
        organizaciones: summary.organizations || 0,
        workspaces: summary.workspaces || 0,
        aplicaciones: summary.applications || 0,
        items: summary.items || 0,
        archivos: summary.files || 0,
        tamano: summary.backupSize || 0,
        error: summary.error || null
      }
    })
  } catch (error) {
    console.error('Error getting local backup history:', error)
    return []
  }
}

/**
 * Inicializar estados vacíos en la base de datos
 * Asegura que las funciones que consultan la BD no fallen cuando está vacía
 */
function initializeEmptyStates() {
  try {
    const db = getDb()
    
    console.log('🔧 Inicializando estados vacíos en la BD...')
    
    // No necesitamos crear registros dummy porque:
    // - getLastScan() retorna null si no hay scans (correcto)
    // - getRateLimitStatus() cuenta desde requests (0 si no hay)
    // - getRateLimitStatusFromDb() retorna active: false si no hay rate limit (correcto)
    // - hasIncompleteBackup() retorna hasIncomplete: false si no hay datos (correcto)
    
    // Solo necesitamos asegurarnos de que las tablas existen (ya se hace en initDb)
    // y que las funciones manejen correctamente los casos vacíos
    
    console.log('✅ Estados vacíos inicializados correctamente')
    return { success: true, message: 'Estados vacíos inicializados' }
  } catch (error) {
    console.error('❌ Error inicializando estados vacíos:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Limpiar completamente la base de datos (barrido desde 0)
 * ADVERTENCIA: Esto elimina TODO el historial de backups
 * Después de limpiar, inicializa estados vacíos para evitar errores
 */
function clearAllData() {
  try {
    const db = getDb()
    
    console.log('🧹 Iniciando limpieza completa de la BD...')
    
    // Eliminar todos los datos de todas las tablas
    db.prepare('DELETE FROM requests').run()
    console.log('✅ Tabla requests limpiada')
    
    db.prepare('DELETE FROM rate_limit_status').run()
    console.log('✅ Tabla rate_limit_status limpiada')
    
    db.prepare('DELETE FROM api_cache').run()
    console.log('✅ Tabla api_cache limpiada')
    
    db.prepare('DELETE FROM downloads').run()
    console.log('✅ Tabla downloads limpiada')
    
    db.prepare('DELETE FROM scan_files').run()
    console.log('✅ Tabla scan_files limpiada')
    
    db.prepare('DELETE FROM scan_items').run()
    console.log('✅ Tabla scan_items limpiada')
    
    db.prepare('DELETE FROM scan_apps').run()
    console.log('✅ Tabla scan_apps limpiada')
    
    db.prepare('DELETE FROM scans').run()
    console.log('✅ Tabla scans limpiada')
    
    // IMPORTANTE: Inicializar estados vacíos después de limpiar
    initializeEmptyStates()
    
    console.log('✅ Limpieza completa de la BD finalizada')
    
    return { success: true, message: 'Base de datos limpiada completamente y estados inicializados' }
  } catch (error) {
    console.error('❌ Error al limpiar la BD:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Limpiar solo el historial de backups (mantener configuración)
 * Elimina scans, apps, items, files y downloads
 */
function clearBackupHistory() {
  try {
    const db = getDb()
    
    console.log('🧹 Limpiando historial de backups...')
    
    db.prepare('DELETE FROM downloads').run()
    db.prepare('DELETE FROM scan_files').run()
    db.prepare('DELETE FROM scan_items').run()
    db.prepare('DELETE FROM scan_apps').run()
    db.prepare('DELETE FROM scans').run()
    
    console.log('✅ Historial de backups limpiado')
    
    return { success: true, message: 'Historial de backups limpiado' }
  } catch (error) {
    console.error('❌ Error al limpiar historial:', error)
    return { success: false, error: error.message }
  }
}

// ========================================================================
// INCOMPLETE BACKUPS
// ========================================================================

/**
 * Verificar si hay un backup incompleto
 */
function hasIncompleteBackup() {
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
    `).get(Date.now() - (48 * 60 * 60 * 1000))
    
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
      scanDate: new Date(scan.created_at_ms),
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

/**
 * Obtener estado de un scan específico
 */
function getScanStatus(scanId) {
  try {
    const db = getDb()
    
    // Obtener información del scan
    const scan = db.prepare(`
      SELECT * FROM scans WHERE id = ?
    `).get(scanId)
    
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
    `).all(scanId)
    
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

module.exports = {
  initDb,
  getDb,
  initializeEmptyStates,
  logRequest,
  getRequestCountsSince,
  getLastRequestInHourWindow,
  getRateLimitStatus,
  saveRateLimitStatus,
  getRateLimitStatusFromDb,
  clearExpiredRateLimits,
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
  pruneOldRequests,
  pruneOldScans,
  // Funciones para obtener detalles de un backup específico
  getScanByPodioItemId,
  getScanAppsByScanId,
  getScanFilesByScanId,
  // Historial local de backups
  getLocalBackupHistory,
  clearAllData,
  clearBackupHistory,
  clearRateLimitStatus,
  clearAuthenticationRequests,
  clearRecentRequests,
  hasIncompleteBackup,
  getScanStatus
}

