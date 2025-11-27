# Historial de Backups Completamente Local

## 📋 Resumen
Se ha modificado el sistema para que el historial de backups se maneje **completamente en la base de datos local SQLite**, eliminando las llamadas API a Podio para crear/actualizar items de historial.

## 🎯 Problema Resuelto
**Antes**:
- ❌ Cada backup creaba un item en Podio
- ❌ Se actualizaba el item cada vez que cambiaba el estado
- ❌ Llamadas API adicionales (POST/PUT) que consumían rate limit
- ❌ Complejidad adicional para sincronizar estado entre Podio y BD local
- ❌ Fallos si no había conectividad con Podio

**Ahora**:
- ✅ Todo el historial se guarda en la BD local (SQLite)
- ✅ NO se crean items en Podio
- ✅ NO se consumen llamadas API para historial
- ✅ Más rápido y eficiente
- ✅ Funciona incluso sin conexión a Podio
- ✅ Menos probabilidad de rate limits

## 🔧 Cambios Implementados

### 1. **Deshabilitar Creación de Items en Podio** (lib/podio-service.ts)

#### `createBackupRecord()` - Líneas 5335-5355
**Antes**: Creaba un item en Podio con POST `/item/app/{appId}/`

**Ahora**:
```typescript
protected async createBackupRecord(): Promise<void> {
  // Ya NO se crea item en Podio
  this.addLog("info", "✅ Historial local activado - No se crearán items en Podio");
  this.backupItemId = null; // No hay item en Podio
  this.backupStartDate = this.formatDateForPodio(new Date());
  
  // El registro se crea automáticamente en la BD cuando se llama a beginScan()
}
```

#### `updateBackupRecord()` - Líneas 5289-5318
**Antes**: Actualizaba el item en Podio con PUT `/item/{backupItemId}`

**Ahora**:
```typescript
protected async updateBackupRecord(success: boolean, errorMessage?: string): Promise<void> {
  // Ya NO se actualiza item en Podio
  this.addLog("info", `✅ Historial local: ${success ? "Completado" : "Error"} - Guardado en BD`);
  
  // Actualizar el resumen del escaneo en la BD local
  if (this.currentScanId && window.electron.db) {
    await window.electron.db.finalizeScan(this.currentScanId, {
      organizations: this.backupCounts.organizations,
      workspaces: this.backupCounts.workspaces,
      applications: this.backupCounts.applications,
      items: this.backupCounts.items,
      files: this.backupCounts.files,
      backupSize: this.backupStats.backupSize,
      success: success,
      error: errorMessage || null
    });
  }
}
```

#### `updateEstimatedSizeInBackupRecord()` - Líneas 5348-5360
**Antes**: Actualizaba el tamaño en Podio con PUT `/item/{backupItemId}`

**Ahora**:
```typescript
protected async updateEstimatedSizeInBackupRecord(): Promise<void> {
  // Ya NO se actualiza tamaño en Podio
  const estimatedBytes = Math.round(this.backupStats.backupSize * 1024 * 1024 * 1024)
  const effectiveBytes = this.backupStats.downloadedBytes > 0 ? this.backupStats.downloadedBytes : estimatedBytes
  const formatted = this.formatSizeForPodio(effectiveBytes)
  
  this.addLog("info", `✅ Tamaño del backup: ${formatted} (guardado en BD local)`);
}
```

### 2. **Nuevas Funciones en BD** (main/db.js)

