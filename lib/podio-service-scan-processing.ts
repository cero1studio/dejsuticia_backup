import type { PodioBackupService, ProgressCallback, PodioFile } from './podio-service';

interface ProcessingResult {
  allFiles: PodioFile[];
  allApps: Array<{ appId: number; folderPath: string; appName: string }>;
  hasFailedOrganization: boolean;
  failedOrganizationName: string;
  totalWorkspaces: number;
}

/**
 * Procesar todas las organizaciones secuencialmente con manejo de rate limits y reintentos
 */
export async function processOrganizations(
  instance: PodioBackupService,
  organizations: Array<{ org_id: number; name: string }>,
  progressCallback: ProgressCallback | undefined,
  scanOnly: boolean
): Promise<ProcessingResult> {
  const allFiles: PodioFile[] = [];
  const allApps: Array<{ appId: number; folderPath: string; appName: string }> = [];
  
  // IMPORTANTE: Rastrear si alguna organización falló debido a rate limit
  // Esto evita que el progreso llegue a 100% cuando el escaneo no está completo
  let hasFailedOrganization = false;
  let failedOrganizationName = '';
  let totalWorkspaces = 0;
  
  instance.addLog("info", `🔍 DEBUG: Antes de iniciar loop de organizaciones - allFiles.length = ${allFiles.length}, allApps.length = ${allApps.length}`);
  
  // IMPORTANTE: Procesar SECUENCIALMENTE para evitar que peticiones paralelas sigan ejecutándose
  // después de un error de rate limit
  instance.addLog("info", `🔄 Iniciando loop de organizaciones (${organizations.length} organizaciones)...`);
  instance.addLog("info", `📚 ESTADO ACTUAL: ${instance.backupCounts.workspaces} workspaces, ${instance.backupCounts.applications} apps, ${instance.backupCounts.items} items, ${instance.backupCounts.files} archivos`);
  
  // ========================================================================
  // PROCESAR ORGANIZACIONES (CON MANEJO DE RATE LIMITS Y REINTENTOS)
  // ========================================================================
  // Procesar cada organización secuencialmente. Si hay rate limit,
  // pausa automática, espera el tiempo necesario y reintenta automáticamente.
  for (let i = 0; i < organizations.length; i++) {
    // CRÍTICO: Verificar rate limit activo ANTES de continuar
    if (instance.isRateLimitActiveSync()) {
      instance.addLog("error", "🚫 Rate limit activo detectado. Deteniendo proceso inmediatamente.");
      throw new Error('RATE_LIMIT_ERROR:0:general');
    }
    
    // Verificar si el escaneo fue cancelado
    if (instance.isScanCancelled) {
      instance.addLog("warning", "🚫 Escaneo cancelado por el usuario. Deteniendo procesamiento...");
      throw new Error("ESCANEO_CANCELADO: El escaneo fue cancelado por el usuario");
    }
    
    const org = organizations[i];
    instance.addLog("info", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    instance.addLog("info", `🏢 PASO ${i + 1}/${organizations.length}: Procesando organización "${org.name}" (ID: ${org.org_id})`);
    instance.addLog("info", `📚 ANTES: ${instance.backupCounts.workspaces} workspaces, ${instance.backupCounts.applications} apps, ${instance.backupCounts.items} items, ${instance.backupCounts.files} archivos`);
    
    // Implementar reintentos automáticos para cada organización
    let orgAttempts = 0;
    const MAX_ORG_ATTEMPTS = 3;
    let orgProcessed = false;
    
    while (orgAttempts < MAX_ORG_ATTEMPTS && !orgProcessed) {
      try {
        // Procesar la organización
        instance.addLog("info", `📞 Procesando organización "${org.name}" (intento ${orgAttempts + 1}/${MAX_ORG_ATTEMPTS})...`);
        const result = await instance.processOrganizationParallel(org, progressCallback, organizations.length, i, scanOnly);
        instance.addLog("success", `✅ Organización "${org.name}" procesada exitosamente`);
        instance.addLog("info", `📚 RESULTADO: ${result.workspaces.length} workspaces, ${result.applications.length} apps, ${result.itemsCount} items, ${result.files.length} archivos`);
        instance.addLog("info", `📚 DESPUÉS: ${instance.backupCounts.workspaces} workspaces, ${instance.backupCounts.applications} apps, ${instance.backupCounts.items} items, ${instance.backupCounts.files} archivos`);
        
        // IMPORTANTE: Los contadores ya se actualizan INMEDIATAMENTE durante el procesamiento
        // No actualizar aquí para evitar duplicación. Solo actualizar totalWorkspaces para referencia local.
        totalWorkspaces += result.workspaces.length;
        
        // Consolidar archivos
        allFiles.push(...result.files);
        
        // Consolidar aplicaciones para Excel
        result.applications.forEach(app => {
          const workspace = result.workspaces.find(w => w.space_id === app.space_id);
          // Sanitizar nombres para mantener consistencia con createFolderStructure
          const safeOrgName = instance.sanitizeFileName(org.name);
          const safeWorkspaceName = instance.sanitizeFileName(workspace?.name || 'Unknown');
          const safeAppName = instance.sanitizeFileName(app.name);
          
          // OPTIMIZACIÓN: Usar path con timestamp
          const basePath = instance.backupTimestamp 
            ? `${instance.backupPath}/${instance.backupTimestamp}`
            : instance.backupPath;
          const folderPath = `${basePath}/${safeOrgName}/${safeWorkspaceName}/${safeAppName}`;
          
          allApps.push({ appId: app.app_id, folderPath, appName: app.name });
        });
        
        orgProcessed = true; // Marcar como procesada exitosamente
        
        // IMPORTANTE: Guardar checkpoint después de procesar cada organización
        if (typeof window !== 'undefined' && window.electron && window.electron.db && instance.currentScanId) {
          try {
            // Actualizar checkpoint con el progreso actual
            if (instance.processingCheckpoint) {
              instance.processingCheckpoint.orgIndex = i;
              instance.processingCheckpoint.orgTotal = organizations.length;
              await window.electron.db.saveScanCheckpoint(instance.currentScanId, {
                orgIndex: i,
                orgTotal: organizations.length,
                workspaceIndex: instance.processingCheckpoint.workspaceIndex || 0,
                workspaceTotal: instance.processingCheckpoint.workspaceTotal || 0,
                appIndex: instance.processingCheckpoint.appIndex || 0,
                appTotal: instance.processingCheckpoint.appTotal || 0,
                workspacesCounted: instance.processingCheckpoint.workspacesCounted || false,
                appsCounted: instance.processingCheckpoint.appsCounted || false
              });
              instance.addLog("info", `📍 Checkpoint guardado: Org ${i + 1}/${organizations.length}`);
            }
          } catch (checkpointError) {
            instance.addLog("warning", `Error guardando checkpoint: ${checkpointError instanceof Error ? checkpointError.message : String(checkpointError)}`);
          }
        }
        
        // Pequeña pausa entre organizaciones para no saturar la API (ya procesamos secuencialmente)
        if (i + 1 < organizations.length) {
          await new Promise(resolve => setTimeout(resolve, instance.REQUEST_DELAY_MS));
        }
        
      } catch (error) {
        orgAttempts++;
        
        // IMPORTANTE: Si el escaneo fue cancelado, salir inmediatamente
        if (error instanceof Error && error.message.startsWith("ESCANEO_CANCELADO:")) {
          instance.addLog("warning", "🚫 Escaneo cancelado por el usuario");
          if (progressCallback) {
            instance.updateProgress(instance.lastProgress || 0, "Escaneo cancelado por el usuario", progressCallback);
          }
          throw error; // Lanzar error para que se maneje en el nivel superior
        }
        
        // CRÍTICO: Errores de límites inválidos NO son rate limits - detener inmediatamente
        if (error instanceof Error && error.message.startsWith("INVALID_LIMIT_ERROR:")) {
          const errorMsg = error.message.replace("INVALID_LIMIT_ERROR:", "").trim();
          instance.addLog("error", `❌ ERROR CRÍTICO: Límite de API excedido - ${errorMsg}`);
          instance.addLog("error", `❌ Este NO es un rate limit. El código está usando límites incorrectos.`);
          instance.addLog("error", `❌ Por favor, reinicie la aplicación para cargar los límites corregidos.`);
          if (progressCallback) {
            instance.updateProgress(instance.lastProgress || 0, `Error: Límite de API excedido - ${errorMsg}`, progressCallback);
          }
          throw error; // Lanzar error para detener el proceso
        }
        
        // IMPORTANTE: Si hay un error de rate limit, pausar y reintentar automáticamente
        if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
          const parts = error.message.split(":");
          const waitTime = Number.parseInt(parts[1], 10) || 60;
          const limitType = parts[2] || "general";
          
          // ========================================================================
          // OBTENER TIEMPO REAL RESTANTE DESDE BD (TIMESTAMP PRESERVADO)
          // ========================================================================
          let realRemainingMinutes = Math.ceil(waitTime / 60); // Por defecto, usar waitTime
          try {
            const rateLimitInfo = await instance.getRateLimitInfoFromDb();
            if (rateLimitInfo.active && rateLimitInfo.remainingSeconds > 0) {
              realRemainingMinutes = Math.ceil(rateLimitInfo.remainingSeconds / 60);
              instance.addLog("info", `🗓️ Tiempo real restante desde BD: ${realRemainingMinutes} minutos`);
            }
          } catch (dbError) {
            // Si hay error, usar waitTime como fallback
            console.warn('Error obteniendo tiempo real desde BD:', dbError);
          }
          
          instance.addLog("warning", `🚫 Rate limit detectado al procesar organización "${org.name}"`);
          instance.addLog("info", `⏱️ Esperando ${realRemainingMinutes} minutos y reintentando automáticamente...`);
          
          // Crear mensaje base para actualización dinámica
          const progressMessage = `⏱️ Pausa por rate limit en org ${i + 1}/${organizations.length}. Esperando ${realRemainingMinutes} min... (Reintentará automáticamente)`;
          
          if (progressCallback) {
            instance.updateProgress(
              instance.lastProgress || 1, 
              progressMessage, 
              progressCallback
            );
          }
          
          // Esperar el tiempo necesario con progreso visual (pasar callback y mensaje para actualización dinámica)
          await instance.waitForRateLimit(
            waitTime, 
            limitType as 'general' | 'rateLimited',
            progressCallback,
            progressMessage
          );
          
          // Verificar si quedan intentos
          if (orgAttempts < MAX_ORG_ATTEMPTS) {
            instance.addLog("info", `🔄 Reintentando procesar organización "${org.name}"...`);
            continue; // Reintentar
          } else {
            instance.addLog("error", `❌ No se pudo procesar la organización "${org.name}" después de ${MAX_ORG_ATTEMPTS} intentos`);
            // IMPORTANTE: Marcar que esta organización falló debido a rate limit
            hasFailedOrganization = true;
            failedOrganizationName = org.name;
            // Continuar con la siguiente organización en lugar de abortar todo
            instance.addLog("warning", `⚠️ Continuando con la siguiente organización...`);
            break; // Salir del loop de reintentos para esta org
          }
        }
        
        // Si es otro tipo de error, lanzarlo
        instance.addLog("error", `❌ Error al procesar organización "${org.name}": ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
  }
  
  return {
    allFiles,
    allApps,
    hasFailedOrganization,
    failedOrganizationName,
    totalWorkspaces
  };
}


