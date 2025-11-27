# Documentación Técnica - Podio Backup

## Índice
1. [Estructura de Base de Datos](#estructura-de-base-de-datos)
2. [Sistema de Caché](#sistema-de-caché)
3. [Flujo de Escaneo](#flujo-de-escaneo)
4. [Flujo de Backup](#flujo-de-backup)
5. [Manejo de Rate Limits](#manejo-de-rate-limits)
6. [Optimizaciones Implementadas](#optimizaciones-implementadas)
7. [API de Podio](#api-de-podio)

---

## Estructura de Base de Datos

### Ubicación
- **Archivo**: `{userData}/podio-backup.db`
- **Motor**: SQLite (better-sqlite3)
- **Modo**: WAL (Write-Ahead Logging)

### Tablas

#### 1. `requests`
Registra todas las peticiones a la API de Podio para tracking de rate limits.

```sql
CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,              -- Timestamp en milisegundos
  method TEXT NOT NULL,                 -- GET, POST, PUT, DELETE
  endpoint TEXT NOT NULL,               -- Ruta del endpoint
  rate_type TEXT NOT NULL,              -- 'general' o 'rateLimited'
  status INTEGER,                       -- Código HTTP de respuesta
  bytes INTEGER,                        -- Tamaño de respuesta en bytes
  meta TEXT                             -- JSON con metadata adicional
);
```

**Índices:**
- `idx_requests_ts`: Sobre `ts_ms` para búsquedas temporales
- `idx_requests_rate_type`: Sobre `(rate_type, ts_ms)` para conteos por tipo

**Funciones relacionadas:**
- `logRequest(params)`: Registra una petición
- `getRequestCountsSince(sinceMs)`: Cuenta requests desde un timestamp
- `getFirstRequestInHourWindow(rateType)`: Obtiene el primer request de la ventana de 1 hora

---

#### 2. `scans`
Almacena información de cada escaneo realizado.

```sql
CREATE TABLE scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,       -- Timestamp de creación
  user TEXT,                            -- Usuario que realizó el escaneo
  org_id INTEGER,                       -- ID de organización (opcional)
  podio_backup_item_id INTEGER,        -- ID del item en Podio que representa este backup
  title TEXT,                           -- Título del escaneo
  summary TEXT                          -- JSON con resumen (apps, items, files, etc.)
);
```

**Índices:**
- `idx_scans_created`: Sobre `created_at_ms` para búsquedas por fecha

**Funciones relacionadas:**
- `beginScan(params)`: Inicia un nuevo escaneo
- `finalizeScan(scanId, summary)`: Finaliza un escaneo con resumen
- `getLastScan()`: Obtiene el último escaneo
- `getScanByPodioItemId(itemId)`: Busca escaneo por ID de item en Podio

---

#### 3. `scan_apps`
Almacena las aplicaciones encontradas en cada escaneo.

```sql
CREATE TABLE scan_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,             -- FK a scans.id
  org_name TEXT NOT NULL,               -- Nombre de la organización
  space_id INTEGER NOT NULL,             -- ID del workspace
  space_name TEXT NOT NULL,             -- Nombre del workspace
  app_id INTEGER NOT NULL,              -- ID de la aplicación
  app_name TEXT NOT NULL,               -- Nombre de la aplicación
  folder_path TEXT NOT NULL,            -- Ruta donde se guardará
  FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
);
```

**Índices:**
- `idx_scan_apps_scan`: Sobre `scan_id` para búsquedas por escaneo

**Funciones relacionadas:**
- `addApp(scanId, params)`: Agrega una app al escaneo
- `getLastScanApps()`: Obtiene apps del último escaneo
- `getScanAppsByScanId(scanId)`: Obtiene apps de un escaneo específico

---

#### 4. `scan_items`
Almacena los items encontrados en cada escaneo.

```sql
CREATE TABLE scan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,             -- FK a scans.id
  app_id INTEGER NOT NULL,              -- ID de la aplicación
  item_id INTEGER NOT NULL,             -- ID del item
  FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
);
```

**Índices:**
- `idx_scan_items_scan`: Sobre `scan_id` para búsquedas por escaneo

**Funciones relacionadas:**
- `addItem(scanId, appId, itemId)`: Agrega un item al escaneo
- `getLastScanItemsCount()`: Cuenta items del último escaneo

---

#### 5. `scan_files`
Almacena los archivos encontrados en cada escaneo.

```sql
CREATE TABLE scan_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,             -- FK a scans.id
  app_id INTEGER NOT NULL,              -- ID de la aplicación
  item_id INTEGER,                      -- ID del item (puede ser NULL si es archivo de app)
  file_id INTEGER NOT NULL,             -- ID del archivo en Podio
  name TEXT NOT NULL,                    -- Nombre del archivo
  size INTEGER,                          -- Tamaño en bytes
  mimetype TEXT,                         -- Tipo MIME
  download_url TEXT NOT NULL,           -- URL de descarga
  folder_path TEXT NOT NULL,            -- Ruta donde se guardará
  FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
);
```

**Índices:**
- `idx_scan_files_scan`: Sobre `scan_id` para búsquedas por escaneo

**Funciones relacionadas:**
- `addFile(scanId, params)`: Agrega un archivo al escaneo
- `addFilesBulk(scanId, files)`: Agrega múltiples archivos (más eficiente)
- `getLastScanFiles()`: Obtiene archivos del último escaneo
- `getScanFilesByScanId(scanId)`: Obtiene archivos de un escaneo específico

---

#### 6. `downloads`
Rastrea el estado de descarga de cada archivo.

```sql
CREATE TABLE downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,             -- FK a scans.id
  file_id INTEGER NOT NULL,             -- ID del archivo
  app_id INTEGER NOT NULL,              -- ID de la aplicación
  item_id INTEGER,                      -- ID del item (puede ser NULL)
  path TEXT NOT NULL,                   -- Ruta local del archivo descargado
  size INTEGER,                          -- Tamaño descargado
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'done', 'error'
  last_try_ms INTEGER,                   -- Último intento de descarga
  tries INTEGER DEFAULT 0,               -- Número de intentos
  FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
);
```

**Índices:**
- `idx_downloads_scan`: Sobre `scan_id` para búsquedas por escaneo
- `idx_downloads_status`: Sobre `status` para filtrar por estado

**Funciones relacionadas:**
- `addDownloadCheckpoint(scanId, fileId, path)`: Crea checkpoint de descarga
- `updateDownloadStatus(fileId, status, size)`: Actualiza estado de descarga
- `isDownloadDone(scanId)`: Verifica si todas las descargas están completas
- `getPendingDownloads(scanId)`: Obtiene descargas pendientes
- `getFailedDownloads(scanId)`: Obtiene descargas fallidas
- `getDownloadStats(scanId)`: Obtiene estadísticas de descarga

---

#### 7. `settings`
Almacena configuraciones de la aplicación.

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT                             -- JSON o texto plano
);
```

---

#### 8. `rate_limit_status`
Almacena el estado de rate limits cuando se detecta un error (420/429).

```sql
CREATE TABLE rate_limit_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rate_type TEXT NOT NULL UNIQUE,       -- 'general' o 'rateLimited'
  triggered_at_ms INTEGER NOT NULL,     -- Cuándo se activó el error
  reset_at_ms INTEGER NOT NULL,         -- Cuándo se resetea (primer request + 1 hora)
  requests_used INTEGER NOT NULL,        -- Cuántos requests se usaron
  limit_value INTEGER NOT NULL           -- Límite configurado (5000)
);
```

**Índices:**
- `idx_rate_limit_type`: Sobre `rate_type` para búsquedas rápidas

**Funciones relacionadas:**
- `saveRateLimitStatus(params)`: Guarda estado de rate limit
- `getRateLimitStatusFromDb(rateType)`: Obtiene estado activo de rate limit
- `clearExpiredRateLimits()`: Limpia rate limits expirados

**Lógica de Reset:**
- El reset se calcula desde el **primer request** de la ventana de 1 hora
- Si no hay requests en la última hora, busca el último request antes de esa hora
- Si el reset ya pasó (más de 1 hora desde el último request), no hay reset pendiente

---

#### 9. `api_cache`
Caché de respuestas de API para evitar llamadas duplicadas.

```sql
CREATE TABLE api_cache (
  endpoint TEXT PRIMARY KEY,             -- Endpoint completo (ej: /org/123/space/)
  response_data TEXT NOT NULL,           -- JSON con la respuesta
  cached_at_ms INTEGER NOT NULL,         -- Cuándo se guardó
  ttl_ms INTEGER NOT NULL,               -- Tiempo de vida en milisegundos
  expires_at_ms INTEGER NOT NULL        -- Cuándo expira
);
```

**Índices:**
- `idx_api_cache_expires`: Sobre `expires_at_ms` para limpieza de expirados

**Funciones relacionadas:**
- `getApiCache(endpoint)`: Obtiene respuesta desde caché (si no expiró)
- `setApiCache(endpoint, data, ttlMs)`: Guarda respuesta en caché
- `clearExpiredApiCache()`: Limpia entradas expiradas

**TTL por tipo:**
- Organizaciones: 1 hora (3600000 ms)
- Workspaces: 30 minutos (1800000 ms)
- Aplicaciones: 30 minutos (1800000 ms)
- Información de archivos: 1 hora (3600000 ms)

---

## Sistema de Caché

### Flag `isScanning`

**Propósito:** Controlar si el sistema debe usar caché durante operaciones de escaneo.

**Ubicación:** `lib/podio-service.ts` - Propiedad privada de la clase `PodioBackupService`

```typescript
private isScanning = false; // Flag para indicar si estamos en modo escaneo (desactiva caché)
```

**Activación:**
- Se activa (`true`) al inicio de `scanBackup()`
- Se desactiva (`false`) en el bloque `finally` de `scanBackup()`

**Comportamiento cuando `isScanning === true`:**
1. **Caché en memoria**: NO se lee ni se escribe (`apiRequest()`)
2. **Caché de BD**: NO se lee ni se escribe en:
   - `getOrganizations()`
   - `getWorkspaces()`
   - `getApplications()`
   - Información de archivos (`/file/{file_id}`)

**Comportamiento cuando `isScanning === false`:**
- El sistema usa caché normalmente para optimizar llamadas
- Útil para operaciones que no requieren datos frescos

### Flujo de Caché

```
┌─────────────────────────────────────────────────────────┐
│  Operación Normal (isScanning = false)                  │
├─────────────────────────────────────────────────────────┤
│  1. Verificar caché en memoria                         │
│  2. Si no existe, verificar caché de BD                │
│  3. Si no existe, hacer llamada API                    │
│  4. Guardar en caché (memoria y BD)                     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Escaneo (isScanning = true)                            │
├─────────────────────────────────────────────────────────┤
│  1. NO verificar caché                                 │
│  2. Hacer llamada API directamente                      │
│  3. NO guardar en caché                                │
│  4. Obtener datos frescos siempre                       │
└─────────────────────────────────────────────────────────┘
```

### Razón del Diseño

**Problema original:**
- El escaneo usaba datos cacheados, causando conteos incorrectos
- Los contadores no avanzaban porque se reutilizaban datos antiguos

**Solución:**
- Durante el escaneo, siempre obtener datos frescos de la API
- El caché solo se usa para operaciones que no requieren datos actualizados
- Permite que los contadores avancen correctamente

---

## Flujo de Escaneo

### Función Principal: `scanBackup()`

**Ubicación:** `lib/podio-service.ts`

**Parámetros:**
- `options: BackupOptions` - Qué escanear (organizations, workspaces, apps, items, files)
- `progressCallback?: ProgressCallback` - Callback para actualizar progreso
- `useLastScan: boolean = false` - Si usar escaneo previo desde BD

### Pasos del Escaneo

#### 1. Inicialización
```typescript
this.isScanCancelled = false;
this.isScanning = true; // Activar modo escaneo (desactiva caché)
```

#### 2. Crear Item en Podio
- Intenta crear el registro de backup en Podio
- Si hay rate limit, pausa inmediatamente en 1%

#### 3. Verificar Escaneo Previo (solo si `useLastScan === true`)
- Busca escaneo reciente (< 1 hora) en BD
- Si existe y NO está vacío, carga datos desde BD
- Si está vacío o no existe, continúa con escaneo nuevo

#### 4. Generar Timestamp Único
```typescript
this.backupTimestamp = this.generateBackupTimestamp();
// Formato: backup_YYYYMMDD_HHMMSS
```

#### 5. Limpiar Caché Expirado
- Llama a `clearExpiredApiCache()` para limpiar BD

#### 6. Iniciar Escaneo en BD
- Crea registro en tabla `scans`
- Guarda `podio_backup_item_id` para referencia

#### 7. Obtener Organizaciones
- Llama a `getOrganizations()` (sin caché si `isScanning === true`)
- Procesa cada organización secuencialmente

#### 8. Procesar Organización (`processOrganizationParallel`)
Para cada organización:
- Obtener workspaces (`getWorkspaces()` - sin caché)
- Procesar cada workspace secuencialmente

#### 9. Procesar Workspace (`processWorkspaceParallel`)
Para cada workspace:
- Obtener aplicaciones (`getApplications()` - sin caché)
- Procesar cada aplicación secuencialmente

#### 10. Procesar Aplicación (`processApplicationParallel`)
Para cada aplicación:
- Obtener items (`getItems()` - paginación directa, sin `/count`)
- Para cada item:
  - Verificar si incluye archivos en respuesta (optimización)
  - Si no, obtener archivos (`getItemFiles()`)
  - Obtener tamaño de archivos (sin caché si `isScanning === true`)
- Guardar en BD: `addApp()`, `addItem()`, `addFile()`

#### 11. Actualizar Contadores
- `backupCounts`: Contadores incrementales (organizations, workspaces, apps, items, files)
- `backupStats`: Estadísticas (backupSize, etc.)

#### 12. Finalizar Escaneo
- Guardar resumen en BD (`finalizeScan()`)
- Actualizar item en Podio (solo si NO hay rate limit activo)
- Actualizar progreso a 99% (solo si NO hay rate limit activo)

#### 13. Limpieza
```typescript
finally {
  this.isScanning = false; // Desactivar modo escaneo
}
```

### Manejo de Rate Limits Durante Escaneo

**Si se detecta rate limit:**
1. Progreso se establece en 1%
2. Se lanza error `RATE_LIMIT_ERROR:${waitTime}:${limitType}`
3. NO se actualiza item en Podio
4. NO se guarda progreso a 99%
5. El proceso se detiene inmediatamente

**Verificación de Rate Limit:**
- `enqueueRequest()` verifica rate limit activo ANTES de hacer petición
- Si hay rate limit activo, lanza error inmediatamente
- Previene que se sigan haciendo peticiones después de un error

### Cancelación de Escaneo

**Flag:** `isScanCancelled`

**Activación:**
- Usuario presiona botón "Parar Escaneo"
- Llama a `cancelScan()`

**Verificación:**
- En cada loop (organizaciones, workspaces, apps, items)
- Si `isScanCancelled === true`, lanza `ESCANEO_CANCELADO`

**Manejo:**
- No muestra error, solo mensaje "Escaneo cancelado"
- Progreso se mantiene en último valor

---

## Flujo de Backup

### Función Principal: `performBackup()`

**Ubicación:** `lib/podio-service.ts`

**Parámetros:**
- `options: BackupOptions` - Qué respaldar
- `progressCallback?: ProgressCallback` - Callback para actualizar progreso
- `useLastScan: boolean = false` - Si usar escaneo previo

### Pasos del Backup

#### 1. Crear Item en Podio
- Crea registro de backup en Podio

#### 2. Generar Timestamp (si no existe)
- Si no hay `backupTimestamp`, genera uno nuevo

#### 3. Cargar Datos del Escaneo
- Si `useLastScan === true`, carga desde BD
- Si no, debe ejecutar `scanBackup()` primero

#### 4. Descargar Archivos
- Para cada archivo en `scannedFiles`:
  - Verificar si ya existe localmente
  - Si no, descargar desde `downloadUrl`
  - Guardar en `folderPath`
  - Actualizar estado en BD (`updateDownloadStatus()`)

#### 5. Descargar Excels
- Para cada app en `scannedApps`:
  - Llamar a `downloadAppExcel(appId)`
  - Guardar en `folderPath`

#### 6. Actualizar Progreso
- Actualizar contadores de descarga
- Calcular tamaño total descargado

---

## Manejo de Rate Limits

### Límites Configurados

```javascript
const RATE_LIMIT_HOUR = 5000;  // Requests por hora
const RATE_LIMIT_DAY = 60000;  // Requests por día
```

**Nota:** Tanto `general` como `rateLimited` usan el mismo límite (5000/hora).

### Delay Entre Requests

```typescript
private readonly REQUEST_DELAY_MS = 1000; // 1 segundo entre requests
```

**Cálculo:**
- 5000 req/hora = 1.39 req/segundo
- Con 1000ms delay = 1 req/segundo = 3600 req/hora (seguro)
- Evita hacer las 5000 llamadas en 10 minutos

### Detección de Rate Limit

**Códigos HTTP:**
- `420`: Rate limit alcanzado
- `429`: Too Many Requests

**Flujo de Detección:**

```
1. apiRequest() recibe respuesta 420/429
2. Extrae tiempo de espera del mensaje de error
3. Guarda estado en BD (rate_limit_status)
4. Calcula reset desde primer request de la hora
5. Lanza error: RATE_LIMIT_ERROR:${waitTime}:${limitType}
```

### Cálculo de Reset

**Función:** `getFirstRequestInHourWindow(rateType)`

**Lógica:**
1. Busca primer request en la última hora
2. Si no hay, busca último request antes de esa hora
3. Si el reset ya pasó (> 1 hora desde último request), retorna `null`
4. Reset = primer request + 1 hora

**Ejemplo:**
```
Request 1: 10:00:00 (primer request de la hora)
Request 2: 10:15:00
Request 3: 10:30:00
Error 420: 10:45:00

Reset calculado: 11:00:00 (10:00:00 + 1 hora)
Tiempo de espera: 15 minutos (hasta 11:00:00)
```

### Espera y Reintento

**Función:** `waitForRateLimit(waitTimeSeconds, limitType)`

**Lógica:**
1. Obtiene tiempo real desde BD (`getRateLimitStatusFromDb()`)
2. Si `waitTime >= 1 hora`:
   - Espera tiempo completo
   - Luego intenta cada 5 minutos hasta que funcione (máx 12 intentos = 1 hora más)
3. Si `waitTime < 1 hora`:
   - Espera tiempo exacto calculado
   - Continúa automáticamente

### Prevención de Peticiones Durante Rate Limit

**Función:** `enqueueRequest()`

**Verificación:**
```typescript
// Verificar si hay un error de rate limit activo ANTES de hacer la petición
const errorStatus = await window.electron.db.getRateLimitStatusFromDb(limitType)
if (errorStatus.active && errorStatus.resetInSeconds > 0) {
  // NO hacer la petición, lanzar error inmediatamente
  throw new Error(`RATE_LIMIT_ERROR:${waitTime}:${limitType}`)
}
```

**Resultado:**
- Previene que se sigan haciendo peticiones después de un error
- El proceso se detiene inmediatamente
- No se consume más del límite

---

## Optimizaciones Implementadas

### 1. Paginación Directa (Sin `/count`)

**Antes:**
```typescript
// Llamada 1: GET /item/app/{appId}/count
// Llamada 2-N: GET /item/app/{appId}?limit=500&offset=0
```

**Ahora:**
```typescript
// Solo llamadas: GET /item/app/{appId}?limit=500&offset=0
// Continúa hasta que no hay más items
```

**Ahorro:** 1 llamada por aplicación

### 2. Archivos Incluidos en Respuesta de Items

**Optimización:**
- Verificar si `item.files` está presente en respuesta de `/item/app/`
- Si está, usar esos archivos directamente
- Si no, hacer llamada adicional a `/item/{itemId}`

**Ahorro:** 1 llamada por item que incluye archivos en respuesta

### 3. Procesamiento Secuencial

**Antes:**
- Procesamiento paralelo de organizaciones, workspaces, apps
- Múltiples peticiones simultáneas

**Ahora:**
- Procesamiento secuencial (1 a la vez)
- Delay de 1000ms entre peticiones
- Previene saturación de API

**Beneficio:**
- Mejor control de rate limits
- Si hay error, se detiene inmediatamente
- No hay peticiones "en vuelo" que continúan después de un error

### 4. Caché Desactivado Durante Escaneo

**Beneficio:**
- Datos siempre frescos durante escaneo
- Contadores avanzan correctamente
- No se reutilizan datos antiguos

### 5. Timestamp Único por Backup

**Formato:** `backup_YYYYMMDD_HHMMSS`

**Beneficio:**
- Cada backup tiene carpeta única
- No se sobrescriben backups anteriores
- Fácil identificación por fecha/hora

### 6. Limpieza Automática de Caché Expirado

**Función:** `clearExpiredApiCache()`

**Cuándo se ejecuta:**
- Al inicio de cada escaneo nuevo
- Limpia entradas con `expires_at_ms <= now`

**Beneficio:**
- Mantiene BD limpia
- Evita crecimiento excesivo de caché

---

## API de Podio

### Endpoints Utilizados

#### Organizaciones
- `GET /org/` - Lista todas las organizaciones

#### Workspaces
- `GET /org/{orgId}/space/` - Lista workspaces de una organización

#### Aplicaciones
- `GET /app/space/{spaceId}/` - Lista aplicaciones de un workspace

#### Items
- `GET /item/app/{appId}` - Lista items de una aplicación (paginado)
  - Parámetros: `limit=500`, `offset={offset}`
  - Puede incluir `files` en respuesta (optimización)

#### Archivos
- `GET /item/{itemId}` - Obtiene detalles de un item (incluye archivos si no vienen en `/item/app/`)
- `GET /file/{fileId}` - Obtiene información de un archivo (tamaño, etc.)

#### Excel
- `GET /app/{appId}/excel/` - Descarga Excel oficial de una aplicación

#### Backup Items
- `POST /item/app/{appId}` - Crea item de backup en Podio
- `PUT /item/{itemId}` - Actualiza item de backup

### Rate Limits

**Límites:**
- 5000 requests por hora (general y rateLimited unificados)
- 60000 requests por día

**Headers de Respuesta:**
- `X-RateLimit-Limit`: Límite total
- `X-RateLimit-Remaining`: Requests restantes
- `X-RateLimit-Reset`: Timestamp de reset

**Códigos de Error:**
- `420`: Rate limit alcanzado
- `429`: Too Many Requests

---

## Notas Importantes

### 1. Escaneo Siempre Obtiene Datos Frescos
- Durante `scanBackup()`, `isScanning = true`
- NO se usa caché (ni memoria ni BD)
- Garantiza contadores correctos

### 2. Rate Limits Pausan Inmediatamente
- `enqueueRequest()` verifica rate limit ANTES de hacer petición
- Si hay error activo, lanza error inmediatamente
- Proceso se detiene, no continúa haciendo peticiones

### 3. Reset Basado en Primer Request
- El reset se calcula desde el primer request de la hora
- No desde el último request
- Asegura que el límite se respete correctamente

### 4. Procesamiento Secuencial
- Todas las operaciones son secuenciales (1 a la vez)
- Delay de 1000ms entre peticiones
- Previene saturación y permite mejor control

### 5. Caché Solo Para Operaciones No-Críticas
- El caché se usa para optimizar llamadas que no requieren datos frescos
- Durante escaneo, siempre se obtienen datos frescos
- Durante backup, se puede usar escaneo previo si el usuario lo solicita

---

## Archivos Clave

### Base de Datos
- `main/db.js` - Funciones de base de datos SQLite
- `main.js` - IPC handlers para base de datos

### Lógica de Negocio
- `lib/podio-service.ts` - Servicio principal de Podio (escaneo, backup, rate limits)
- `lib/podio-service-electron.ts` - Extensión para Electron (operaciones de archivos)

### Interfaz
- `app/dashboard-electron/page.tsx` - UI principal de Electron
- `preload.js` - Bridge entre main y renderer process
- `types/electron.d.ts` - Tipos TypeScript para Electron API

---

## Mejoras Futuras Sugeridas

1. **Reintento Automático Después de Rate Limit**
   - Actualmente se pausa, pero no reintenta automáticamente
   - Podría agregar lógica para reanudar cuando expire el rate limit

2. **Compresión de Caché**
   - Para respuestas grandes, comprimir antes de guardar en BD
   - Reducir tamaño de `api_cache`

3. **Métricas y Analytics**
   - Tracking de tiempo de escaneo
   - Análisis de patrones de rate limits
   - Optimización de delays basada en historial

4. **Paralelismo Controlado**
   - Permitir paralelismo limitado (ej: 2-3 requests simultáneos)
   - Con mejor control de rate limits

5. **Cache Warming**
   - Pre-cargar datos comunes antes de escaneo
   - Reducir tiempo total de escaneo

---

**Última actualización:** 2025-01-07
**Versión:** 1.0










