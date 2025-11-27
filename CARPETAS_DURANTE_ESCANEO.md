# Creación de Carpetas Durante el Escaneo

## 📋 Resumen
Se ha modificado el sistema para que las carpetas se creen durante la fase de escaneo, no solo durante la descarga. Esto asegura que cuando se inicie un backup desde un escaneo previo, las carpetas ya existan y el sistema pueda ir directo a descargar archivos.

## 🎯 Problema Resuelto
**Antes**: Las carpetas solo se creaban durante la descarga, lo que causaba que:
- Si se usaba "Usar Último Escaneo", el sistema no tenía la información de las carpetas
- El sistema tenía que escanear de nuevo en lugar de ir directo a descargar
- No se guardaba el `folderPath` en la base de datos durante el escaneo

**Ahora**: Las carpetas se crean durante el escaneo, permitiendo:
- ✅ Usar "Usar Último Escaneo" y ir directo a descargar
- ✅ Las carpetas ya existen cuando inicia la descarga
- ✅ El `folderPath` se guarda en la BD durante el escaneo
- ✅ Los archivos se registran en la BD con su ubicación

## 🔧 Cambios Implementados

### 1. Modificación de `processApplicationParallel` (lib/podio-service.ts)
**Archivo**: `lib/podio-service.ts` (líneas 1433-1537)

**Cambios**:
- En modo `scanOnly`, ahora se crean las carpetas para cada app usando `createFolderStructure()`
- Se obtienen todos los items de la app (que incluyen archivos en la respuesta)
- Se extraen los archivos de cada item y se guardan en la BD
- Se actualiza el `folderPath` en la BD para cada app
- Se guardan los archivos en `scannedFiles` y `scannedFilesComplete`

**Beneficios**:
- El escaneo ahora obtiene la estructura completa (apps + archivos) en una sola pasada
- Los archivos ya vienen incluidos en la respuesta de `/item/app/{app_id}/` (optimización)
- No se requieren llamadas adicionales a `/item/{item_id}/file`

### 2. Modificación de `createFolderStructure` (lib/podio-service-electron.ts)
**Archivo**: `lib/podio-service-electron.ts` (líneas 194-217)

**Cambios**:
- Se modificó para usar `backupTimestamp` en la construcción del `folderPath`
- Ahora las carpetas se crean como: `{backupPath}/{backupTimestamp}/{org}/{workspace}/{app}/files/`

**Antes**:
```typescript
const folderPath = path.join(this.backupPath, safeOrgName, safeWorkspaceName, safeAppName)
```

**Ahora**:
```typescript
const basePath = this.backupTimestamp 
  ? path.join(this.backupPath, this.backupTimestamp)
  : this.backupPath
const folderPath = path.join(basePath, safeOrgName, safeWorkspaceName, safeAppName)
```

### 3. Extracción del Timestamp del Escaneo Original (Nuevo!)
**Archivo**: `lib/podio-service.ts` (líneas 4877-4887)

**Cambios**:
- Cuando se carga un escaneo previo desde la BD (usando "Usar Último Escaneo")
- Se extrae el timestamp de la carpeta del `folderPath` guardado
- Se reutiliza ese timestamp para la descarga

**Antes**:
```typescript
// No se extraía el timestamp, se generaba uno nuevo
if (!this.backupTimestamp) {
  this.backupTimestamp = this.generateBackupTimestamp();
}
```

**Ahora**:
```typescript
// Extraer timestamp del folderPath del primer app
if (apps.length > 0 && apps[0].folder_path) {
  const pathParts = apps[0].folder_path.split(/[\/\\]/);
  const timestampFolder = pathParts.find((part: string) => part.startsWith('backup_'));
  if (timestampFolder) {
    this.backupTimestamp = timestampFolder;
    this.addLog("info", `📅 Usando timestamp del escaneo original: ${this.backupTimestamp}`);
  }
}
```

**Beneficio**: Asegura que el escaneo y la descarga usen la MISMA carpeta con timestamp

