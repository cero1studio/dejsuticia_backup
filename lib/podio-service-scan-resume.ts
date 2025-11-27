import type { PodioBackupService, ProgressCallback } from './podio-service';

/**
 * Verificar y cargar escaneos recientes si useLastScan es true
 * Retorna true si se cargó un escaneo completo y no se debe continuar con el escaneo nuevo
 * Retorna false si se debe continuar con el escaneo nuevo
 */
export async function checkAndResumeLastScan(
  instance: PodioBackupService,
  progressCallback?: ProgressCallback
): Promise<boolean> {
  // IMPORTANTE: Solo verificar escaneo reciente si el usuario lo solicita explícitamente
  // Si es un nuevo backup (useLastScan = false), SIEMPRE hacer un escaneo nuevo
  if (typeof window === 'undefined' || !window.electron || !window.electron.db) {
    return false;
  }

  try {
    const lastScan = await window.electron.db.getLastScan();
    if (!lastScan) {
      return false;
    }

    const scanAge = Date.now() - lastScan.created_at_ms;
    
    // Cargar datos del escaneo para verificar si tiene datos válidos
    const apps = await window.electron.db.getLastScanApps();
    const files = await window.electron.db.getLastScanFiles();
    const itemsCount = await window.electron.db.getLastScanItemsCount();
    
    // IMPORTANTE: Si el escaneo reciente está vacío (0 apps y 0 archivos), hacer un escaneo nuevo
    if (apps.length === 0 && files.length === 0 && itemsCount === 0) {
      instance.addLog("warning", `⚠️ Escaneo reciente encontrado pero está vacío (0 apps, 0 items, 0 archivos). Haciendo escaneo nuevo...`);
      return false; // Continuar con el escaneo normal
    }

    if (lastScan.summary) {
      // Escaneo COMPLETO (tiene summary) - solo cargar y usar, no reanudar
      instance.addLog("info", `✅ Escaneo completo encontrado (${Math.round(scanAge / 60000)} minutos). Cargando desde BD...`);
      
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
      
      instance.scannedFiles = instance.scannedFilesComplete.map(sf => sf.file);
      instance.currentScanId = lastScan.id;
      
      instance.scannedStats = {
        apps: lastScan.summary.applications || apps.length,
        items: lastScan.summary.items || itemsCount,
        workspaces: lastScan.summary.workspaces || 0,
        files: lastScan.summary.files || files.length,
        backupSize: lastScan.summary.backupSize || 0,
        successfulBackups: 0,
        backupWarnings: 0,
        downloadedFiles: 0,
        downloadedBytes: 0
      };
      
      instance.addLog("success", `✅ Escaneo completo cargado desde BD: ${apps.length} apps, ${itemsCount} items, ${files.length} archivos`);
      
      if (progressCallback) {
        instance.updateProgress(100, `✅ Escaneo completado desde BD: ${apps.length} apps, ${itemsCount} items, ${files.length} archivos`, progressCallback);
      }
      
      return true; // No hacer escaneo nuevo, usar el de BD
    } else {
      // Escaneo INCOMPLETO (no tiene summary) - verificar si fue cancelado
      const isCancelled = lastScan.cancelled === 1 || lastScan.cancelled === true;
      
      if (isCancelled) {
        // El escaneo fue cancelado, NO reanudar, crear nuevo scan
        instance.addLog("info", `ℹ️ El escaneo anterior fue cancelado (ID: ${lastScan.id}). Iniciando nuevo escaneo desde cero.`);
        return false; // Continuar con el flujo normal para crear un nuevo scan
      } else {
        // Escaneo INCOMPLETO (no tiene summary) y NO fue cancelado - cargar datos parciales y PAUSAR para acción manual
        instance.addLog("warning", `🔄 Escaneo incompleto encontrado (ID: ${lastScan.id}, ${Math.round(scanAge / 60000)} minutos).`);
        
        // Cargar datos parciales del escaneo incompleto
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
            organizations: [],
            workspacesCounted: savedCheckpoint.workspacesCounted || false,
            appsCounted: savedCheckpoint.appsCounted || false
          };
          instance.addLog("success", `📍 Checkpoint encontrado: Org ${savedCheckpoint.orgIndex + 1}/${savedCheckpoint.orgTotal}, Workspace ${savedCheckpoint.workspaceIndex + 1}/${savedCheckpoint.workspaceTotal}, App ${savedCheckpoint.appIndex + 1}/${savedCheckpoint.appTotal}`);
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
        
        instance.scannedFiles = instance.scannedFilesComplete.map(sf => sf.file);
        
        // Actualizar contadores desde los datos cargados
        instance.backupCounts.applications = apps.length;
        instance.backupCounts.items = itemsCount;
        instance.backupCounts.files = files.length;
        
        instance.addLog("success", `📊 Escaneo incompleto cargado: ${apps.length} apps, ${itemsCount} items, ${files.length} archivos`);
        instance.addLog("warning", `⏸️ ESCANEO INCOMPLETO DETECTADO - Presiona "Reanudar Escaneo" para continuar desde donde quedó`);
        instance.addLog("info", "ℹ️ Los datos ya escaneados no se volverán a procesar cuando reanudes.");
        
        // PAUSAR para acción manual cuando useLastScan=true
        if (progressCallback) {
          instance.updateProgress(1, `⏸️ Escaneo incompleto detectado. Presiona "Reanudar Escaneo" para continuar desde donde quedó.`, progressCallback);
        }
        
        return true; // Retornar para pausar y esperar acción manual del usuario
      }
    }
  } catch (error) {
    instance.addLog("warning", `Error verificando escaneo reciente: ${error instanceof Error ? error.message : String(error)}`);
    return false; // Continuar con escaneo normal si hay error
  }
}





