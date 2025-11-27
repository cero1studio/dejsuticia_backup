import type { PodioBackupService } from './podio-service';

/**
 * Inicializar el escaneo: detectar escaneos incompletos, limpiar checkpoints y rate limits
 */
export async function initializeScan(
  instance: PodioBackupService,
  useLastScan: boolean
): Promise<void> {
  // Reiniciar flags al inicio
  instance.isScanCancelled = false;
  instance.isScanning = true; // Activar modo escaneo (desactiva caché)
  
  // ========================================================================
  // DETECCIÓN AUTOMÁTICA DE ESCANEO INCOMPLETO (SOLO SI NO ES useLastScan)
  // ========================================================================
  // Si NO es useLastScan, detectar automáticamente y CONTINUAR automáticamente
  // Si ES useLastScan, la detección se hace más abajo y se pausa para acción manual
  // IMPORTANTE: NO reanudar si el escaneo fue cancelado (cancelled = true)
  if (!useLastScan && typeof window !== 'undefined' && window.electron && window.electron.db) {
    const lastScan = await window.electron.db.getLastScan();
    if (lastScan && !lastScan.summary) {
      // Verificar si el escaneo fue cancelado
      const isCancelled = lastScan.cancelled === 1 || lastScan.cancelled === true;
      
      if (isCancelled) {
        // El escaneo fue cancelado, NO reanudar automáticamente, crear nuevo scan
        instance.addLog("info", `ℹ️ Se detectó un escaneo cancelado anteriormente (ID: ${lastScan.id}). Iniciando nuevo escaneo desde cero.`);
        // Continuar con el flujo normal para crear un nuevo scan
      } else {
        // El escaneo no está finalizado (no tiene summary) y NO fue cancelado, significa que se interrumpió (rate limit, etc.)
        instance.addLog("warning", `🔄 Se detectó un escaneo incompleto (ID: ${lastScan.id}, fecha: ${new Date(lastScan.created_at_ms).toLocaleString()})`);
        instance.addLog("info", "🔄 Reanudando escaneo automáticamente desde donde quedó...");
        
        // Cargar datos parciales del escaneo incompleto
        const apps = await window.electron.db.getLastScanApps();
        const files = await window.electron.db.getLastScanFiles();
        const itemsCount = await window.electron.db.getLastScanItemsCount();
        
        instance.currentScanId = lastScan.id;
        
        // Cargar checkpoint desde BD para saber exactamente dónde quedó
        const savedCheckpoint = await window.electron.db.getScanCheckpoint(lastScan.id);
        if (savedCheckpoint) {
          instance.processingCheckpoint = {
            orgIndex: savedCheckpoint.orgIndex,
            orgTotal: savedCheckpoint.orgTotal,
            workspaceIndex: savedCheckpoint.workspaceIndex,
            workspaceTotal: savedCheckpoint.workspaceTotal,
            appIndex: savedCheckpoint.appIndex,
            appTotal: savedCheckpoint.appTotal,
            organizations: [], // Se poblará cuando se carguen las organizaciones
            workspacesCounted: savedCheckpoint.workspacesCounted || false,
            appsCounted: savedCheckpoint.appsCounted || false
          };
          instance.addLog("success", `📍 Checkpoint restaurado: Org ${savedCheckpoint.orgIndex + 1}/${savedCheckpoint.orgTotal}, Workspace ${savedCheckpoint.workspaceIndex + 1}/${savedCheckpoint.workspaceTotal}, App ${savedCheckpoint.appIndex + 1}/${savedCheckpoint.appTotal}`);
          instance.addLog("info", "🔄 Continuando automáticamente desde el checkpoint...");
        } else {
          instance.addLog("info", "ℹ️ No se encontró checkpoint guardado. El escaneo continuará desde el principio.");
        }
        
        // Poblar datos en memoria desde el escaneo incompleto
        instance.scannedApps = apps.map(app => ({
          appId: app.app_id,
          folderPath: app.folder_path,
          appName: app.app_name
        }));
        
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
        
        // Actualizar contadores desde los datos cargados
        instance.backupCounts.applications = apps.length;
        instance.backupCounts.items = itemsCount;
        instance.backupCounts.files = files.length;
        
        instance.addLog("success", `📊 Escaneo incompleto cargado: ${apps.length} apps, ${itemsCount} items, ${files.length} archivos`);
        instance.addLog("info", "ℹ️ Los datos ya escaneados no se volverán a procesar. Continuando desde el checkpoint...");
        
        // NO retornar aquí - continuar automáticamente con el escaneo desde el checkpoint
      }
    }
  }
  
  // ========================================================================
  // LIMPIAR CHECKPOINTS AL INICIAR NUEVO ESCANEO (solo si no hay escaneo incompleto)
  // ========================================================================
  if (!instance.currentScanId) {
    instance.processingCheckpoint = null;
    instance.addLog("info", "📍 Checkpoints limpiados: Iniciando nuevo escaneo desde cero");
  } else {
    instance.addLog("info", "📍 Checkpoints preservados: Continuando escaneo incompleto");
  }
  
  // ========================================================================
  // LIMPIAR RATE LIMITS AL INICIAR ESCANEO (USUARIO DECIDIÓ CONTINUAR)
  // ========================================================================
  if (typeof window !== 'undefined' && window.electron && window.electron.db) {
    try {
      await window.electron.db.clearRateLimitStatus('general');
      await window.electron.db.clearRateLimitStatus('rateLimited');
      instance.activeRateLimit = null; // Limpiar también el rate limit en memoria
      instance.addLog("info", "🔄 Rate limits limpiados al iniciar escaneo...");
    } catch (error) {
      instance.addLog("warning", `No se pudieron limpiar rate limits: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}