#### `getLocalBackupHistory(limit)` - Líneas 994-1044
Obtiene el historial de backups desde la tabla `scans`:
```javascript
function getLocalBackupHistory(limit = 10) {
  const scans = db.prepare(`
    SELECT 
      id, created_at, completed_at, podio_backup_item_id, summary, error
    FROM scans
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit)
  
  return scans.map(scan => {
    const summary = JSON.parse(scan.summary || '{}')
    return {
      id: scan.id,
      item_id: scan.id, // Usar ID de BD como item_id
      titulo: `Respaldo ${new Date(scan.created_at).toLocaleString('es-ES')}`,
      fecha: new Date(scan.created_at).toISOString(),
      estado: scan.error ? 'Error' : (scan.completed_at ? 'Completado' : 'Pendiente'),
      organizaciones: summary.organizations || 0,
      workspaces: summary.workspaces || 0,
      aplicaciones: summary.applications || 0,
      items: summary.items || 0,
      archivos: summary.files || 0,
      tamano: summary.backupSize || 0,
      error: scan.error,
      completed_at: scan.completed_at
    }
  })
}
```

#### `clearAllData()` - Líneas 1050-1088
Limpia **TODA** la base de datos (barrido desde 0):
```javascript
function clearAllData() {
  db.prepare('DELETE FROM requests').run()
  db.prepare('DELETE FROM rate_limit_status').run()
  db.prepare('DELETE FROM api_cache').run()
  db.prepare('DELETE FROM downloads').run()
  db.prepare('DELETE FROM scan_files').run()
  db.prepare('DELETE FROM scan_items').run()
  db.prepare('DELETE FROM scan_apps').run()
  db.prepare('DELETE FROM scans').run()
  
  return { success: true, message: 'Base de datos limpiada completamente' }
}
```

#### `clearBackupHistory()` - Líneas 1094-1113
Limpia solo el historial de backups (mantiene configuración):
```javascript
function clearBackupHistory() {
  db.prepare('DELETE FROM downloads').run()
  db.prepare('DELETE FROM scan_files').run()
  db.prepare('DELETE FROM scan_items').run()
  db.prepare('DELETE FROM scan_apps').run()
  db.prepare('DELETE FROM scans').run()
  
  return { success: true, message: 'Historial de backups limpiado' }
}
```

### 3. **Modificar Dashboard** (app/dashboard-electron/page.tsx)

#### Cargar historial desde BD local - Líneas 159-169
**Antes**:
```typescript
const history = await service.getBackupHistory(backupAppId)
setBackupHistory(history)
```

**Ahora**:
```typescript
if (window.electron && window.electron.db) {
  const historyResult = await window.electron.db.getLocalBackupHistory(10)
  if (historyResult.success) {
    console.log(`📋 Dashboard: Historial local cargado con ${historyResult.data.length} items`)
    setBackupHistory(historyResult.data)
  }
}
```

#### Recargar historial después del backup - Múltiples ubicaciones
**Antes**:
```typescript
const history = await podioService.getBackupHistory(backupAppId, true)
setBackupHistory(history)
```

**Ahora**:
```typescript
if (window.electron && window.electron.db) {
  const historyResult = await window.electron.db.getLocalBackupHistory(10)
  if (historyResult.success) {
    setBackupHistory(historyResult.data)
  }
}
```

### 4. **IPC Handlers** (main.js, preload.js, types/electron.d.ts)

Se agregaron 3 nuevos handlers IPC:

**main.js** (líneas 850-888):
```javascript
ipcMain.handle('db:getLocalBackupHistory', async (event, limit) => {
  const history = db.getLocalBackupHistory(limit);
  return { success: true, data: history };
});

ipcMain.handle('db:clearAllData', async () => {
  return db.clearAllData();
});

ipcMain.handle('db:clearBackupHistory', async () => {
  return db.clearBackupHistory();
});
```

**preload.js** (líneas 54-56):
```javascript
getLocalBackupHistory: (limit) => ipcRenderer.invoke('db:getLocalBackupHistory', limit),
clearAllData: () => ipcRenderer.invoke('db:clearAllData'),
clearBackupHistory: () => ipcRenderer.invoke('db:clearBackupHistory'),
```

**types/electron.d.ts** (líneas 49-51):
```typescript
getLocalBackupHistory: (limit?: number) => Promise<{ success: boolean; data: any[]; error?: string }>
clearAllData: () => Promise<{ success: boolean; message?: string; error?: string }>
clearBackupHistory: () => Promise<{ success: boolean; message?: string; error?: string }>
```

## 📊 Estructura de Datos

### Tabla `scans` (BD Local)
```sql
CREATE TABLE scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,        -- Timestamp de creación
  completed_at INTEGER,                -- Timestamp de finalización
  podio_backup_item_id INTEGER,       -- DEPRECATED (ya no se usa)
  summary TEXT,                        -- JSON con estadísticas
  error TEXT                           -- Mensaje de error si falló
);
```

### Formato del Summary (JSON)
```json
{
  "organizations": 1,
  "workspaces": 84,
  "applications": 334,
  "items": 34027,
  "files": 1523,
  "backupSize": 2.5,  // GB
  "success": true,
  "error": null
}
```

### Formato del Historial Retornado
```javascript
[
  {
    id: 42,
    item_id: 42,  // Mismo que id (para compatibilidad)
    titulo: "Respaldo 18/11/2025, 19:32:59",
    fecha: "2025-11-18T19:32:59.000Z",
    estado: "Completado",  // "Pendiente" | "Completado" | "Error"
    organizaciones: 1,
    workspaces: 84,
    aplicaciones: 334,
    items: 34027,
    archivos: 1523,
    tamano: 2.5,  // GB
    error: null,
    completed_at: 1700338379000
  },
  // ... más backups
]
```

## 🚀 Uso

### Obtener historial de backups
```typescript
// Obtener los últimos 10 backups
const result = await window.electron.db.getLocalBackupHistory(10)
if (result.success) {
  console.log('Historial:', result.data)
}

