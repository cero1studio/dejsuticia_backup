import type { PodioBackupService } from './podio-service';
import type { BackupOptions, ProgressCallback } from './podio-service';
import { isTestMode, TEST_MODE_CONFIG } from './podio-service-scan-utils';
import { initializeScan } from './podio-service-scan-initialization';
import { createBackupRecordWithRetries } from './podio-service-scan-backup-record';
import { checkAndResumeLastScan } from './podio-service-scan-resume';
import { processOrganizations } from './podio-service-scan-processing';
import {
  buildScannedFilesComplete,
  calculateFinalStats,
  finalizeScan,
  updateBackupItemInPodio
} from './podio-service-scan-finalization';

/**
 * PROCESO DE ESCANEO CON MANEJO DE RATE LIMITS Y REINTENTOS AUTOMÁTICOS
 * ========================================================================
 * Este método escanea toda la estructura de Podio (organizaciones, workspaces, apps, items, archivos)
 * y guarda la información en BD para su uso posterior en el respaldo.
 * 
 * CARACTERÍSTICAS:
 * 1. Detección automática de rate limits (420/429) de la API de Podio
 * 2. Pausa automática cuando se alcanza el límite de tasa
 * 3. Reintentos automáticos después del tiempo de espera (cronómetro regresivo)
 * 4. Guardado incremental en BD para recuperación en caso de errores
 * 5. Reutilización de escaneos recientes (< 1 hora) si se solicita
 * 
 * FLUJO DE RATE LIMITS:
 * - Si la API responde con error 420/429, se guarda el estado en BD
 * - Se calcula el tiempo de espera real desde el primer request de la hora
 * - Se pausa automáticamente mostrando cronómetro regresivo
 * - Después del tiempo de espera, se reintenta automáticamente
 * - El proceso continúa desde donde se quedó (sin perder progreso)
 * 
 * @param instance - Instancia de PodioBackupService
 * @param options - Opciones de respaldo (organizaciones, workspaces, apps a incluir)
 * @param progressCallback - Callback para reportar progreso
 * @param useLastScan - Si true, intenta reutilizar el último escaneo (< 1 hora)
 * @param scanOnly - Si true, solo escanea sin descargar archivos
 */