### 4. Guardar Apps y Archivos en BD durante Escaneo
**Archivo**: `lib/podio-service.ts` (líneas 1477-1510)

**Cambios**:
- Se llama a `window.electron.db.addApp()` para guardar cada app con su `folderPath`
- Se llama a `window.electron.db.addFile()` para cada archivo encontrado
- Los archivos se guardan con su `folder_path` como `{app_folder}/files`

**Estructura guardada en BD**:
```javascript
// Apps
{
  org_name: "Casa Virtual",
  space_id: 10365239,
  space_name: "Activos Fijos",
  app_id: 30376118,
  app_name: "Activos fijos",
  folder_path: "C:/backups/backup_20251118_193259/Casa_Virtual/Activos_Fijos/Activos_fijos"
}

// Archivos
{
  app_id: 30376118,
  file_id: 2189670749,
  name: "documento.pdf",
  size: 1024000,
  mimetype: "application/pdf",
  download_url: "https://files.podio.com/2189670749",
  folder_path: "C:/backups/backup_20251118_193259/Casa_Virtual/Activos_Fijos/Activos_fijos/files"
}
```

## 📊 Flujo Actualizado

### Escaneo (Paso 1)
1. Usuario hace clic en "Iniciar Escaneo"
2. Sistema procesa cada organización → workspace → app
3. **Para cada app**:
   - ✅ **Crear carpeta** `Backup_timestamp/Org/Workspace/App/files/`
   - ✅ Obtener items (con archivos incluidos)
   - ✅ Extraer archivos de los items
   - ✅ **Guardar app en BD** con `folderPath`
   - ✅ **Guardar cada archivo en BD** con su ubicación
   - ✅ Actualizar contadores (items, archivos, tamaño)
4. Sistema guarda resumen del escaneo en BD

### Descarga (Paso 2)
1. Usuario hace clic en "Usar Último Escaneo" → "Iniciar Respaldo"
2. Sistema carga apps y archivos desde BD
3. **Para cada app**:
   - ✅ Las carpetas **ya existen** (creadas en el escaneo)
   - ✅ Descargar Excel oficial a `{app_folder}/`
   - ✅ Descargar archivos a `{app_folder}/files/`
4. Sistema actualiza el registro en Podio

## 🚀 Mejoras de Performance

### Antes (Sin optimización)
- **Escaneo**: Solo contaba items (rápido pero sin info de archivos)
- **Descarga**: Tenía que escanear de nuevo si se usaba "Usar Último Escaneo"
- **Total**: 2 escaneos completos

### Ahora (Con optimización)
- **Escaneo**: Obtiene items + archivos + crea carpetas (un poco más lento pero completo)
- **Descarga**: Va directo a descargar (sin escaneo)
- **Total**: 1 solo escaneo

### Ventajas
- ✅ **50% menos llamadas API** (un solo escaneo vs dos)
- ✅ **Carpetas persistentes** incluso si se interrumpe el proceso
- ✅ **Reinicio más rápido** después de rate limit
- ✅ **UI coherente** al usar "Usar Último Escaneo"

## 🔍 Logs Mejorados

El sistema ahora genera logs más detallados durante el escaneo:

```
📊 [MODO ESCANEO] Procesando app: Activos fijos
✅ [MODO ESCANEO] Carpetas creadas para: Activos fijos
💾 [MODO ESCANEO] App guardada en BD: Activos fijos → C:/backups/.../Activos_fijos
💾 [MODO ESCANEO] 15 archivos guardados en BD para Activos fijos
✅ [MODO ESCANEO] App "Activos fijos": 42 items, 15 archivos (Total: 42 items, 15 archivos)
```

## 🎨 Coherencia de UI

Cuando el usuario marca "Usar Último Escaneo":
1. ✅ La UI carga inmediatamente los stats del último escaneo
2. ✅ Se muestran las métricas (apps, items, archivos, tamaño)
3. ✅ El botón "Iniciar Respaldo" se habilita
4. ✅ Al hacer clic, va **directo a descargar** (sin escanear)
5. ✅ Los logs confirman: `"⏩ Saltando escaneo, yendo DIRECTO a descarga..."`

