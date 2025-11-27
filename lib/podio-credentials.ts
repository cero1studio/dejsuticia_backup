/**
 * Utilidades para manejo centralizado de credenciales de Podio
 * 
 * Este módulo proporciona funciones para obtener las credenciales de API de Podio
 * desde múltiples fuentes en orden de prioridad:
 * 1. localStorage (configuración del usuario)
 * 2. Variables de entorno
 * 3. Valores por defecto hardcodeados (último recurso)
 */

export interface PodioCredentials {
  clientId: string
  clientSecret: string
  backupAppId: string
}

/**
 * Obtiene las credenciales de Podio desde localStorage, variables de entorno o valores por defecto
 * 
 * Prioridad:
 * 1. localStorage - Si el usuario configuró credenciales personalizadas
 * 2. Variables de entorno - Valores de .env
 * 3. Hardcoded - Valores por defecto del sistema (último recurso)
 * 
 * @returns Objeto con clientId, clientSecret y backupAppId
 */
export function getPodioCredentials(): PodioCredentials {
  let clientId = ''
  let clientSecret = ''
  let backupAppId = ''

  // 1. Intentar cargar desde localStorage (configuración del usuario) - PRIORIDAD MÁXIMA
  if (typeof window !== 'undefined') {
    try {
      const savedCredentials = localStorage.getItem('podio_api_credentials')
      if (savedCredentials) {
        const parsed = JSON.parse(savedCredentials)
        // Solo usar si realmente tienen valores (no strings vacíos)
        if (parsed.clientId && parsed.clientId.trim() !== '' && 
            parsed.clientSecret && parsed.clientSecret.trim() !== '') {
          clientId = parsed.clientId
          clientSecret = parsed.clientSecret
          backupAppId = parsed.backupAppId || ''
          
          console.log('✅ Credenciales cargadas desde localStorage (configuración del usuario)')
          // IMPORTANTE: Si hay credenciales guardadas por el usuario, NO sobrescribirlas
          // Retornar inmediatamente sin usar valores por defecto
          return {
            clientId,
            clientSecret,
            backupAppId
          }
        }
      }
    } catch (error) {
      console.warn('⚠️ Error al cargar credenciales desde localStorage:', error)
    }
  }

  // 2. Si NO hay credenciales guardadas por el usuario en localStorage, usar variables de entorno
  clientId = process.env.NEXT_PUBLIC_PODIO_CLIENT_ID || ''
  clientSecret = process.env.NEXT_PUBLIC_PODIO_CLIENT_SECRET || ''
  backupAppId = backupAppId || process.env.NEXT_PUBLIC_PODIO_BACKUP_APP_ID || ''
  
  if (clientId && clientSecret) {
    console.log('✅ Credenciales cargadas desde variables de entorno')
    
    // IMPORTANTE: Solo guardar en localStorage si NO hay credenciales guardadas previamente
    // Esto evita sobrescribir las credenciales que el usuario configuró manualmente
    if (typeof window !== 'undefined') {
      try {
        const existingCredentials = localStorage.getItem('podio_api_credentials')
        if (!existingCredentials) {
          // Solo guardar si no hay nada guardado previamente
          const credentialsToSave = {
            clientId,
            clientSecret,
            backupAppId: backupAppId || '30233695'
          }
          localStorage.setItem('podio_api_credentials', JSON.stringify(credentialsToSave))
          console.log('✅ Credenciales copiadas desde variables de entorno a localStorage')
        } else {
          console.log('ℹ️ Credenciales ya existen en localStorage, no se sobrescriben')
        }
      } catch (error) {
        console.warn('⚠️ Error al guardar credenciales en localStorage:', error)
      }
    }
  }

  // 3. Si aún no hay, usar valores por defecto hardcodeados (último recurso)
  if (!clientId || !clientSecret) {
    clientId = clientId || 'filepodio_lumen'
    clientSecret = clientSecret || 'XOnjWcETaRLHmHgvmz4ipEite8sBttjnMmIcYSLaJKOKV1Ha8ZbsYpJYxkch4yWV'
    backupAppId = backupAppId || '30233695'
    
    console.log('✅ Usando credenciales hardcodeadas por defecto')
    console.log(`   Client ID: ${clientId.substring(0, 15)}...`)
    
    // IMPORTANTE: Solo guardar valores hardcodeados si NO hay credenciales guardadas previamente
    // Esto evita sobrescribir las credenciales que el usuario configuró manualmente
    if (typeof window !== 'undefined') {
      try {
        const existingCredentials = localStorage.getItem('podio_api_credentials')
        if (!existingCredentials) {
          // Solo guardar si no hay nada guardado previamente
          const credentialsToSave = {
            clientId,
            clientSecret,
            backupAppId: backupAppId || '30233695'
          }
          localStorage.setItem('podio_api_credentials', JSON.stringify(credentialsToSave))
          console.log('✅ Credenciales hardcodeadas guardadas en localStorage')
        } else {
          console.log('ℹ️ Credenciales ya existen en localStorage, no se sobrescriben con valores por defecto')
        }
      } catch (error) {
        console.warn('⚠️ Error al guardar credenciales hardcodeadas en localStorage:', error)
      }
    }
  }

  return {
    clientId,
    clientSecret,
    backupAppId
  }
}