// Obtener los últimos 20 backups
const result = await window.electron.db.getLocalBackupHistory(20)
```

### Limpiar toda la BD (barrido desde 0)
```typescript
const result = await window.electron.db.clearAllData()
if (result.success) {
  console.log('✅ BD limpiada completamente')
}
```

### Limpiar solo historial de backups
```typescript
const result = await window.electron.db.clearBackupHistory()
if (result.success) {
  console.log('✅ Historial limpiado')
}
```

## 📈 Beneficios

### Reducción de Llamadas API
**Antes** (por backup):
- 1 POST `/item/app/{appId}/` (crear item)
- 1-3 PUT `/item/{itemId}` (actualizar tamaño, estado)
- 1 GET `/item/app/{appId}/?limit=10` (cargar historial)
- **Total: 3-5 llamadas API por backup**

**Ahora** (por backup):
- **0 llamadas API para historial**
- Solo llamadas para escanear/descargar datos reales

### Ahorro de Rate Limit
- ✅ 3-5 llamadas menos por backup
- ✅ Con 10 backups al día: 30-50 llamadas ahorradas
- ✅ Menos probabilidad de alcanzar límite de 5000/hora

### Velocidad
- ✅ Cargar historial: instantáneo (BD local vs API)
- ✅ No hay latencia de red
- ✅ No depende de la velocidad de Podio

### Confiabilidad
- ✅ Funciona sin conexión a Podio
- ✅ No falla si Podio está caído
- ✅ Datos siempre disponibles localmente

## ⚠️ Consideraciones

### Datos Antiguos de Podio
Los backups creados **antes** de este cambio que tengan items en Podio:
- ✅ Seguirán existiendo en Podio
- ✅ NO se eliminarán automáticamente
- ℹ️  Puedes eliminarlos manualmente desde Podio si quieres

### Sincronización
- ❌ El historial local NO se sincroniza con Podio
- ✅ Esto es intencional para evitar llamadas API
- ℹ️  El historial es completamente local y único por instalación

### Backups entre Múltiples Instalaciones
- ⚠️  Cada instalación tiene su propio historial local
- ℹ️  No se comparte entre diferentes computadoras
- ✅ Los archivos de backup sí se guardan en el disco (compartibles)

## 🔍 Validación

### Verificar que NO se crean items en Podio:
1. Iniciar un nuevo backup
2. Buscar en logs: `"✅ Historial local activado - No se crearán items en Podio"`
3. Verificar en Podio que NO se creó un nuevo item

### Verificar que el historial se guarda localmente:
1. Completar un backup
2. Abrir SQLite: `podio-backup.db`
3. Query: `SELECT * FROM scans ORDER BY created_at DESC LIMIT 1`
4. Verificar que el summary tiene los datos correctos

### Verificar que el dashboard lee de BD:
1. Abrir dashboard
2. Buscar en console: `"📋 Dashboard: Historial local cargado con X items"`
3. Verificar que los backups se muestran correctamente

## 🧹 Limpieza de BD

### Cuándo limpiar:
- Cuando quieras empezar desde cero
- Cuando la BD esté muy grande (> 100 MB)
- Para eliminar todos los registros antiguos

### Cómo limpiar desde código:
```typescript
// Limpiar TODO (más agresivo)
await window.electron.db.clearAllData()

// Limpiar solo historial (mantiene caché y configuración)
await window.electron.db.clearBackupHistory()
```

### Limpiar desde SQLite (manual):
```bash
# Abrir la BD
sqlite3 podio-backup.db

# Limpiar todo
DELETE FROM scans;
DELETE FROM scan_apps;
DELETE FROM scan_items;
DELETE FROM scan_files;
DELETE FROM downloads;
DELETE FROM requests;
DELETE FROM rate_limit_status;
DELETE FROM api_cache;
VACUUM;  -- Liberar espacio en disco

.quit
```

## 📝 Migraciones

### Migración desde sistema anterior (con items de Podio):
No se requiere migración. El sistema automáticamente:
1. Deja de crear items nuevos en Podio
2. Empieza a guardar todo en BD local
3. Los backups antiguos siguen visible en BD local (si se crearon con beginScan)

### Preservar historial existente:
El historial en `scans` se mantiene intacto. Solo se deja de usar Podio.

---

**Fecha**: 19 de Noviembre, 2025  
**Versión**: 3.0  
**Estado**: ✅ Implementado y Listo para Usar