## 📁 Estructura de Carpetas Final

```
C:\Users\DejusBackup\Documents\backups\
└── backup_20251118_193259\              ← ⭐ Carpeta única por backup (timestamp)
    └── Casa_Virtual\                     ← Organización
        └── Activos_Fijos\                ← Workspace
            └── Activos_fijos\            ← Aplicación
                ├── files\                ← Archivos de la app
                │   ├── documento1.pdf
                │   ├── imagen.jpg
                │   └── ...
                └── Activos_fijos_oficial.xlsx  ← Excel de Podio
```

### ⚠️ Importante: Timestamp Único por Backup

**Formato del timestamp**: `backup_YYYYMMDD_HHMMSS`
- Ejemplo: `backup_20251118_193259` (18 de Noviembre 2025, 19:32:59)

**Comportamiento**:
1. **Durante Escaneo**: Se genera un nuevo timestamp al inicio (`generateBackupTimestamp()`)
2. **Durante Descarga con "Usar Último Escaneo"**: Se extrae y reutiliza el timestamp del escaneo original desde la BD
3. **Backup Directo (sin escaneo previo)**: Se genera un nuevo timestamp

Esto asegura que:
- ✅ Cada backup tiene su propia carpeta única
- ✅ Los escaneos y sus descargas correspondientes usan el MISMO timestamp
- ✅ Es fácil identificar cuándo se hizo cada backup
- ✅ No hay conflictos entre diferentes backups

## ✅ Validación

### Verificar que las carpetas se crean durante escaneo:
1. Iniciar un escaneo
2. Buscar en los logs: `"✅ [MODO ESCANEO] Carpetas creadas para: {app_name}"`
3. Verificar en el sistema de archivos que las carpetas existen
4. Verificar en la BD que el `folder_path` está guardado

### Verificar que se usa el último escaneo:
1. Marcar checkbox "Usar Último Escaneo"
2. Hacer clic en "Iniciar Respaldo"
3. Buscar en los logs: `"⏩ Saltando escaneo, yendo DIRECTO a descarga..."`
4. Verificar que NO aparecen logs de escaneo (`"📊 [MODO ESCANEO]"`)
5. Verificar que sí aparecen logs de descarga (`"📥 Descargando:"`)

## 🐛 Problemas Resueltos

### Problema 1: Rate Limit Inmediato
**Causa**: El sistema escaneaba de nuevo aunque se marcara "Usar Último Escaneo"
**Solución**: Ahora el escaneo guarda toda la información necesaria (apps + archivos + carpetas)

### Problema 2: Carpetas No Se Creaban
**Causa**: Las carpetas solo se creaban durante la descarga, pero si se interrumpía antes, no existían
**Solución**: Las carpetas se crean durante el escaneo y se persisten en BD

### Problema 3: UI Incoherente con "Usar Último Escaneo"
**Causa**: El UI no cargaba los stats al marcar el checkbox
**Solución**: El UI ahora carga inmediatamente los datos del último escaneo (implementado previamente)

## 📝 Notas Adicionales

- Las carpetas se crean con permisos verificados usando `verifyWritePermissions()`
- La subcarpeta `files/` se crea automáticamente dentro de cada app
- El `backupTimestamp` asegura que cada backup tenga su propia carpeta única
- Los archivos en BD se guardan con `item_id: null` ya que no es necesario para la descarga
- El sistema sigue siendo compatible con el flujo antiguo (backup directo sin escaneo previo)

## 🔄 Compatibilidad

Estos cambios son **completamente compatibles** con el flujo existente:
- ✅ El backup directo (sin escaneo previo) sigue funcionando
- ✅ El backup completo (escaneo + descarga en una sola operación) sigue funcionando
- ✅ La reanudación desde checkpoints sigue funcionando
- ✅ Los escaneos antiguos en BD siguen siendo utilizables

---

**Fecha**: 18 de Noviembre, 2025  
**Versión**: 2.0  
**Estado**: ✅ Implementado y Validado

