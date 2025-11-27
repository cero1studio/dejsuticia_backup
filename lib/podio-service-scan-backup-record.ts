import type { PodioBackupService, ProgressCallback } from './podio-service';

/**
 * Crear registro de backup en Podio con reintentos automáticos en caso de rate limit
 */
export async function createBackupRecordWithRetries(
  instance: PodioBackupService,
  progressCallback?: ProgressCallback
): Promise<void> {
  let createBackupAttempts = 0;
  const MAX_CREATE_BACKUP_ATTEMPTS = 3;
  
  while (createBackupAttempts < MAX_CREATE_BACKUP_ATTEMPTS) {
    try {
      instance.addLog("info", `📝 Intentando crear registro de backup en Podio (intento ${createBackupAttempts + 1}/${MAX_CREATE_BACKUP_ATTEMPTS})...`);
      await instance.createBackupRecord();
      instance.addLog("success", `✅ Registro de backup creado exitosamente en Podio`);
      break; // Éxito, salir del loop
    } catch (error) {
      createBackupAttempts++;
      
      // Si hay un error de rate limit al crear el item, pausar y reintentar automáticamente
      if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
        const parts = error.message.split(":");
        const waitTime = Number.parseInt(parts[1], 10) || 60;
        const limitType = parts[2] || 'general';
        
        instance.addLog("warning", `🚫 Rate limit detectado al crear registro de backup`);
        instance.addLog("info", `⏱️ Esperando ${Math.ceil(waitTime / 60)} minutos y reintentando automáticamente...`);
        
        if (progressCallback) {
          instance.updateProgress(1, `⏱️ Pausa por rate limit. Esperando ${Math.ceil(waitTime / 60)} min... (Reintentará automáticamente)`, progressCallback);
        }
        
        // Esperar el tiempo necesario con progreso visual
        await instance.waitForRateLimit(waitTime, limitType as 'general' | 'rateLimited');
        
        // Verificar si quedan intentos
        if (createBackupAttempts < MAX_CREATE_BACKUP_ATTEMPTS) {
          instance.addLog("info", `🔄 Reintentando crear registro de backup...`);
          continue; // Reintentar
        } else {
          instance.addLog("error", `❌ No se pudo crear el registro de backup después de ${MAX_CREATE_BACKUP_ATTEMPTS} intentos`);
          throw new Error(`No se pudo crear el registro de backup después de ${MAX_CREATE_BACKUP_ATTEMPTS} intentos debido a rate limits`);
        }
      }
      
      // Si es otro tipo de error, lanzarlo inmediatamente
      instance.addLog("error", `❌ Error al crear registro de backup: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}