export async function scanBackupImpl(
  instance: PodioBackupService,
  options: BackupOptions, 
  progressCallback?: ProgressCallback, 
  useLastScan: boolean = false,
  scanOnly: boolean = true
): Promise<void> {
  try {
    // ========================================================================
    // INICIALIZACIÓN
    // ========================================================================
    await initializeScan(instance, useLastScan);
    
    // ========================================================================
    // CREAR REGISTRO DE BACKUP EN PODIO
    // ========================================================================
    await createBackupRecordWithRetries(instance, progressCallback);
    
    // ========================================================================
    // VERIFICAR ESCANEO RECIENTE (solo si useLastScan es true)
    // ========================================================================
    if (useLastScan) {
      const shouldReturn = await checkAndResumeLastScan(instance, progressCallback);
      if (shouldReturn) {
        return; // Se cargó un escaneo completo o incompleto, no continuar
      }
    }
    
    // ========================================================================
    // PREPARACIÓN DEL ESCANEO
    // ========================================================================
    // OPTIMIZACIÓN: Generar timestamp único para este backup
    instance.backupTimestamp = instance.generateBackupTimestamp();
    const backupPathWithTimestamp = `${instance.backupPath}/${instance.backupTimestamp}`;
    instance.addLog("info", `🗄️ Carpeta de backup única: ${backupPathWithTimestamp}`);
    
    // Limpiar caché al inicio de un nuevo escaneo (tanto en memoria como en BD)
    // IMPORTANTE: En un escaneo nuevo, NO usar caché para obtener siempre datos frescos
    instance.clearCache(); // Limpiar caché en memoria
    if (typeof window !== 'undefined' && window.electron && window.electron.db) {
      await window.electron.db.clearExpiredApiCache(); // Limpiar caché de BD
    }
    instance.addLog("info", "🗑️ Caché limpiado: Escaneo nuevo obtendrá datos frescos de la API");
    
    instance.addLog("info", "Iniciando escaneo de respaldo...");
    
    // Iniciar escaneo en BD si está disponible
    if (typeof window !== 'undefined' && window.electron && window.electron.db) {
      try {
        console.log(`🔍 scanBackup: instance.backupItemId = ${instance.backupItemId}`);
        instance.addLog("info", `📊 Iniciando escaneo en BD con podio_backup_item_id: ${instance.backupItemId || 'NO DEFINIDO'}`);
        
        const scanResult = await window.electron.db.beginScan({
          user: undefined,
          org_id: undefined,
          podio_backup_item_id: instance.backupItemId || undefined,
          title: `Backup scan - ${new Date().toISOString()}`
        });
        if (scanResult.success && scanResult.scanId) {
          instance.currentScanId = scanResult.scanId;
          instance.addLog("info", `📊 Escaneo iniciado en BD (ID: ${instance.currentScanId}, podio_backup_item_id: ${instance.backupItemId || 'N/A'})`);
          console.log(`✅ Escaneo iniciado: scan_id=${scanResult.scanId}, podio_backup_item_id=${instance.backupItemId}`);
        } else {
          console.error(`❌ Error iniciando escaneo:`, scanResult);
          instance.addLog("error", `❌ No se pudo iniciar el escaneo en BD`);
        }
      } catch (dbError) {
        console.error('❌ Error iniciando escaneo en BD:', dbError);
        instance.addLog("error", `❌ Error iniciando escaneo en BD: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
      }
    }
    
    // Mostrar información del modo de prueba si está activo
    if (isTestMode()) {
      instance.addLog("warning", "🧪 ========== MODO DE PRUEBA ACTIVO ==========");
      instance.addLog("warning", `🧪 Workspaces: ${TEST_MODE_CONFIG.workspacesPercent}% (máx ${TEST_MODE_CONFIG.maxWorkspaces})`);
      instance.addLog("warning", `🧪 Aplicaciones: ${TEST_MODE_CONFIG.applicationsPercent}% (máx ${TEST_MODE_CONFIG.maxApps})`);
      instance.addLog("warning", `🧪 Items: ${TEST_MODE_CONFIG.itemsPercent}% (máx ${TEST_MODE_CONFIG.maxItems})`);
      instance.addLog("warning", `🧪 Archivos: ${TEST_MODE_CONFIG.filesPercent}% (máx ${TEST_MODE_CONFIG.maxFiles})`);
      instance.addLog("warning", "🧪 ==========================================");
    }
    
    // Reiniciar contadores y estadísticas
    instance.scannedFiles = [];
    instance.scannedStats = null;
    instance.scannedApps = [];
    // Inicializar scannedFilesComplete como array vacío
    if (!instance.scannedFilesComplete) {
      instance.scannedFilesComplete = [];
    }
    
    instance.backupCounts = {
      organizations: 0,
      workspaces: 0,
      applications: 0,
      items: 0,
      files: 0,
      downloadedFiles: 0,
    };
    
    instance.backupStats = {
      apps: 0,
      items: 0,
      workspaces: 0,
      files: 0,
      backupSize: 0,
      successfulBackups: 0,
      backupWarnings: 0,
      downloadedFiles: 0,
      downloadedBytes: 0,
    };
    
    instance.lastProgress = 0;
    
    // Verificar autenticación
    if (!instance.authData) {
      instance.addLog("error", "No autenticado. Llama a authenticate() primero.");
      throw new Error("No autenticado");
    }
    
    // Obtener organizaciones
    const organizations = await instance.getOrganizations();
    instance.backupCounts.organizations = organizations.length;
    
    // OPTIMIZACIÓN: NO contar por adelantado - contar mientras se escanea para evitar llamadas duplicadas
    instance.addLog("info", "🚀 Iniciando escaneo optimizado (sin conteo previo para evitar llamadas duplicadas)...");
    instance.addLog("info", `🔍 DEBUG: Después de log 'Iniciando escaneo optimizado' - organizations.length = ${organizations.length}`);
    
    // Notificar progreso inicial
    try {
      if (progressCallback) {
        instance.addLog("info", `🔍 DEBUG: Llamando updateProgress con progreso 1...`);
        instance.updateProgress(1, `Escaneando... (0 apps, 0 items, 0 archivos, 0.00 GB)`, progressCallback);
        instance.addLog("info", `🔍 DEBUG: updateProgress completado`);
      } else {
        instance.addLog("info", `🔍 DEBUG: No hay progressCallback disponible`);
      }
    } catch (error) {
      instance.addLog("error", `❌ ERROR en updateProgress: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    
    // ========================================================================
    // DOCUMENTACIÓN DEL MODO DE ESCANEO
    // ========================================================================
    if (scanOnly) {
      instance.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      instance.addLog("info", "🚀 MODO ESCANEO RÁPIDO ACTIVADO");
      instance.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      instance.addLog("info", "📚 Este modo solo obtiene la estructura organizacional y conteos:");
      instance.addLog("info", "   ✅ Organizaciones → Workspaces → Apps → Conteo de items");
      instance.addLog("info", "   ✅ NO consulta cada item individualmente");
      instance.addLog("info", "   ✅ NO obtiene información de archivos");
      instance.addLog("info", "   ✅ Guarda estructura completa en base de datos");
      instance.addLog("info", "");
      instance.addLog("info", "🎯 BENEFICIOS:");
      instance.addLog("info", "   ⚡ 95% menos llamadas API durante escaneo");
      instance.addLog("info", "   ⏱️  Tiempo de escaneo reducido de horas a minutos");
      instance.addLog("info", "   📈 Drásticamente menos probabilidad de rate limits");
      instance.addLog("info", "   💾 Estructura guardada para uso posterior en respaldo");
      instance.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    } else {
      instance.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      instance.addLog("info", "💾 MODO RESPALDO COMPLETO ACTIVADO");
      instance.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      instance.addLog("info", "📚 Este modo obtiene información completa:");
      instance.addLog("info", "   ✅ Todos los items de cada aplicación");
      instance.addLog("info", "   ✅ Todos los archivos de cada item");
      instance.addLog("info", "   ✅ Información detallada para descarga");
      instance.addLog("info", "");
      instance.addLog("info", "⚠️  ADVERTENCIA:");
      instance.addLog("info", "   ⏱️  Este proceso puede tomar varias horas");
      instance.addLog("info", "   📞 Realiza muchas llamadas a la API");
      instance.addLog("info", "   ⏳  Mayor probabilidad de pausas por rate limit");
      instance.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    }
    
    // OPTIMIZACIÓN: Escanear organizaciones en paralelo
    instance.addLog("info", `🚀 INICIANDO PROCESAMIENTO OPTIMIZADO`);
    instance.addLog("info", `🏢 Organizaciones a procesar: ${organizations.length}`);
    instance.addLog("info", `⚡ Límites de Podio API: ${instance.PODIO_RATE_LIMITS.general} requests/hora (general), ${instance.PODIO_RATE_LIMITS.rateLimited} requests/hora (rate-limited)`);
    instance.addLog("info", `📚 Procesamiento: SECUENCIAL (1 a la vez) para evitar rate limit`);
    instance.addLog("info", `✅ Optimizaciones activas: Paginación + Reintentos + Procesamiento secuencial + Pausas anti-saturación`);
    
    // ========================================================================
    // PROCESAR ORGANIZACIONES
    // ========================================================================
    const processingResult = await processOrganizations(
      instance,
      organizations,
      progressCallback,
      scanOnly
    );
    
    // Almacenar resultados consolidados
    instance.scannedFiles = processingResult.allFiles;
    instance.scannedApps = processingResult.allApps;
    
    // ========================================================================
    // FINALIZACIÓN
    // ========================================================================
    // Construir scannedFilesComplete desde BD
    await buildScannedFilesComplete(instance, processingResult.allFiles);
    
    // Calcular estadísticas finales
    const totalBytes = calculateFinalStats(instance, processingResult.allFiles, processingResult.allApps);
    
    // Finalizar escaneo
    const finalizationResult = await finalizeScan(
      instance,
      progressCallback,
      totalBytes,
      processingResult.hasFailedOrganization,
      processingResult.failedOrganizationName
    );
    
    // Actualizar item en Podio si no hay error de rate limit
    await updateBackupItemInPodio(instance, progressCallback, finalizationResult.hasRateLimitError);
    
  } catch (error) {
    // IMPORTANTE: Si es un error de rate limit, NO actualizar el item en Podio
    if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
      instance.addLog("error", `🚫 ERROR DE RATE LIMIT - NO SE ACTUALIZARÁ EL ITEM EN PODIO`);
      instance.addLog("error", `Error durante el escaneo: ${error.message}`);
      // Mantener el progreso en 1%
      if (progressCallback) {
        const parts = error.message.split(":");
        const waitTime = Number.parseInt(parts[1], 10) || 60;
        instance.updateProgress(1, `🚫 Escaneo pausado por límite de tasa. Esperando ${Math.ceil(waitTime / 60)} minutos...`, progressCallback);
      }
      throw error;
    }
    
    // IMPORTANTE: Si es un error de cancelación, no lanzar error
    if (error instanceof Error && error.message.startsWith("ESCANEO_CANCELADO:")) {
      instance.addLog("warning", "🚫 Escaneo cancelado por el usuario");
      if (progressCallback) {
        instance.updateProgress(instance.lastProgress || 0, "Escaneo cancelado por el usuario", progressCallback);
      }
      return; // Salir silenciosamente
    }
    
    instance.addLog("error", `Error durante el escaneo: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    // Desactivar modo escaneo al finalizar (permite usar caché en otras operaciones)
    instance.isScanning = false;
  }
}
