import type { PodioBackupService, ProgressCallback, PodioFile } from './podio-service';

interface FinalizationResult {
  hasRateLimitError: boolean;
}

/**
 * Construir scannedFilesComplete desde BD y calcular estadísticas finales
 */
export async function buildScannedFilesComplete(
  instance: PodioBackupService,
  allFiles: PodioFile[]
): Promise<void> {
  // Construir scannedFilesComplete desde la BD si está disponible
  if (typeof window !== 'undefined' && window.electron && window.electron.db && instance.currentScanId) {
    try {
      const files = await window.electron.db.getLastScanFiles();
      const apps = await window.electron.db.getLastScanApps();
      
      instance.scannedFilesComplete = files.map(file => ({
        file: {
          file_id: file.file_id,
          name: file.name,
          link: file.download_url,
          mimetype: file.mimetype || '',
          size: file.size || 0,
          download_link: file.download_url
        },
        downloadUrl: file.download_url,
        folderPath: file.folder_path,
        appName: apps.find(a => a.app_id === file.app_id)?.app_name || 'Unknown'
      }));
      
      instance.addLog("info", `📚 scannedFilesComplete construido desde BD: ${instance.scannedFilesComplete.length} archivos`);
    } catch (dbError) {
      instance.addLog("warning", `Error construyendo scannedFilesComplete desde BD: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
      // Fallback: inicializar como array vacío si hay error
      if (!instance.scannedFilesComplete) {
        instance.scannedFilesComplete = [];
      }
    }
  } else {
    // Si no hay BD disponible, inicializar como array vacío
    if (!instance.scannedFilesComplete) {
      instance.scannedFilesComplete = [];
    }
  }
  
  // IMPORTANTE: Usar scannedFilesComplete.length que incluye todos los archivos encontrados durante el escaneo
  instance.totalFilesToDownload = instance.scannedFilesComplete.length;
  instance.addLog("info", `📚 Total de archivos a descargar: ${instance.totalFilesToDownload} (calculado desde scannedFilesComplete)`);
}

/**
 * Calcular estadísticas finales del escaneo
 */
export function calculateFinalStats(
  instance: PodioBackupService,
  allFiles: PodioFile[],
  allApps: Array<{ appId: number; folderPath: string; appName: string }>
): number {
  // Asegurar que el tamaño esté calculado correctamente (sumar todos los archivos)
  let totalSizeBytes = 0;
  allFiles.forEach(file => {
    if (file.size && file.size > 0) {
      totalSizeBytes += file.size;
    }
  });
  
  // OPTIMIZACIÓN: Sumar tamaño estimado de los excels al backupSize
  // Estimar tamaño de Excel basado en número de items (promedio: ~50KB por 1000 items)
  let estimatedExcelSizeBytes = 0;
  if (instance.backupCounts.items > 0 && allApps.length > 0) {
    const avgItemsPerApp = instance.backupCounts.items / allApps.length;
    // Estimación: 50KB base + 50KB por cada 1000 items
    estimatedExcelSizeBytes = allApps.length * (50 * 1024 + Math.max(0, (avgItemsPerApp / 1000) * 50 * 1024));
  } else {
    // Estimación conservadora: 100KB por Excel (mínimo)
    estimatedExcelSizeBytes = allApps.length * 100 * 1024;
  }
  
  totalSizeBytes += estimatedExcelSizeBytes;
  
  // Actualizar backupSize con el tamaño total en GB
  instance.backupStats.backupSize = totalSizeBytes / (1024 * 1024 * 1024);
  
  // Guardar los stats escaneados
  instance.scannedStats = { ...instance.backupStats };
  
  return totalSizeBytes;
}

/**
 * Verificar si hay error de rate limit activo
 */
export async function checkRateLimitError(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.electron || !window.electron.db) {
    return false;
  }
  
  try {
    const generalStatus = await window.electron.db.getRateLimitStatusFromDb('general');
    const rateLimitedStatus = await window.electron.db.getRateLimitStatusFromDb('rateLimited');
    return Boolean(
      (generalStatus.active && generalStatus.resetInSeconds !== null && generalStatus.resetInSeconds > 0) ||
      (rateLimitedStatus.active && rateLimitedStatus.resetInSeconds !== null && rateLimitedStatus.resetInSeconds > 0)
    );
  } catch (error) {
    // Ignorar errores de verificación
    return false;
  }
}

/**
 * Finalizar el escaneo: guardar en BD y actualizar progreso
 */
export async function finalizeScan(
  instance: PodioBackupService,
  progressCallback: ProgressCallback | undefined,
  totalBytes: number,
  hasFailedOrganization: boolean,
  failedOrganizationName: string
): Promise<FinalizationResult> {
  // IMPORTANTE: Solo actualizar progreso a 95% si NO hay error de rate limit activo
  const hasRateLimitErrorAt95 = await checkRateLimitError();
  
  // Actualizar progreso con estadísticas finales SOLO si no hay error de rate limit
  if (progressCallback && !hasRateLimitErrorAt95) {
    instance.updateProgress(95, `Escaneo casi completado: ${instance.backupCounts.applications} apps, ${instance.backupCounts.items} items, ${instance.backupCounts.files} archivos`, progressCallback);
  } else if (progressCallback && hasRateLimitErrorAt95) {
    // Si hay error de rate limit, mantener el progreso en 1%
    instance.updateProgress(1, `🚫 Escaneo pausado por límite de tasa`, progressCallback);
  }
  
  // Finalizar escaneo
  instance.addLog("success", `✅ Escaneo de respaldo completado`);
  instance.addLog("info", `📚 Organizaciones: ${instance.backupCounts.organizations}`);
  instance.addLog("info", `📚 Espacios de trabajo: ${instance.backupCounts.workspaces}`);
  instance.addLog("info", `📚 Aplicaciones: ${instance.backupCounts.applications}`);
  instance.addLog("info", `📚 Elementos: ${instance.backupCounts.items}`);
  instance.addLog("info", `📚 Archivos encontrados: ${instance.backupCounts.files}`);
  instance.addLog("info", `📚 Tamaño estimado: ${instance.backupStats.backupSize.toFixed(2)} GB (${totalBytes.toLocaleString()} bytes)`);
  
  // Guardar escaneo en BD con el tamaño estimado
  if (typeof window !== 'undefined' && window.electron && window.electron.db && instance.currentScanId) {
    try {
      await window.electron.db.finalizeScan(instance.currentScanId, {
        organizations: instance.backupCounts.organizations,
        workspaces: instance.backupCounts.workspaces,
        applications: instance.backupCounts.applications,
        items: instance.backupCounts.items,
        files: instance.backupCounts.files,
        backupSize: instance.backupStats.backupSize
      });
      instance.addLog("success", `✅ Escaneo guardado en BD: ${instance.backupCounts.applications} apps, ${instance.backupCounts.items} items, ${instance.backupCounts.files} archivos, ${instance.backupStats.backupSize.toFixed(2)} GB`);
    } catch (dbError) {
      console.warn('Error guardando escaneo en BD:', dbError);
    }
  }
  
  // IMPORTANTE: Solo actualizar el item en Podio si NO hay error de rate limit
  // Verificar si hay un error de rate limit activo antes de actualizar
  const hasRateLimitError = await checkRateLimitError();
  
  // CRÍTICO: Si alguna organización falló debido a rate limit, NO actualizar a 100%
  // incluso si el rate limit ya pasó. El escaneo no está completo.
  if (hasFailedOrganization) {
    instance.addLog("error", `🚫 ESCANEO INCOMPLETO: La organización "${failedOrganizationName}" no se pudo procesar debido a rate limit`);
    instance.addLog("warning", `🚫 NO se actualizará el item en Podio - El escaneo no está completo`);
    // Mantener el progreso en el último valor válido (no 100%)
    if (progressCallback) {
      const lastValidProgress = instance.lastProgress || 1;
      instance.updateProgress(
        lastValidProgress, 
        `⏸️ Escaneo pausado: La organización "${failedOrganizationName}" no se pudo procesar. Presiona "Reanudar Escaneo" para continuar.`, 
        progressCallback
      );
    }
    // Lanzar error para que el dashboard sepa que el escaneo no completó
    throw new Error(`RATE_LIMIT_ERROR:0:general: Escaneo incompleto - La organización "${failedOrganizationName}" no se pudo procesar después de 3 intentos`);
  }
  
  return { hasRateLimitError };
}

/**
 * Actualizar el item de backup en Podio si no hay error de rate limit
 */
export async function updateBackupItemInPodio(
  instance: PodioBackupService,
  progressCallback: ProgressCallback | undefined,
  hasRateLimitError: boolean
): Promise<void> {
  // Solo actualizar el item si NO hay error de rate limit
  if (!hasRateLimitError) {
    // Actualizar el tamaño estimado en Podio
    await instance.updateEstimatedSizeInBackupRecord();
    
    // ACTUALIZAR EL ITEM DE BACKUP EN PODIO CON LOS DATOS DEL ESCANEO
    await instance.updateBackupRecord(false);
    
    // Actualizar progreso final con todas las estadísticas
    if (progressCallback) {
      instance.updateProgress(100, `✅ Escaneo completado: ${instance.backupCounts.applications} apps, ${instance.backupCounts.items} items, ${instance.backupCounts.files} archivos, ${instance.backupStats.backupSize.toFixed(2)} GB`, progressCallback);
    }
  } else {
    instance.addLog("warning", `🚫 Error de rate limit activo - NO se actualizará el item en Podio para evitar llegar a 99%`);
    // Mantener el progreso en 1% si hay error de rate limit
    if (progressCallback) {
      instance.updateProgress(1, `🚫 Escaneo pausado por límite de tasa`, progressCallback);
    }
  }
}