/**
 * Guarda las credenciales de Podio en localStorage
 * 
 * @param credentials - Objeto con clientId, clientSecret y backupAppId
 */
export function savePodioCredentials(credentials: PodioCredentials): void {
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('podio_api_credentials', JSON.stringify(credentials))
      console.log('✅ Credenciales guardadas en localStorage')
    } catch (error) {
      console.error('❌ Error al guardar credenciales en localStorage:', error)
      throw error
    }
  }
}

/**
 * Elimina las credenciales guardadas de localStorage
 */
export function clearPodioCredentials(): void {
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('podio_api_credentials')
      console.log('✅ Credenciales eliminadas de localStorage')
    } catch (error) {
      console.error('❌ Error al eliminar credenciales de localStorage:', error)
    }
  }
}

/**
 * ========================================================================
 * LÍMITES DE RATE CONFIGURABLES POR CLIENT_ID
 * ========================================================================
 * Permite configurar límites personalizados para cada client_id, ya que
 * algunos pueden tener límites más bajos que el estándar de Podio.
 */

export interface PodioRateLimits {
  hourly: number   // Requests por hora (default: 5000)
  daily: number    // Requests por día (default: 60000)
}

/**
 * Obtiene los límites de rate configurados para el client_id actual
 * 
 * Prioridad:
 * 1. localStorage - Límites personalizados configurados por el usuario
 * 2. Valores por defecto - 5000/hora, 60000/día (límites estándar de Podio)
 * 
 * @returns Objeto con límites hourly y daily
 */
export function getPodioRateLimits(): PodioRateLimits {
  if (typeof window !== 'undefined') {
    try {
      const hourly = localStorage.getItem('podio_rate_limit_hour')
      const daily = localStorage.getItem('podio_rate_limit_day')
      
      if (hourly && daily) {
        console.log(`✅ Límites de rate cargados: ${hourly}/hora, ${daily}/día`)
        return {
          hourly: parseInt(hourly),
          daily: parseInt(daily)
        }
      }
    } catch (error) {
      console.warn('⚠️ Error al cargar límites de rate desde localStorage:', error)
    }
  }
  
  // Valores por defecto (límites estándar de Podio)
  console.log('ℹ️ Usando límites de rate por defecto: 5000/hora, 60000/día')
  return { hourly: 5000, daily: 60000 }
}

/**
 * Guarda límites de rate personalizados en localStorage
 * 
 * @param limits - Objeto con límites hourly y daily
 */
export function savePodioRateLimits(limits: PodioRateLimits): void {
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('podio_rate_limit_hour', limits.hourly.toString())
      localStorage.setItem('podio_rate_limit_day', limits.daily.toString())
      console.log(`✅ Límites de rate guardados: ${limits.hourly}/hora, ${limits.daily}/día`)
    } catch (error) {
      console.error('❌ Error al guardar límites de rate:', error)
      throw error
    }
  }
}

/**
 * Restablece los límites de rate a los valores por defecto
 */
export function resetPodioRateLimits(): void {
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('podio_rate_limit_hour')
      localStorage.removeItem('podio_rate_limit_day')
      console.log('✅ Límites de rate restablecidos a valores por defecto')
    } catch (error) {
      console.error('❌ Error al restablecer límites de rate:', error)
    }
  }
}

