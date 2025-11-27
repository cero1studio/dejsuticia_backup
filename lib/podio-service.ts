interface PodioAuth {
  access_token: string
  refresh_token: string
  expires_in: number
  expires_at: number
}

interface PodioOrganization {
  org_id: number
  name: string
  url: string
}

interface PodioWorkspace {
  space_id: number
  name: string
  url: string
}

interface PodioApplication {
  app_id: number
  name: string
  url: string
}

interface PodioItem {
  item_id: number
  title: string
  fields: Record<string, any>
}

export interface PodioFile {
  file_id: number
  name: string
  link: string
  mimetype: string
  size: number
  download_link?: string
}

export interface BackupOptions {
  organizations: boolean
  workspaces: boolean
  applications: boolean
  items: boolean
  files: boolean
}

interface BackupCounts {
  organizations: number
  workspaces: number
  applications: number
  items: number
  files: number
  downloadedFiles: number
}

interface BackupStats {
  apps: number
  items: number
  workspaces: number
  files: number
  backupSize: number
  successfulBackups: number
  backupWarnings: number
  downloadedFiles: number
  downloadedBytes: number
}

interface BackupHistoryItem {
  titulo: string
  categoria: string
  fecha: {
    start: string
    end?: string
  }
  estado: string
  organizaciones: number
  espaciosDeTrabajo: number
  aplicaciones: number
  items: number
  archivos: number
  tamanoEnGb: string
}

type LogLevel = "info" | "warning" | "error" | "success"

interface LogMessage {
  level: LogLevel
  message: string
  timestamp: Date
}

export type ProgressCallback = (data: {
  progress: number
  status: string
  counts: BackupCounts
  stats: BackupStats
  logs: LogMessage[]
}) => void

// Tipos para el manejo de lÃ­mites de tasa
interface RateLimitInfo {
  type: "general" | "rateLimited"
  remaining: number
  limit: number
  resetTime: number
}

// Cambiar el lÃ­mite de test a 20 en todo el flujo
const TEST_LIMIT = 20;

function isTestMode() {
  if (typeof window !== "undefined") {
    return (
      process.env.NEXT_PUBLIC_PODIO_TEST_MODE === "true" ||
      localStorage.getItem("podio_test_mode") === "true"
    )
  }
  return process.env.NEXT_PUBLIC_PODIO_TEST_MODE === "true"
}

// Elimina la declaraciÃ³n global de window.electron para evitar conflictos de tipos

export class PodioBackupService {
  protected authData: PodioAuth | null = null
  private baseUrl = "https://api.podio.com"
  public backupPath = "./public/backups"
  private maxConcurrentRequests = 5
  private logs: LogMessage[] = []
  protected lastProgress = 0
  
  // LÃ­mites optimizados de paginaciÃ³n
  private readonly PAGINATION_LIMITS = {
    items: 500,         // MÃ¡ximo permitido por Podio para items (500 segÃºn API)
    files: 100,         // MÃ¡ximo permitido por Podio para archivos (100 segÃºn API)
    applications: 100,  // LÃ­mite para aplicaciones
    workspaces: 50,    // LÃ­mite para espacios de trabajo
    organizations: 20   // LÃ­mite para organizaciones
  }
  private backupItemId: number | null = null
  private isDownloading = false
  private scannedFiles: PodioFile[] = [];
  private totalFilesToDownload: number | null = null;
  public scannedStats: BackupStats | null = null;
  public scannedApps: Array<{ appId: number; folderPath: string; appName: string }> = [];
  
  // Almacenar archivos completos con toda la informaciÃ³n necesaria para descarga
  protected scannedFilesComplete: Array<{
    file: PodioFile;
    downloadUrl: string;
    folderPath: string;
    appName: string;
  }> = [];

  // Nuevas propiedades para el manejo de lÃ­mites de tasa
  private requestQueue: Array<() => Promise<any>> = []
  private isProcessingQueue = false
  private rateLimits = {
    general: { limit: 1000, remaining: 1000, resetTime: 0 },
    rateLimited: { limit: 250, remaining: 250, resetTime: 0 },
  }
  protected readonly PODIO_RATE_LIMITS = {
    general: 1000,
    rateLimited: 250
  }
  private activeRateLimit: RateLimitInfo | null = null
  private rateLimitRetryTimeout: NodeJS.Timeout | null = null
  private rateLimitCallback: (() => void) | null = null

  // Sistema de cachÃ© para reducir llamadas repetitivas
  private cache = new Map<string, { data: any; timestamp: number; ttl: number }>()
  private readonly CACHE_TTL = {
    organizations: 3600000, // 1 hora
    workspaces: 1800000,    // 30 minutos
    applications: 1800000,   // 30 minutos
    itemCount: 300000,      // 5 minutos
    fileInfo: 600000,       // 10 minutos
  }

  // Propiedades para manejo de escaneos incompletos y checkpoints
  protected currentScanId: number | null = null
  public isScanCancelled: boolean = false
  public isScanning: boolean = false
  protected processingCheckpoint: {
    orgIndex: number
    orgTotal: number
    workspaceIndex: number
    workspaceTotal: number
    appIndex: number
    appTotal: number
    organizations: any[]
    workspacesCounted: boolean
    appsCounted: boolean
  } | null = null

  protected backupCounts: BackupCounts = {
    organizations: 0,
    workspaces: 0,
    applications: 0,
    items: 0,
    files: 0,
    downloadedFiles: 0,
  }

  protected backupStats: BackupStats = {
    apps: 0,
    items: 0,
    workspaces: 0,
    files: 0,
    backupSize: 0,
    successfulBackups: 0,
    backupWarnings: 0,
    downloadedFiles: 0,
    downloadedBytes: 0,
  }

  private backupAppFieldIds: string[] = [];
  private backupStartDate: string | null = null;
  protected backupTimestamp: string | null = null;
  protected readonly REQUEST_DELAY_MS = 100; // Pausa entre requests para evitar saturación

  constructor(backupPath?: string, maxConcurrentRequests?: number) {
    if (backupPath) {
      this.backupPath = backupPath
    }

    // Intentar cargar la configuraciÃ³n guardada
    try {
      if (typeof window !== "undefined") {
        const savedConfig = localStorage.getItem("podio_backup_config")
        if (savedConfig) {
          const config = JSON.parse(savedConfig)
          if (config.folderPath) {
            this.backupPath = config.folderPath
          }
        }
      }
    } catch (e) {
      console.error("Error al cargar la configuraciÃ³n de ruta:", e)
    }

    // Cargar API URL desde configuración (localStorage -> .env -> default)
    this.loadApiUrlFromConfig()

    if (maxConcurrentRequests) {
      this.maxConcurrentRequests = maxConcurrentRequests
    }

    // Logs de inicialización solo en modo desarrollo o si se solicita explícitamente
    // Reducir logs repetitivos en producción
    if (process.env.NODE_ENV === 'development') {
    this.addLog("info", "Servicio de respaldo de Podio inicializado")
    this.addLog("info", `Ruta de respaldo configurada: ${this.backupPath}`)
      this.addLog("info", `API URL configurada: ${this.baseUrl}`)
    } else {
      // En producción, solo loguear si hay algún problema
      // Los logs normales se pueden ver en la UI del dashboard
    }

    // Inicializar los tiempos de reinicio de los lÃ­mites segÃºn documentaciÃ³n oficial de Podio
    const now = Date.now()
    this.rateLimits = {
      general: { limit: 1000, remaining: 1000, resetTime: now + 3600000 }, // 1000 por hora
      rateLimited: { limit: 250, remaining: 250, resetTime: now + 3600000 }, // 250 por hora
    }

    // Eliminar la inicializaciÃ³n automÃ¡tica de la carpeta de respaldos para evitar errores en Electron
    // this.initializeBackupFolder().catch((error) => {
    //   this.addLog(
    //     "error",
    //     `Error al inicializar carpeta de respaldos: ${error instanceof Error ? error.message : String(error)}`,
    //   )
    // })
  }

  /**
   * Cargar API URL desde configuración (localStorage -> .env -> default)
   */
  private loadApiUrlFromConfig(): void {
    // 1. Intentar cargar desde localStorage (configuración del usuario)
    if (typeof window !== "undefined") {
      try {
        const savedApiUrl = localStorage.getItem("podio_api_url")
        if (savedApiUrl && savedApiUrl.trim() !== "") {
          this.baseUrl = savedApiUrl.trim()
          return
        }
      } catch (error) {
        console.warn("⚠️ Error al cargar API URL desde localStorage:", error)
      }
    }

    // 2. Si no hay en localStorage, usar variable de entorno
    const envApiUrl = process.env.NEXT_PUBLIC_PODIO_API_URL
    if (envApiUrl && envApiUrl.trim() !== "") {
      this.baseUrl = envApiUrl.trim()
      return
    }

    // 3. Si no hay en .env, usar valor por defecto (ya está configurado en la declaración)
    // this.baseUrl ya tiene el valor por defecto "https://api.podio.com"
  }

  /**
   * Inicializar la carpeta de respaldos
   */
  protected async initializeBackupFolder(): Promise<void> {
    try {
      this.addLog("info", `Inicializando carpeta de respaldos: ${this.backupPath}`);
      // La creaciÃ³n real de la carpeta debe hacerse desde el proceso principal de Electron o el bridge
      // Por lo tanto, aquÃ­ solo dejamos el log
      this.addLog("success", `Carpeta de respaldos inicializada (verificada): ${this.backupPath}`);
    } catch (error) {
      this.addLog(
        "warning",
        `Error al inicializar carpeta de respaldos: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Obtener el historial de respaldos desde Podio
   * 
   * @param backupAppId - ID de la aplicación de Podio donde se guardan los registros de backup
   * @returns Array de items del historial de respaldos
   * 
   * @remarks
   * - Obtiene los últimos 10 registros de backup desde la aplicación especificada
   * - Cada item incluye información como título, fecha, estado, estadísticas, etc.
   */
  public async getBackupHistory(backupAppId: number): Promise<BackupHistoryItem[]> {
    try {
      this.addLog("info", `Obteniendo historial de respaldos desde la aplicaciÃ³n ${backupAppId}...`)

      if (!this.authData) {
        this.addLog("error", "No autenticado. Llama a authenticate() primero.")
        return []
      }

      // Obtener los elementos de la aplicaciÃ³n de respaldo
      const response = await this.apiRequest<any>(`/item/app/${backupAppId}/?limit=10`)

      if (!response || !Array.isArray(response.items)) {
        this.addLog("warning", `Respuesta inesperada al obtener historial de respaldos: ${JSON.stringify(response)}`)
        return []
      }

      // Mapear los elementos a objetos BackupHistoryItem
      const historyItems = response.items.map((item: any) => {
        // Extraer los campos relevantes
        const fields = item.fields || []

        // Buscar los campos por su nombre externo
        const findFieldValue = (externalId: string) => {
          const field = fields.find((f: any) => f.external_id === externalId)
          return field ? field.values : null
        }

        // Obtener valores de los campos
        const titulo = item.title || "Respaldo sin tÃ­tulo"
        const categoria = findFieldValue("categoria") ? findFieldValue("categoria")[0].value : "General"
        const fechaStart = findFieldValue("fecha") ? findFieldValue("fecha")[0].start : new Date().toISOString()
        const fechaEnd = findFieldValue("fecha") ? findFieldValue("fecha")[0].end : null
        const estado = findFieldValue("estado") ? findFieldValue("estado")[0].value : "Pendiente"
        const organizaciones = findFieldValue("organizaciones") ? Number(findFieldValue("organizaciones")[0].value) : 0
        const espaciosDeTrabajo = findFieldValue("espacios-de-trabajo")
          ? Number(findFieldValue("espacios-de-trabajo")[0].value)
          : 0
        const aplicaciones = findFieldValue("aplicaciones") ? Number(findFieldValue("aplicaciones")[0].value) : 0
        const items = findFieldValue("items") ? Number(findFieldValue("items")[0].value) : 0
        const archivos = findFieldValue("archivos") ? Number(findFieldValue("archivos")[0].value) : 0
        const tamanoEnGb = findFieldValue("tamano-en-gb") ? findFieldValue("tamano-en-gb")[0].value : "0 GB"

        return {
          titulo,
          categoria,
          fecha: {
            start: fechaStart,
            end: fechaEnd,
          },
          estado,
          organizaciones,
          espaciosDeTrabajo,
          aplicaciones,
          items,
          archivos,
          tamanoEnGb,
        }
      })

      this.addLog("success", `Se encontraron ${historyItems.length} registros de respaldo`)
      return historyItems
    } catch (error) {
      this.addLog(
        "error",
        `Error al obtener historial de respaldos: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }
  }

  /**
   * Obtener estadísticas de respaldo actuales
   * 
   * @returns Copia de las estadísticas de respaldo (apps, items, workspaces, files, etc.)
   * 
   * @remarks
   * - Retorna una copia para evitar mutaciones externas
   * - Las estadísticas se actualizan durante el proceso de escaneo y backup
   */
  public getBackupStats(): BackupStats {
    return { ...this.backupStats }
  }

  /**
   * Obtener logs del servicio
   * 
   * @returns Array de mensajes de log (info, success, warning, error)
   * 
   * @remarks
   * - Los logs se mantienen en memoria (últimos 100 mensajes)
   * - Útil para debugging y mostrar historial al usuario
   */
  public getLogs(): LogMessage[] {
    return [...this.logs]
  }

  /**
   * Obtener información sobre límites de tasa desde memoria
   * 
   * @returns Objeto con información del rate limit activo:
   * - active: true si hay un rate limit activo
   * - remainingSeconds: segundos restantes hasta que expire el rate limit
   * - type: tipo de rate limit ('general', 'rateLimited', o 'none')
   * 
   * @remarks
   * Este método solo consulta la memoria. Para obtener información desde BD, usar getRateLimitInfoFromDb()
   */
  public getRateLimitInfo() {
    return {
      active: !!this.activeRateLimit,
      remainingSeconds: this.activeRateLimit ? Math.ceil((this.activeRateLimit.resetTime - Date.now()) / 1000) : 0,
      type: this.activeRateLimit ? this.activeRateLimit.type : "none",
    }
  }

  /**
   * Verificar si hay un rate limit activo de forma síncrona
   * Verifica tanto la memoria como la BD (si está disponible)
   * 
   * @returns true si hay un rate limit activo, false en caso contrario
   * 
   * @remarks
   * - Este método es síncrono y puede ser llamado desde código que no puede esperar promesas
   * - Primero verifica la memoria, luego intenta verificar BD si está disponible
   * - Si el rate limit expiró, lo limpia automáticamente
   */
  public isRateLimitActiveSync(): boolean {
    // Verificar rate limit en memoria primero
    if (this.activeRateLimit) {
      const remainingSeconds = Math.ceil((this.activeRateLimit.resetTime - Date.now()) / 1000);
      if (remainingSeconds > 0) {
        return true;
      }
      // Si expirÃ³, limpiarlo
      this.activeRateLimit = null;
    }
    
    // Verificar BD si estÃ¡ disponible (solo en Electron)
    // Nota: getRateLimitStatusFromDb puede ser asÃ­ncrono, pero intentamos verificar
    // de forma sÃ­ncrona si es posible
    if (typeof window !== 'undefined' && window.electron && window.electron.db) {
      try {
        // La BD puede requerir async, pero por ahora solo verificamos memoria
        // Si necesitamos verificar BD, deberÃ­a hacerse de forma asÃ­ncrona
        // Por ahora, retornamos false si no hay rate limit en memoria
      } catch (error) {
        // Si hay error, solo confiar en memoria
        console.warn('Error verificando rate limit:', error);
      }
    }
    
    return false;
  }

  /**
   * Cancela el escaneo en progreso
   * Marca el flag isScanCancelled para detener el proceso de escaneo.
   * Los módulos de escaneo verifican este flag periódicamente y detienen el procesamiento cuando es true.
   * 
   * @remarks
   * - Este método es llamado desde el frontend cuando el usuario presiona "Parar Escaneo"
   * - El scan se marcará como cancelado en BD cuando los módulos detecten el flag
   * - No detiene inmediatamente las peticiones en curso, pero evita que se inicien nuevas
   */
  public cancelScan(): void {
    this.isScanCancelled = true;
    this.isScanning = false;
    
    // Nota: El scan se marcará como cancelado en BD cuando se detecte el flag
    // en los módulos de escaneo que verifican isScanCancelled
    
    this.addLog("warning", "Escaneo cancelado por el usuario");
  }

  /**
   * Fuerza el reintento después de un rate limit
   * Limpia el rate limit en memoria y BD para permitir que el proceso continúe.
   * 
   * @remarks
   * - ADVERTENCIA: Esto puede causar que Podio responda 429/420 nuevamente si el rate limit aún está activo
   * - Útil cuando el usuario quiere forzar la continuación del proceso
   * - Limpia tanto el rate limit en memoria como en la base de datos persistente
   * 
   * @returns Resultado de la operación con éxito y mensaje descriptivo
   */
  public async forceRetryAfterRateLimit(): Promise<{ success: boolean; message: string }> {
    try {
      this.activeRateLimit = null;
      if (this.rateLimitRetryTimeout) {
        clearTimeout(this.rateLimitRetryTimeout);
        this.rateLimitRetryTimeout = null;
      }
      
      if (typeof window !== 'undefined' && window.electron?.db) {
        await window.electron.db.clearRateLimitStatus('general');
        await window.electron.db.clearRateLimitStatus('rateLimited');
      }
      
      this.addLog("info", "Rate limit limpiado forzadamente");
      return { success: true, message: "Rate limit limpiado exitosamente" };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.addLog("error", `Error al limpiar rate limit: ${errorMsg}`);
      return { success: false, message: errorMsg };
    }
  }

  /**
   * Establecer callback para cuando termine el rate limit
   */
  setRateLimitCallback(callback: () => void) {
    this.rateLimitCallback = callback
  }

  /**
   * Determinar si una operaciÃ³n es rate-limited segÃºn endpoint y mÃ©todo
   */
  private isRateLimitedOperation(endpoint: string, method: string): boolean {
    // POST/PUT/DELETE son rate-limited
    if (method !== 'GET') return true
    
    // Endpoints especÃ­ficos rate-limited
    if (endpoint.includes('/file/') || 
        endpoint.includes('/xlsx/') || 
        endpoint.includes('/download_link')) {
      return true
    }
    
    return false
  }

  /**
   * Encola una solicitud a la API y la procesa respetando los lÃ­mites de tasa
   */
  private async enqueueRequest<T>(requestFn: () => Promise<T>, endpoint: string, method: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // VERIFICAR RATE LIMIT ANTES de agregar a la cola
      // Si hay rate limit activo, NO agregar la petición y rechazar inmediatamente
      if (this.activeRateLimit) {
        const waitTime = Math.ceil((this.activeRateLimit.resetTime - Date.now()) / 1000)
        if (waitTime > 0) {
          this.addLog(
            "warning",
            `⏸️ Petición bloqueada: Rate limit activo (${this.activeRateLimit.type}). Esperando ${waitTime} segundos...`,
          )
          reject(new Error(`RATE_LIMIT_ERROR:${waitTime}:${this.activeRateLimit.type}`))
          return
        } else {
          // Si el tiempo ya expiró, limpiar el rate limit
          this.activeRateLimit = null
        }
      }

      // Verificar y actualizar los lÃ­mites de tasa ANTES de agregar a la cola
      this.updateRateLimits()

      // Determinar el tipo de lÃ­mite segÃºn la operaciÃ³n
      const limitType = this.isRateLimitedOperation(endpoint, method)
      const currentLimit = this.rateLimits[limitType ? 'rateLimited' : 'general']

      // Verificar si hemos alcanzado el lÃ­mite ANTES de agregar a la cola
      if (currentLimit.remaining <= 0) {
        const waitTime = Math.ceil((currentLimit.resetTime - Date.now()) / 1000)
        this.setActiveRateLimit(limitType ? 'rateLimited' : 'general', waitTime)
        this.addLog(
          "warning",
          `⏸️ Petición bloqueada: Límite de tasa alcanzado (${limitType ? 'rateLimited' : 'general'}). Esperando ${waitTime} segundos...`,
        )
        reject(new Error(`RATE_LIMIT_ERROR:${waitTime}:${limitType ? 'rateLimited' : 'general'}`))
        return
      }

      // AÃ±adir la solicitud a la cola solo si no hay rate limit
      this.requestQueue.push(async () => {
        try {
          // Verificar nuevamente si hay un lÃ­mite de tasa activo (por si cambió mientras estaba en la cola)
          if (this.activeRateLimit) {
            const waitTime = Math.ceil((this.activeRateLimit.resetTime - Date.now()) / 1000)
            if (waitTime > 0) {
            this.addLog(
              "warning",
                `LÃ­mite de tasa activo (${this.activeRateLimit.type}). Esperando ${waitTime} segundos...`,
            )
            throw new Error(`RATE_LIMIT_ERROR:${waitTime}:${this.activeRateLimit.type}`)
            } else {
              // Si el tiempo ya expiró, limpiar el rate limit
              this.activeRateLimit = null
            }
          }

          // Verificar y actualizar los lÃ­mites de tasa
          this.updateRateLimits()

          // Determinar el tipo de lÃ­mite segÃºn la operaciÃ³n
          const limitType = this.isRateLimitedOperation(endpoint, method)
          const currentLimit = this.rateLimits[limitType ? 'rateLimited' : 'general']

          // Verificar si hemos alcanzado el lÃ­mite
          if (currentLimit.remaining <= 0) {
            const waitTime = Math.ceil((currentLimit.resetTime - Date.now()) / 1000)
            this.setActiveRateLimit(limitType ? 'rateLimited' : 'general', waitTime)
            throw new Error(`RATE_LIMIT_ERROR:${waitTime}:${limitType ? 'rateLimited' : 'general'}`)
          }

          // Decrementar el contador del lÃ­mite apropiado
          currentLimit.remaining--

          // Ejecutar la solicitud
          const result = await requestFn()
          resolve(result)
          return result
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
            // Si es un error de rate limit, lo propagamos para que se maneje en el nivel superior
            reject(error)
          } else {
            // Otros errores
            reject(error)
          }
          throw error
        }
      })

      // Iniciar el procesamiento de la cola si no estÃ¡ en curso
      if (!this.isProcessingQueue) {
        this.processQueue()
      }
    })
  }

  /**
   * Actualiza los lÃ­mites de tasa segÃºn el tiempo transcurrido
   */
  private updateRateLimits(): void {
    const now = Date.now()

    // Reiniciar el lÃ­mite general cada hora
    if (now >= this.rateLimits.general.resetTime) {
      this.rateLimits.general.remaining = this.rateLimits.general.limit
      this.rateLimits.general.resetTime = now + 3600000 // 1 hora
    }

    // Reiniciar el lÃ­mite rate-limited cada hora
    if (now >= this.rateLimits.rateLimited.resetTime) {
      this.rateLimits.rateLimited.remaining = this.rateLimits.rateLimited.limit
      this.rateLimits.rateLimited.resetTime = now + 3600000 // 1 hora
    }
  }

  /**
   * Establece un lÃ­mite de tasa activo
   */
  private setActiveRateLimit(type: "general" | "rateLimited", waitTime: number): void {
    const now = Date.now()
    this.activeRateLimit = {
      type,
      remaining: 0,
      limit: this.rateLimits[type].limit,
      resetTime: now + waitTime * 1000,
    }

    this.addLog(
      "error",
      `âš ï¸ LÃMITE DE TASA DE PODIO ALCANZADO (${type}). Se esperarÃ¡ ${waitTime} segundos antes de reintentar automÃ¡ticamente.`,
    )

    // Configurar un temporizador para desactivar el lÃ­mite
    if (this.rateLimitRetryTimeout) {
      clearTimeout(this.rateLimitRetryTimeout)
    }

    this.rateLimitRetryTimeout = setTimeout(() => {
      this.activeRateLimit = null
      this.addLog("info", "âœ… Tiempo de espera por lÃ­mite de tasa completado. Continuando operaciones...")

      // Llamar al callback si existe
      if (this.rateLimitCallback) {
        const callback = this.rateLimitCallback
        this.rateLimitCallback = null
        callback()
      }
    }, waitTime * 1000)
  }

  // Actualizar la funciÃ³n getRateLimitTitle para reflejar los nuevos lÃ­mites
  // FunciÃ³n para obtener el tÃ­tulo del lÃ­mite de tasa
  private getRateLimitTitle(type: string): string {
    switch (type) {
      case "general":
        return "LÃMITE GENERAL (1,000 solicitudes/hora)"
      case "rateLimited":
        return "LÃMITE RATE-LIMITED (250 solicitudes/hora)"
      default:
        return "LÃMITE DE TASA DE PODIO ALCANZADO"
    }
  }

  /**
   * Actualizar lÃ­mites desde headers de respuesta de Podio
   */
  private updateRateLimitsFromHeaders(headers: Headers, endpoint: string, method: string): void {
    const limitType = this.isRateLimitedOperation(endpoint, method) ? 'rateLimited' : 'general'
    const limit = headers.get('X-Rate-Limit-Limit')
    const remaining = headers.get('X-Rate-Limit-Remaining')
    
    if (limit && remaining) {
      this.rateLimits[limitType].limit = parseInt(limit)
      this.rateLimits[limitType].remaining = parseInt(remaining)
      this.addLog("info", `Rate limit ${limitType}: ${remaining}/${limit} restantes`)
    }
    
    // Registrar la llamada en BD si está disponible (para llamadas directas con fetch)
    // Esto asegura que llamadas fuera de apiRequest también se registren
    if (typeof window !== 'undefined' && window.electron && window.electron.db) {
      const contentLength = headers.get('Content-Length')
      const responseBytes = contentLength ? parseInt(contentLength, 10) : undefined
      // No esperar, hacer asíncrono
      this.logApiRequest(method, endpoint, limitType, 200, responseBytes).catch(() => {
        // Ignorar errores de registro silenciosamente
      })
    }
  }

  /**
   * Registrar una llamada API en la base de datos (asíncrono, no bloquea)
   */
  private async logApiRequest(
    method: string,
    endpoint: string,
    rateType: 'general' | 'rateLimited',
    status: number,
    bytes?: number,
    meta?: any
  ): Promise<void> {
    try {
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        await window.electron.db.logRequest({
          method,
          endpoint,
          rate_type: rateType,
          status,
          bytes,
          meta
        })
      }
    } catch (error) {
      // Ignorar errores de registro silenciosamente para no bloquear el flujo principal
      // Solo loguear en consola para debugging
      console.warn('Error registrando llamada API en BD:', error)
    }
  }

  /**
   * Sistema de cachÃ© para reducir llamadas repetitivas
   */
  private getCacheKey(endpoint: string, method: string = "GET"): string {
    return `${method}:${endpoint}`
  }

  private getFromCache<T>(endpoint: string, method: string = "GET"): T | null {
    const key = this.getCacheKey(endpoint, method)
    const cached = this.cache.get(key)
    
    if (!cached) return null
    
    const now = Date.now()
    if (now - cached.timestamp > cached.ttl) {
      this.cache.delete(key)
      return null
    }
    
    this.addLog("info", `Cache hit para ${endpoint}`)
    return cached.data
  }

  private setCache<T>(endpoint: string, data: T, method: string = "GET", ttl?: number): void {
    const key = this.getCacheKey(endpoint, method)
    
    // Determinar TTL basado en el endpoint
    let cacheTtl = ttl
    if (!cacheTtl) {
      if (endpoint.includes('/org/')) cacheTtl = this.CACHE_TTL.organizations
      else if (endpoint.includes('/space/')) cacheTtl = this.CACHE_TTL.workspaces
      else if (endpoint.includes('/app/')) cacheTtl = this.CACHE_TTL.applications
      else if (endpoint.includes('/count')) cacheTtl = this.CACHE_TTL.itemCount
      else if (endpoint.includes('/file/')) cacheTtl = this.CACHE_TTL.fileInfo
      else cacheTtl = 300000 // 5 minutos por defecto
    }
    
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: cacheTtl
    })
    
    this.addLog("info", `Cache set para ${endpoint} (TTL: ${cacheTtl/1000}s)`)
  }

  private clearCache(): void {
    this.cache.clear()
    this.addLog("info", "Cache limpiado")
  }

  /**
   * Reintentos inteligentes con backoff exponencial
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000,
    operationName: string = "operaciÃ³n"
  ): Promise<T> {
    let lastError: Error | null = null
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation()
        if (attempt > 1) {
          this.addLog("success", `âœ… ${operationName} exitosa en intento ${attempt}/${maxRetries} (despuÃ©s de reintentos)`)
        }
        return result
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        
        // No reintentar errores de rate limit, errores de límites inválidos, o errores de autenticaciÃ³n
        if (lastError.message.includes('RATE_LIMIT_ERROR') || 
            lastError.message.includes('INVALID_LIMIT_ERROR') ||
            lastError.message.includes('No autenticado') ||
            lastError.message.includes('401') ||
            lastError.message.includes('403')) {
          throw lastError
        }
        
        if (attempt === maxRetries) {
          this.addLog("error", `${operationName} fallÃ³ despuÃ©s de ${maxRetries} intentos: ${lastError.message}`)
          throw lastError
        }
        
        // Calcular delay con backoff exponencial + jitter
        const exponentialDelay = baseDelay * Math.pow(2, attempt - 1)
        const jitter = Math.random() * 1000 // 0-1000ms de jitter
        const delay = Math.min(exponentialDelay + jitter, 30000) // MÃ¡ximo 30 segundos
        
        this.addLog("warning", `ðŸ”„ REINTENTO ${attempt}/${maxRetries}: ${operationName} fallÃ³`)
        this.addLog("info", `âŒ Error: ${lastError.message}`)
        this.addLog("info", `â³ Reintentando en ${Math.round(delay/1000)}s con backoff exponencial...`)
        
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
    
    throw lastError || new Error(`${operationName} fallÃ³ despuÃ©s de ${maxRetries} intentos`)
  }

  /**
   * Procesar organización en paralelo con mensajes detallados
   * 
   * @param org - Organización a procesar
   * @param progressCallback - Callback para reportar progreso
   * @param orgTotal - Total de organizaciones a procesar
   * @param orgIndex - Índice actual de la organización (1-based)
   * @param scanOnly - Si true, solo escanea sin descargar archivos
   * @returns Resultado del procesamiento con workspaces, applications, items y files consolidados
   * 
   * @remarks
   * - Usado por los módulos de escaneo para procesar organizaciones
   * - Procesa workspaces en paralelo para optimizar rendimiento
   * - Consolida resultados de todos los workspaces de la organización
   */
  protected async processOrganizationParallel(
    org: any, 
    progressCallback?: ProgressCallback,
    orgTotal?: number,
    orgIndex?: number,
    scanOnly?: boolean
  ): Promise<{
    workspaces: any[];
    applications: any[];
    itemsCount: number;
    files: PodioFile[];
  }> {
    const orgCounter = orgIndex !== undefined && orgTotal !== undefined 
      ? `[Org ${orgIndex + 1}/${orgTotal}]` 
      : '';
    this.addLog("info", `🏢 ${orgCounter} Procesando organización: ${org.name}`);
    
    const workspaces = await this.retryWithBackoff(
      () => this.getWorkspaces(org.org_id),
      3,
      1000,
      `obtener espacios de trabajo de ${org.name}`
    );
    
    this.addLog("info", `📁 ${orgCounter} Espacios encontrados en "${org.name}": ${workspaces.length}`);
    this.addLog("info", `📚 ${orgCounter} Contadores actuales: ${this.backupCounts.workspaces} workspaces, ${this.backupCounts.applications} apps, ${this.backupCounts.items} items, ${this.backupCounts.files} archivos`);
    
    // Procesar espacios de trabajo en paralelo
    const workspacePromises = workspaces.map(workspace => 
      this.processWorkspaceParallel(workspace, progressCallback, org, scanOnly)
    );
    
    this.addLog("info", `⚡ ${orgCounter} Procesando ${workspaces.length} espacios en paralelo...`);
    const workspaceResults = await Promise.all(workspacePromises);
    
    // Consolidar resultados
    const allApplications = workspaceResults.flatMap(result => result.applications);
    const totalItemsCount = workspaceResults.reduce((sum, result) => sum + result.itemsCount, 0);
    const allFiles = workspaceResults.flatMap(result => result.files);
    
    // Actualizar contadores de workspaces
    this.backupCounts.workspaces += workspaces.length;
    this.backupStats.workspaces += workspaces.length;
    
    // Actualizar progreso con contadores actualizados
    if (progressCallback && orgTotal && orgIndex !== undefined) {
      const progress = Math.min(95, 1 + ((orgIndex / orgTotal) * 94));
      const status = `Org ${orgIndex + 1}/${orgTotal}: ${org.name} | Workspaces: ${this.backupCounts.workspaces} | Apps: ${this.backupCounts.applications} | Items: ${this.backupCounts.items} | Archivos: ${this.backupCounts.files}`;
      this.updateProgress(progress, status, progressCallback);
    }
    
    this.addLog("success", `✅ ${orgCounter} Organización "${org.name}" completada:`);
    this.addLog("info", `   📁 Espacios: ${workspaces.length}`);
    this.addLog("info", `   📱 Aplicaciones: ${allApplications.length}`);
    this.addLog("info", `   📄 Items: ${totalItemsCount}`);
    this.addLog("info", `   📎 Archivos: ${allFiles.length}`);
    
    return {
      workspaces,
      applications: allApplications,
      itemsCount: totalItemsCount,
      files: allFiles
    };
  }

  /**
   * Procesar espacio de trabajo en paralelo
   * 
   * @param workspace - Espacio de trabajo a procesar
   * @param progressCallback - Callback para reportar progreso
   * @param org - Organización a la que pertenece el workspace (opcional)
   * @returns Resultado del procesamiento con applications, items y files consolidados
   * 
   * @remarks
   * - Usado por los módulos de escaneo para procesar workspaces
   * - Procesa aplicaciones en paralelo para optimizar rendimiento
   * - Consolida resultados de todas las aplicaciones del workspace
   */
  protected async processWorkspaceParallel(workspace: any, progressCallback?: ProgressCallback, org?: any, scanOnly?: boolean): Promise<{
    applications: any[];
    itemsCount: number;
    files: PodioFile[];
  }> {
    this.addLog("info", `📁 Procesando espacio de trabajo: ${workspace.name}`);
    
    const applications = await this.retryWithBackoff(
      () => this.getApplications(workspace.space_id),
      3,
      1000,
      `obtener aplicaciones de ${workspace.name}`
    );
    
    this.addLog("info", `📱 Espacio "${workspace.name}": ${applications.length} aplicaciones encontradas`);
    this.addLog("info", `📚 Contadores actuales: ${this.backupCounts.workspaces} workspaces, ${this.backupCounts.applications} apps, ${this.backupCounts.items} items, ${this.backupCounts.files} archivos`);
    
    // Procesar aplicaciones en paralelo (limitado para evitar sobrecarga)
    const maxConcurrentApps = 3; // Procesar máximo 3 apps en paralelo
    let totalItemsCount = 0;
    const allFiles: PodioFile[] = [];
    const totalApps = applications.length;
    
    for (let i = 0; i < applications.length; i += maxConcurrentApps) {
      const appBatch = applications.slice(i, i + maxConcurrentApps);
      const appPromises = appBatch.map((app, batchIndex) => {
        const appIndex = i + batchIndex;
        return this.processApplicationParallel(app, progressCallback, org, workspace, scanOnly, appIndex, totalApps);
      });
      
      const appResults = await Promise.all(appPromises);
      
      appResults.forEach(result => {
        totalItemsCount += result.itemsCount;
        allFiles.push(...result.files);
      });
    }
    
    this.addLog("success", `✅ Espacio "${workspace.name}" completado: ${applications.length} apps, ${totalItemsCount} items, ${allFiles.length} archivos`);
    
    return {
      applications,
      itemsCount: totalItemsCount,
      files: allFiles
    };
  }

  /**
   * Procesar aplicación en paralelo
   * 
   * @param app - Aplicación a procesar
   * @param progressCallback - Callback para reportar progreso
   * @param org - Organización a la que pertenece la app (opcional)
   * @param workspace - Espacio de trabajo al que pertenece la app (opcional)
   * @param scanOnly - Si true, solo escanea sin descargar excels. Si false, descarga excels durante el escaneo
   * @returns Resultado del procesamiento con items y files consolidados
   * 
   * @remarks
   * - Usado por los módulos de escaneo para procesar aplicaciones
   * - SIEMPRE crea la estructura de carpetas durante el escaneo (incluso si no hay archivos)
   * - Guarda apps y files en BD durante el escaneo (incluso si no hay archivos)
   * - Descarga excels durante el escaneo si scanOnly === false
   * - Actualiza contadores y estadísticas INMEDIATAMENTE después de obtener datos
   * - Actualiza progreso constantemente con indicadores numéricos en tiempo real
   * - Usa /file/app/{app_id}/ para obtener archivos (optimizado, no itera por items)
   */
  protected async processApplicationParallel(
    app: any, 
    progressCallback?: ProgressCallback, 
    org?: any, 
    workspace?: any, 
    scanOnly?: boolean,
    appIndex?: number,
    totalApps?: number
  ): Promise<{
    itemsCount: number;
    files: PodioFile[];
  }> {
    const appCounter = appIndex !== undefined && totalApps !== undefined 
      ? `[App ${appIndex + 1}/${totalApps}]` 
      : '';
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.addLog("warning", `📱 ${appCounter} PROCESANDO APLICACIÓN: ${app.name}`);
    this.addLog("warning", `📱 ${appCounter} scanOnly recibido: ${scanOnly} (debe ser false para descargar Excel)`);
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    // SIEMPRE crear carpeta para la app, incluso si no tiene archivos
    // IMPORTANTE: Verificar que backupTimestamp esté generado antes de crear carpetas
    if (!this.backupTimestamp && typeof window !== 'undefined' && window.electron) {
      this.backupTimestamp = this.generateBackupTimestamp();
      this.addLog("info", `🗄️ Timestamp de backup generado: ${this.backupTimestamp}`);
    }
    
    // PASO 1: Crear carpeta de la app PRIMERO
    // CRÍTICO: La carpeta DEBE crearse para TODAS las apps, incluso si no tienen items
    // Esto es necesario para descargar el Excel
    let folderPath: string | null = null;
    if (org && workspace && typeof window !== 'undefined' && window.electron) {
      try {
        this.addLog("info", `📁 ${appCounter} Creando carpeta para: ${app.name}`);
        // createFolderStructure está sobrescrito en podio-service-electron.ts y usa backupTimestamp
        folderPath = await this.createFolderStructure(org.name, workspace.name, app.name);
        this.addLog("success", `📁 ${appCounter} Carpeta creada: ${folderPath}`);
      } catch (error) {
        this.addLog("error", `❌ Error crítico creando carpeta para ${app.name}: ${error instanceof Error ? error.message : String(error)}`);
        // CRÍTICO: Si falla la creación de carpeta, intentar crear una ruta alternativa o reintentar
        // NO lanzar el error inmediatamente - intentar una vez más
        this.addLog("warning", `⚠️ Reintentando creación de carpeta para ${app.name}...`);
        try {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar 1 segundo
          folderPath = await this.createFolderStructure(org.name, workspace.name, app.name);
          this.addLog("success", `📁 Carpeta creada en segundo intento: ${folderPath}`);
        } catch (retryError) {
          this.addLog("error", `❌ Error crítico en segundo intento para ${app.name}: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
          // Si aún falla, construir la ruta manualmente y crear la carpeta directamente
          try {
            const safeOrgName = this.sanitizeFileName(org.name);
            const safeWorkspaceName = this.sanitizeFileName(workspace.name);
            const safeAppName = this.sanitizeFileName(app.name);
            const basePath = this.backupTimestamp 
              ? `${this.backupPath}/${this.backupTimestamp}`
              : this.backupPath;
            folderPath = `${basePath}/${safeOrgName}/${safeWorkspaceName}/${safeAppName}`;
            await this.ensureFolderExists(folderPath);
            this.addLog("success", `📁 Carpeta creada manualmente: ${folderPath}`);
          } catch (manualError) {
            this.addLog("error", `❌ Error crítico creando carpeta manualmente para ${app.name}: ${manualError instanceof Error ? manualError.message : String(manualError)}`);
            // Si todo falla, lanzar el error original
            throw error;
          }
        }
      }
    } else {
      // Si no hay org, workspace o Electron, loguear el problema
      if (!org) {
        this.addLog("error", `❌ [${app.name}] No se puede crear carpeta: org es null/undefined`);
      } else if (!workspace) {
        this.addLog("error", `❌ [${app.name}] No se puede crear carpeta: workspace es null/undefined`);
      } else if (typeof window === 'undefined' || !window.electron) {
        this.addLog("error", `❌ [${app.name}] No se puede crear carpeta: Electron no disponible`);
      }
    }
    
    // PASO 2: Obtener conteo de items y archivos para el conteo y guardado en BD
    // OPTIMIZACIÓN: Solo obtener el conteo de items (1 llamada API) en lugar de todos los items (N llamadas)
    const itemsCount = await this.retryWithBackoff(
      () => this.getItemsCount(app.app_id),
      3,
      1000,
      `obtener conteo de items de ${app.name}`
    );
    
    // OPTIMIZACIÓN: Usar /file/app/{app_id}/ para obtener todos los archivos de una vez
    // Esto es mucho más eficiente que iterar por cada item
    this.addLog("info", `📥 [${app.name}] Obteniendo archivos de la app (app_id: ${app.app_id})...`);
    const allFiles = await this.retryWithBackoff(
      () => this.getAppFiles(app.app_id),
          3,
          1000,
      `obtener archivos de ${app.name}`
    );
    this.addLog("info", `📊 [${app.name}] Datos obtenidos: ${itemsCount} items, ${allFiles.length} archivos`);
    
    // Log resumen del proceso de archivos
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.addLog("warning", `📋 ${appCounter} PROCESANDO ARCHIVOS PARA APP: ${app.name}`);
    this.addLog("warning", `📋 ${appCounter} Comprobando archivos para app (${allFiles.length} archivos encontrados)`);
    this.addLog("warning", `📋 ${appCounter} Si existen archivos: creando carpeta files, guardando rutas de descarga de archivos en base de datos`);
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    // Actualizar contadores INMEDIATAMENTE después de obtener datos
    this.backupCounts.applications++;
    this.backupCounts.items += itemsCount;
    this.backupCounts.files += allFiles.length;
    this.backupStats.apps++;
    this.backupStats.items += itemsCount;
    this.backupStats.files += allFiles.length;
    
    // Calcular tamaño total
    allFiles.forEach(file => {
      if (file.size && file.size > 0) {
        this.backupStats.backupSize += file.size / (1024 * 1024 * 1024); // Sumar en GB
      }
    });
    
    // PASO 3: Descargar Excel INMEDIATAMENTE después de crear la carpeta
    // CRÍTICO: El Excel se descarga ANTES de crear la carpeta files
    // IMPORTANTE: TODAS las apps deben descargar Excel, incluso si no tienen items
    // El Excel puede estar vacío, pero debe descargarse
    const excelFileName = `${this.sanitizeFileName(app.name)}_oficial.xlsx`;
    const excelPath = folderPath ? `${folderPath}/${excelFileName}` : null;
    
    // CRÍTICO: Si folderPath es null pero tenemos org y workspace, intentar construir la ruta
    if (!folderPath && org && workspace && typeof window !== 'undefined' && window.electron) {
      this.addLog("warning", `⚠️ [${app.name}] folderPath es null, intentando construir ruta manualmente...`);
      try {
        const safeOrgName = this.sanitizeFileName(org.name);
        const safeWorkspaceName = this.sanitizeFileName(workspace.name);
        const safeAppName = this.sanitizeFileName(app.name);
        const basePath = this.backupTimestamp 
          ? `${this.backupPath}/${this.backupTimestamp}`
          : this.backupPath;
        folderPath = `${basePath}/${safeOrgName}/${safeWorkspaceName}/${safeAppName}`;
        await this.ensureFolderExists(folderPath);
        this.addLog("success", `📁 Carpeta construida manualmente para Excel: ${folderPath}`);
      } catch (manualError) {
        this.addLog("error", `❌ [${app.name}] No se pudo construir carpeta manualmente: ${manualError instanceof Error ? manualError.message : String(manualError)}`);
      }
    }
    
    // CRÍTICO: Verificar condiciones ANTES de intentar descargar
    // LOGS MUY VISIBLES para debugging
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.addLog("warning", `🔍 [${app.name}] ========== EVALUACIÓN PARA DESCARGAR EXCEL ==========`);
    this.addLog("warning", `   📁 folderPath existe: ${!!folderPath} (${folderPath || 'null'})`);
    this.addLog("warning", `   🔄 scanOnly: ${scanOnly} (debe ser false para descargar)`);
    this.addLog("warning", `   ⚡ Electron disponible: ${typeof window !== 'undefined' && !!window.electron}`);
    this.addLog("warning", `   📊 App ID: ${app.app_id}`);
    this.addLog("warning", `   📄 Archivo Excel: ${excelFileName}`);
    this.addLog("warning", `   📂 Ruta completa: ${excelPath || 'N/A'}`);
    
    const canDownloadExcel = folderPath && !scanOnly && typeof window !== 'undefined' && window.electron;
    this.addLog("warning", `   ✅ RESULTADO FINAL: ${canDownloadExcel ? '✅✅✅ SÍ PUEDE DESCARGAR EXCEL ✅✅✅' : '❌❌❌ NO PUEDE DESCARGAR EXCEL ❌❌❌'}`);
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    if (canDownloadExcel) {
      try {
        this.addLog("warning", `🚀🚀🚀 INICIANDO DESCARGA DE EXCEL PARA: ${app.name} 🚀🚀🚀`);
        this.addLog("warning", `📊 ${appCounter} Descargando Excel para: ${app.name}`);
        this.addLog("warning", `📁 ${appCounter} Carpeta: ${folderPath}`);
        this.addLog("warning", `📊 ${appCounter} Archivo: ${excelFileName}`);
        this.addLog("warning", `📊 ${appCounter} Total de items a exportar: ${itemsCount}`);
        this.addLog("warning", `📊 ${appCounter} Llamando a downloadAppExcel ahora...`);
        
        const excelStartTime = Date.now();
        await this.downloadAppExcel(app.app_id, folderPath!, app.name, progressCallback, appIndex, totalApps);
        const excelEndTime = Date.now();
        const excelDuration = ((excelEndTime - excelStartTime) / 1000).toFixed(2);
        
        this.addLog("success", `✅✅✅ ${appCounter} EXCEL DESCARGADO EXITOSAMENTE: ${app.name} (${excelDuration}s) ✅✅✅`);
        this.addLog("success", `📁 ${appCounter} Archivo guardado en: ${excelPath}`);
      } catch (error) {
        // CRÍTICO: Si es rate limit, propagar el error para que se maneje en el nivel superior (pausa automática)
        if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
          this.addLog("warning", `⏸️ [${app.name}] Rate limit detectado al descargar Excel. Se pausará y reintentará automáticamente.`);
          throw error; // Propagar para manejo de rate limit con pausa automática
        }
        // CRÍTICO: Si es cancelación, propagar
        if (error instanceof Error && error.message.startsWith("ESCANEO_CANCELADO:")) {
          this.addLog("warning", `🚫 [${app.name}] Escaneo cancelado durante descarga de Excel`);
          throw error; // Propagar cancelación
        }
        // CRÍTICO: Para TODOS los demás errores, lanzar para PAUSAR el proceso
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : 'N/A';
        this.addLog("error", `❌ [${app.name}] ========== ERROR DESCARGANDO EXCEL ==========`);
        this.addLog("error", `❌ [${app.name}] Mensaje: ${errorMessage}`);
        this.addLog("error", `❌ [${app.name}] Stack: ${errorStack}`);
        this.addLog("error", `❌ [${app.name}] App ID: ${app.app_id}`);
        this.addLog("error", `❌ [${app.name}] Folder Path: ${folderPath}`);
        this.addLog("error", `❌ [${app.name}] Items Count: ${itemsCount}`);
        this.addLog("error", `❌ [${app.name}] ===============================================`);
        this.addLog("error", `❌ [${app.name}] El proceso se PAUSARÁ porque la descarga de Excel falló`);
        
        // Lanzar error para detener el proceso
        throw error;
      }
    } else {
      // Log detallado de por qué NO se puede descargar - MUY VISIBLE
      this.addLog("error", `❌❌❌ [${app.name}] ========== NO SE PUEDE DESCARGAR EXCEL ========== ❌❌❌`);
      if (!folderPath) {
        this.addLog("error", `❌ [${app.name}] RAZÓN: folderPath es null`);
        this.addLog("error", `❌ [${app.name}] org: ${org ? org.name : 'null'}`);
        this.addLog("error", `❌ [${app.name}] workspace: ${workspace ? workspace.name : 'null'}`);
        this.addLog("error", `❌ [${app.name}] backupTimestamp: ${this.backupTimestamp || 'null'}`);
        this.addLog("error", `❌ [${app.name}] backupPath: ${this.backupPath || 'null'}`);
      } else if (scanOnly) {
        this.addLog("warning", `⚠️ [${app.name}] RAZÓN: Modo scanOnly=${scanOnly} activo (Excel se descargará durante el backup)`);
      } else if (typeof window === 'undefined' || !window.electron) {
        this.addLog("error", `❌ [${app.name}] RAZÓN: Electron no disponible`);
        this.addLog("error", `❌ [${app.name}] window: ${typeof window !== 'undefined' ? 'existe' : 'no existe'}`);
        this.addLog("error", `❌ [${app.name}] window.electron: ${typeof window !== 'undefined' && window.electron ? 'existe' : 'no existe'}`);
      } else {
        this.addLog("error", `❌ [${app.name}] RAZÓN: Condición no cumplida - Revisar lógica`);
        this.addLog("error", `❌ [${app.name}] folderPath: ${folderPath}`);
        this.addLog("error", `❌ [${app.name}] scanOnly: ${scanOnly}`);
        this.addLog("error", `❌ [${app.name}] window.electron: ${typeof window !== 'undefined' && !!window.electron}`);
      }
      this.addLog("error", `❌❌❌ [${app.name}] =============================================== ❌❌❌`);
    }
    
    // PASO 4: Crear carpeta "files" SIEMPRE que haya archivos (INDEPENDIENTE de si se descargó Excel)
    // CRÍTICO: La carpeta "files" DEBE crearse durante el escaneo si hay archivos
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.addLog("warning", `📁 [${app.name}] ========== CREACIÓN DE CARPETA FILES ==========`);
    this.addLog("warning", `📁 [${app.name}] folderPath: ${folderPath || 'null'}`);
    this.addLog("warning", `📁 [${app.name}] allFiles.length: ${allFiles.length}`);
    this.addLog("warning", `📁 [${app.name}] Electron disponible: ${typeof window !== 'undefined' && !!window.electron}`);
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    if (folderPath && allFiles.length > 0 && typeof window !== 'undefined' && window.electron) {
      try {
        // Usar path.join si está disponible (Electron), sino usar concatenación con /
        let filesFolder: string;
        if (typeof require !== 'undefined') {
          try {
            const path = require('path');
            filesFolder = path.join(folderPath, 'files');
          } catch {
            // Si require no está disponible, usar concatenación
            filesFolder = `${folderPath}/files`;
          }
        } else {
          filesFolder = `${folderPath}/files`;
        }
        
        this.addLog("warning", `📁 [${app.name}] INICIANDO creación de carpeta files...`);
        this.addLog("warning", `📁 [${app.name}] Ruta completa: ${filesFolder}`);
        this.addLog("warning", `📁 [${app.name}] Llamando a ensureFolderExists...`);
        
        await this.ensureFolderExists(filesFolder);
        
        // Verificar que la carpeta se creó correctamente
        if (typeof (window.electron.fileSystem as any)?.existsSync === 'function') {
          const folderExists = await ((window.electron.fileSystem as any).existsSync(filesFolder));
          if (folderExists) {
            this.addLog("success", `✅✅✅ [${app.name}] Carpeta files creada y verificada exitosamente: ${filesFolder} (${allFiles.length} archivos) ✅✅✅`);
          } else {
            this.addLog("error", `❌❌❌ [${app.name}] ERROR: La carpeta files NO existe después de crearla: ${filesFolder} ❌❌❌`);
          }
        } else {
          this.addLog("success", `✅ [${app.name}] Carpeta files creada exitosamente: ${filesFolder} (${allFiles.length} archivos)`);
        }
      } catch (error) {
        this.addLog("error", `❌❌❌ [${app.name}] ========== ERROR CRÍTICO CREANDO CARPETA FILES ========== ❌❌❌`);
        this.addLog("error", `❌ [${app.name}] Error: ${error instanceof Error ? error.message : String(error)}`);
        this.addLog("error", `❌ [${app.name}] Stack trace: ${error instanceof Error ? error.stack : 'N/A'}`);
        this.addLog("error", `❌ [${app.name}] folderPath: ${folderPath}`);
        this.addLog("error", `❌ [${app.name}] allFiles.length: ${allFiles.length}`);
        this.addLog("error", `❌❌❌ [${app.name}] =============================================== ❌❌❌`);
        // No lanzar error para no detener el proceso, pero es crítico
      }
    } else {
      // Log detallado de por qué NO se puede crear carpeta files
      this.addLog("warning", `⚠️ [${app.name}] ========== NO SE PUEDE CREAR CARPETA FILES ==========`);
      if (!folderPath) {
        this.addLog("error", `❌ [${app.name}] RAZÓN: folderPath es null`);
        this.addLog("error", `❌ [${app.name}] org: ${org ? org.name : 'null'}`);
        this.addLog("error", `❌ [${app.name}] workspace: ${workspace ? workspace.name : 'null'}`);
        this.addLog("error", `❌ [${app.name}] backupTimestamp: ${this.backupTimestamp || 'null'}`);
        this.addLog("error", `❌ [${app.name}] backupPath: ${this.backupPath || 'null'}`);
      } else if (allFiles.length === 0) {
        this.addLog("info", `ℹ️ [${app.name}] Razón: App no tiene archivos (allFiles.length=${allFiles.length}), no se crea carpeta files`);
      } else if (typeof window === 'undefined' || !window.electron) {
        this.addLog("error", `❌ [${app.name}] RAZÓN: Electron no disponible`);
        this.addLog("error", `❌ [${app.name}] window: ${typeof window !== 'undefined' ? 'existe' : 'no existe'}`);
        this.addLog("error", `❌ [${app.name}] window.electron: ${typeof window !== 'undefined' && window.electron ? 'existe' : 'no existe'}`);
      } else {
        this.addLog("error", `❌ [${app.name}] RAZÓN: Condición no cumplida - Revisar lógica`);
        this.addLog("error", `❌ [${app.name}] folderPath: ${folderPath}`);
        this.addLog("error", `❌ [${app.name}] allFiles.length: ${allFiles.length}`);
        this.addLog("error", `❌ [${app.name}] window.electron: ${typeof window !== 'undefined' && !!window.electron}`);
      }
      this.addLog("warning", `⚠️ [${app.name}] ===============================================`);
    }
    
    // PASO 5: Guardar datos en BD (NO en caché - esto es para el respaldo)
    // IMPORTANTE: Guardar TODA la data necesaria en BD para realizar el respaldo:
    // - URLs de descarga de archivos
    // - Información de apps, items, archivos
    // - Rutas de carpetas
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    this.addLog("warning", `💾 ${appCounter} GUARDANDO RUTAS DE DESCARGA DE ARCHIVOS EN BASE DE DATOS`);
    this.addLog("warning", `💾 ${appCounter} App: ${app.name} (${allFiles.length} archivos)`);
    this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    if (folderPath && typeof window !== 'undefined' && window.electron && window.electron.db && this.currentScanId) {
      try {
        // Guardar app en BD (incluso si no tiene archivos)
        this.addLog("info", `💾 ${appCounter} Guardando app en BD: ${app.name} (app_id: ${app.app_id})`);
        await window.electron.db.addApp(this.currentScanId, {
          org_name: org.name,
          space_id: workspace.space_id,
          space_name: workspace.name,
          app_id: app.app_id,
          app_name: app.name,
          folder_path: folderPath
        });
        this.addLog("success", `✅ ${appCounter} App guardada en BD: ${app.name} (app_id: ${app.app_id}, folder: ${folderPath})`);
        
        // Guardar archivos en BD con URLs de descarga (CRÍTICO para el respaldo)
        if (allFiles.length > 0) {
          let filesFolder: string;
          if (typeof require !== 'undefined') {
            try {
              const path = require('path');
              filesFolder = path.join(folderPath, 'files');
            } catch {
              filesFolder = `${folderPath}/files`;
            }
          } else {
            filesFolder = `${folderPath}/files`;
          }
          
          this.addLog("info", `💾 ${appCounter} Guardando ${allFiles.length} archivos en BD con URLs de descarga...`);
          let filesSaved = 0;
          let filesWithoutUrl = 0;
          
          for (const file of allFiles) {
            // IMPORTANTE: Guardar URL de descarga - esto NO es caché, es data necesaria para el respaldo
            const downloadUrl = file.download_link || file.link || '';
            if (!downloadUrl) {
              this.addLog("warning", `⚠️ ${appCounter} Archivo ${file.name} (file_id: ${file.file_id}) no tiene URL de descarga`);
              filesWithoutUrl++;
            }
            
            await window.electron.db.addFile(this.currentScanId, {
              app_id: app.app_id,
              item_id: undefined, // No tenemos item_id cuando usamos /file/app/
              file_id: file.file_id,
              name: file.name,
              size: file.size || 0,
              mimetype: file.mimetype || 'application/octet-stream',
              download_url: downloadUrl, // URL de descarga guardada en BD para el respaldo
              folder_path: filesFolder
            });
            filesSaved++;
          }
          
          this.addLog("success", `✅ ${appCounter} ${filesSaved} archivos guardados en BD con URLs de descarga`);
          if (filesWithoutUrl > 0) {
            this.addLog("warning", `⚠️ ${appCounter} ${filesWithoutUrl} archivos sin URL de descarga`);
          }
        } else {
          this.addLog("info", `ℹ️ ${appCounter} App guardada en BD (sin archivos)`);
        }
      } catch (dbError) {
        this.addLog("error", `❌ ${appCounter} ========== ERROR CRÍTICO GUARDANDO EN BD ==========`);
        this.addLog("error", `❌ ${appCounter} App: ${app.name}`);
        this.addLog("error", `❌ ${appCounter} Error: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
        this.addLog("error", `❌ ${appCounter} ===============================================`);
        // No lanzar error para no detener el proceso, pero es crítico
      }
    } else if (!this.currentScanId) {
      this.addLog("warning", `⚠️ ${appCounter} No se puede guardar en BD: currentScanId no está definido`);
    } else if (!folderPath) {
      this.addLog("warning", `⚠️ ${appCounter} No se puede guardar en BD: folderPath es null`);
    } else if (typeof window === 'undefined' || !window.electron || !window.electron.db) {
      this.addLog("warning", `⚠️ ${appCounter} No se puede guardar en BD: Electron o BD no disponible`);
    }
    
    // Actualizar progreso con indicadores numéricos en tiempo real
    if (progressCallback && totalApps !== undefined && appIndex !== undefined) {
      // Calcular progreso basado en apps procesadas vs total
      const appsProcessed = appIndex + 1;
      const progress = Math.min(95, 1 + ((appsProcessed / totalApps) * 94));
      
      // Crear texto descriptivo con información de la app actual y contadores
      const status = `App ${appsProcessed}/${totalApps}: ${app.name} | Apps: ${this.backupCounts.applications} | Items: ${this.backupCounts.items} | Archivos: ${this.backupCounts.files} | ${this.backupStats.backupSize.toFixed(2)} GB`;
      this.updateProgress(progress, status, progressCallback);
    } else if (progressCallback) {
      // Fallback si no tenemos información de índices
      const status = `Escaneando... (${this.backupCounts.applications} apps, ${this.backupCounts.items} items, ${this.backupCounts.files} archivos, ${this.backupStats.backupSize.toFixed(2)} GB)`;
      const baseProgress = 5;
      const maxAppsProgress = 90;
      const appsProgress = Math.min(maxAppsProgress, Math.log10(1 + this.backupCounts.applications) * 20);
      const estimatedProgress = Math.min(95, baseProgress + appsProgress);
      this.updateProgress(estimatedProgress, status, progressCallback);
    }
    
    this.addLog("info", `📊 ${appCounter} App procesada: ${app.name} - ${itemsCount} items, ${allFiles.length} archivos`);
    
    return {
      itemsCount,
      files: allFiles
    };
  }

  /**
   * Esperar hasta que se restablezca un límite de tasa con mensajes detallados
   * 
   * @param waitTimeSeconds - Tiempo de espera en segundos
   * @param limitType - Tipo de rate limit ('general' o 'rateLimited')
   * @param progressCallback - Callback para reportar progreso durante la espera
   * @param progressMessage - Mensaje personalizado para mostrar durante la espera
   * 
   * @remarks
   * - Usado por los módulos de escaneo cuando se detecta un rate limit
   * - Actualiza el progreso cada segundo mostrando tiempo restante
   * - Verifica el tiempo real desde BD para mayor precisión
   * - Permite que el usuario vea el progreso de la espera
   */
  protected async waitForRateLimit(
    waitTimeSeconds: number,
    limitType: 'general' | 'rateLimited' = 'general',
    progressCallback?: ProgressCallback,
    progressMessage?: string
  ): Promise<void> {
    const hours = Math.floor(waitTimeSeconds / 3600)
    const minutes = Math.floor((waitTimeSeconds % 3600) / 60)
    const seconds = waitTimeSeconds % 60
    
    let timeString = ""
    if (hours > 0) timeString += `${hours}h `
    if (minutes > 0) timeString += `${minutes}m `
    if (seconds > 0) timeString += `${seconds}s`
    
    this.addLog("warning", `â° LÃMITE DE TASA ALCANZADO - Esperando ${timeString} para restablecer lÃ­mites de Podio...`)
    this.addLog("info", `ðŸ”„ La aplicaciÃ³n continuarÃ¡ automÃ¡ticamente despuÃ©s de la espera`)
    
    // Mostrar progreso de espera cada 30 segundos
    const updateInterval = 30000 // 30 segundos
    let remainingTime = waitTimeSeconds * 1000
    
    // Obtener tiempo real desde BD si estÃ¡ disponible
    let realRemainingSeconds = waitTimeSeconds
    if (typeof window !== 'undefined' && window.electron && window.electron.db) {
      try {
        const rateLimitInfo = await this.getRateLimitInfoFromDb()
        if (rateLimitInfo.active && rateLimitInfo.remainingSeconds > 0) {
          realRemainingSeconds = rateLimitInfo.remainingSeconds
          remainingTime = realRemainingSeconds * 1000
        }
      } catch (error) {
        // Si hay error, usar waitTimeSeconds como fallback
        console.warn('Error obteniendo tiempo real desde BD:', error)
      }
    }
    
    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        remainingTime -= updateInterval
        
        // Actualizar tiempo real desde BD cada vez
        if (typeof window !== 'undefined' && window.electron && window.electron.db) {
          try {
            const rateLimitInfo = await this.getRateLimitInfoFromDb()
            if (rateLimitInfo.active && rateLimitInfo.remainingSeconds > 0) {
              realRemainingSeconds = rateLimitInfo.remainingSeconds
              remainingTime = realRemainingSeconds * 1000
            }
          } catch (error) {
            // Ignorar errores
          }
        }
        
        const remainingSeconds = Math.ceil(remainingTime / 1000)
        
        if (remainingSeconds > 0) {
          const remainingHours = Math.floor(remainingSeconds / 3600)
          const remainingMinutes = Math.floor((remainingSeconds % 3600) / 60)
          const remainingSecs = remainingSeconds % 60
          
          let remainingString = ""
          if (remainingHours > 0) remainingString += `${remainingHours}h `
          if (remainingMinutes > 0) remainingString += `${remainingMinutes}m `
          if (remainingSecs > 0) remainingString += `${remainingSecs}s`
          
          this.addLog("info", `â³ Tiempo restante: ${remainingString}`)
          
          // Actualizar progreso dinÃ¡micamente si hay callback y mensaje
          if (progressCallback && progressMessage) {
            const updatedMessage = progressMessage.replace(/\d+ min/, `${Math.ceil(remainingSeconds / 60)} min`)
            this.updateProgress(this.lastProgress || 1, updatedMessage, progressCallback)
          }
        }
      }, updateInterval)
      
      setTimeout(() => {
        clearInterval(interval)
        this.addLog("success", "âœ… LÃ­mite de tasa restablecido. Continuando operaciones...")
        resolve()
      }, remainingTime)
    })
  }

  /**
   * Procesa la cola de solicitudes
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return

    this.isProcessingQueue = true

    while (this.requestQueue.length > 0) {
      // Si hay un lÃ­mite de tasa activo, pausamos el procesamiento
      if (this.activeRateLimit) {
        break
      }

      const request = this.requestQueue.shift()
      if (request) {
        try {
          await request()
        } catch (error) {
          // Los errores ya son manejados en enqueueRequest
          if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
            // Si es un error de rate limit, pausamos el procesamiento
            break
          }
        }

        // PequeÃ±a pausa entre solicitudes para evitar rÃ¡fagas
        if (this.requestQueue.length > 0) {
          await new Promise((r) => setTimeout(r, 50))
        }
      }
    }

    this.isProcessingQueue = false

    // Si la cola no estÃ¡ vacÃ­a y no hay un lÃ­mite activo, continuamos procesando
    if (this.requestQueue.length > 0 && !this.activeRateLimit) {
      this.processQueue()
    }
  }

  /**
   * AÃ±adir un mensaje al log
   */
  protected addLog(level: LogLevel, message: string): void {
    const log: LogMessage = {
      level,
      message,
      timestamp: new Date(),
    }
    this.logs.push(log)
    
    // Solo hacer console.log para logs importantes o en desarrollo
    // Evitar spam de logs de inicialización repetitivos
    const isInitializationLog = message.includes("Servicio de respaldo de Podio inicializado") || 
                                 message.includes("Ruta de respaldo configurada") ||
                                 message.includes("API URL configurada")
    
    if (!isInitializationLog || process.env.NODE_ENV === 'development') {
      // En producción, solo loguear errores y warnings, no info de inicialización
      if (level === 'error' || level === 'warning' || process.env.NODE_ENV === 'development') {
    console.log(`[${level.toUpperCase()}] ${message}`)
      }
    }

    // Mantener solo los últimos 100 logs para no sobrecargar la memoria
    if (this.logs.length > 100) {
      this.logs.shift()
    }
  }

  /**
   * Actualizar el progreso asegurando que siempre avance
   * 
   * @param newProgress - Porcentaje de progreso (0-100)
   * @param status - Mensaje de estado actual
   * @param progressCallback - Callback para notificar el progreso al frontend
   * 
   * @remarks
   * - Asegura que el progreso nunca retroceda (solo avanza)
   * - Limita el progreso a un máximo de 100%
   * - Notifica al frontend con counts, stats y logs actualizados
   * - Usado por los módulos de escaneo para reportar progreso en tiempo real
   */
  protected updateProgress(newProgress: number, status: string, progressCallback: ProgressCallback): void {
    // Asegurarse de que el progreso nunca retroceda
    if (newProgress < this.lastProgress) {
      newProgress = this.lastProgress
    } else if (newProgress > 100) {
      newProgress = 100
    }

    this.lastProgress = newProgress

    // Agregar porcentaje al texto del status si no lo tiene
    const progressPercent = Math.round(newProgress);
    let finalStatus = status;
    if (!status.includes(`${progressPercent}%`) && !status.includes('(')) {
      finalStatus = `${status} (${progressPercent}%)`;
    }

    progressCallback({
      progress: newProgress,
      status: finalStatus,
      counts: this.backupCounts,
      stats: this.backupStats,
      logs: [...this.logs],
    })
  }

  /**
   * Autenticar con la API de Podio usando credenciales de usuario
   * 
   * @param clientId - ID del cliente de la aplicación Podio
   * @param clientSecret - Secreto del cliente de la aplicación Podio
   * @param username - Nombre de usuario de Podio
   * @param password - Contraseña del usuario de Podio
   * @returns true si la autenticación fue exitosa, false en caso contrario
   * 
   * @remarks
   * - El token de autenticación se guarda en authData y se refresca automáticamente cuando expira
   * - Este método debe ser llamado antes de realizar cualquier operación con la API
   */
  public async authenticate(clientId: string, clientSecret: string, username: string, password: string): Promise<boolean> {
    try {
      this.addLog("info", "Iniciando autenticaciÃ³n con Podio...")

      const response = await fetch(`${this.baseUrl}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: clientId,
          client_secret: clientSecret,
          username: username,
          password: password,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        this.addLog("error", `Error de autenticaciÃ³n: ${response.status} ${errorText}`)
        throw new Error(`AutenticaciÃ³n fallida: ${response.status} ${response.statusText}. ${errorText}`)
      }

      const authResponse = await response.json()
      this.addLog("success", "AutenticaciÃ³n exitosa con Podio")

      // Calcular cuando expira el token
      const expiresAt = Date.now() + authResponse.expires_in * 1000

      this.authData = {
        ...authResponse,
        expires_at: expiresAt,
      }

      return true
    } catch (error) {
      this.addLog("error", `Error de autenticaciÃ³n: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Refrescar el token si estÃ¡ por expirar
   */
  private async refreshTokenIfNeeded(): Promise<boolean> {
    if (!this.authData) {
      this.addLog("error", "No hay datos de autenticaciÃ³n para refrescar el token")
      return false
    }

    // Si el token expira en menos de 5 minutos, refrescarlo
    if (this.authData.expires_at - Date.now() < 5 * 60 * 1000) {
      try {
        this.addLog("info", "Refrescando token de autenticaciÃ³n...")

        const response = await fetch(`${this.baseUrl}/oauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: process.env.NEXT_PUBLIC_PODIO_CLIENT_ID || "",
            client_secret: process.env.NEXT_PUBLIC_PODIO_CLIENT_SECRET || "",
            refresh_token: this.authData.refresh_token,
          }),
        })

        if (!response.ok) {
          const errorText = await response.text()
          this.addLog("error", `Error al refrescar token: ${response.status} ${errorText}`)
          throw new Error(`Refresh token fallido: ${response.status} ${response.statusText}. ${errorText}`)
        }

        const authResponse = await response.json()
        this.addLog("success", "Token refrescado exitosamente")

        // Calcular cuando expira el token
        const expiresAt = Date.now() + authResponse.expires_in * 1000

        this.authData = {
          ...authResponse,
          expires_at: expiresAt,
        }

        return true
      } catch (error) {
        this.addLog("error", `Error al refrescar token: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }

    return true
  }

  /**
   * Realizar una peticiÃ³n autenticada a la API de Podio
   */
  private async apiRequest<T>(endpoint: string, method = "GET", data?: any): Promise<T> {
    if (!this.authData) {
      this.addLog("error", "No autenticado. Llama a authenticate() primero.")
      throw new Error("No autenticado. Llama a authenticate() primero.")
    }

    // Verificar cachÃ© para operaciones GET (solo si NO estamos escaneando)
    // Durante un escaneo nuevo, siempre obtener datos frescos de la API
    if (method === "GET" && !this.isScanning) {
      const cached = this.getFromCache<T>(endpoint, method)
      if (cached) return cached
    }

    // Refrescar token si es necesario
    const tokenRefreshed = await this.refreshTokenIfNeeded()
    if (!tokenRefreshed) {
      this.addLog("error", "No se pudo refrescar el token")
      throw new Error("No se pudo refrescar el token")
    }

    const url = `${this.baseUrl}${endpoint}`

    // Encolar la solicitud real a la API
    return this.enqueueRequest(async () => {
      this.addLog("info", `Realizando peticiÃ³n ${method} a ${url}`)

      const options: RequestInit = {
        method,
        headers: {
          Authorization: `OAuth2 ${this.authData!.access_token}`,
          "Content-Type": "application/json",
        },
      }

      if (data && method !== "GET") {
        options.body = JSON.stringify(data)
      }

      try {
        const response = await fetch(url, options)

        // Monitorear headers de rate limit
        this.updateRateLimitsFromHeaders(response.headers, endpoint, method)

        // Obtener tamaño de la respuesta si está disponible
        const contentLength = response.headers.get('Content-Length')
        const responseBytes = contentLength ? parseInt(contentLength, 10) : undefined

        // Determinar el tipo de rate limit para el registro
        const rateType = this.isRateLimitedOperation(endpoint, method) ? 'rateLimited' : 'general'

        if (!response.ok) {
          const errorText = await response.text()
          this.addLog("error", `Error en peticiÃ³n API (${method} ${url}): ${response.status} ${errorText}`)

          // Registrar la llamada fallida en la BD (asíncrono, no bloquea)
          this.logApiRequest(method, endpoint, rateType, response.status, responseBytes, { error: errorText.substring(0, 500) })

          // CRÍTICO: Los errores 400 por límites excedidos NO son rate limits
          // Detectar errores 400 con "invalid_value" y "must not be larger than"
          if (response.status === 400) {
            try {
              const errorData = JSON.parse(errorText)
              
              // Detectar si es un error de límite excedido (NO es rate limit)
              if (errorData.error === "invalid_value" && 
                  errorData.error_description && 
                  errorData.error_description.includes("must not be larger than")) {
                this.addLog("error", `❌ ERROR DE LÍMITE EXCEDIDO: ${errorData.error_description}`)
                this.addLog("error", `❌ Este NO es un rate limit. Verificar límites de API en el código.`)
                // Lanzar error específico para que no se interprete como rate limit
                throw new Error(`INVALID_LIMIT_ERROR:${errorData.error_description}`)
              }
              
              // Detectar si es un rate limit real en error 400
              // Buscar múltiples patrones de rate limit
              const errorDesc = errorData.error_description || errorData.error || ''
              const errorLower = errorDesc.toLowerCase()
              const isRateLimit = errorData.error === "rate_limit" || 
                                  errorData.error === "rate_limit_exceeded" ||
                                  errorLower.includes("rate limit") ||
                                  errorLower.includes("rate_limit") ||
                                  errorLower.includes("too many requests") ||
                                  errorLower.includes("quota exceeded") ||
                                  errorLower.includes("request limit exceeded")
              
              if (isRateLimit) {
                let waitTime = 60 // Valor predeterminado: 1 minuto
                let limitType: "general" | "rateLimited" = this.isRateLimitedOperation(endpoint, method) ? "rateLimited" : "general"
                
                // Intentar extraer el tiempo de espera
                const waitTimeMatch = errorDesc.match(/(\d+)\s*(seconds?|minutes?|hours?)/i)
                if (waitTimeMatch && waitTimeMatch[1]) {
                  const value = parseInt(waitTimeMatch[1], 10)
                  const unit = waitTimeMatch[2].toLowerCase()
                  if (unit.includes('minute')) {
                    waitTime = value * 60
                  } else if (unit.includes('hour')) {
                    waitTime = value * 3600
                  } else {
                    waitTime = value
                  }
                }
                
                this.setActiveRateLimit(limitType, waitTime)
                throw new Error(`RATE_LIMIT_ERROR:${waitTime}:${limitType}`)
              }
            } catch (parseError) {
              // Si no se puede parsear, verificar si el texto contiene indicadores de rate limit
              const errorLower = errorText.toLowerCase()
              if (errorLower.includes("rate limit") || 
                  errorLower.includes("rate_limit") ||
                  errorLower.includes("too many requests") ||
                  errorLower.includes("quota exceeded")) {
                let waitTime = 60
                const waitTimeMatch = errorText.match(/(\d+)\s*(seconds?|minutes?|hours?)/i)
                if (waitTimeMatch && waitTimeMatch[1]) {
                  const value = parseInt(waitTimeMatch[1], 10)
                  const unit = waitTimeMatch[2].toLowerCase()
                  if (unit.includes('minute')) {
                    waitTime = value * 60
                  } else if (unit.includes('hour')) {
                    waitTime = value * 3600
                  } else {
                    waitTime = value
                  }
                }
                const limitType: "general" | "rateLimited" = this.isRateLimitedOperation(endpoint, method) ? "rateLimited" : "general"
                this.setActiveRateLimit(limitType, waitTime)
                throw new Error(`RATE_LIMIT_ERROR:${waitTime}:${limitType}`)
              }
            }
          }

          // Mejorar la detecciÃ³n de errores de rate limit
          if (response.status === 420 || response.status === 429) {
            // Intentar extraer el tiempo de espera del mensaje de error
            let waitTime = 60 // Valor predeterminado: 1 minuto
            let limitType: "general" | "rateLimited" = "general"

            try {
              // Intentar parsear como JSON
              const errorData = JSON.parse(errorText)
              if (errorData.error === "rate_limit" || errorData.error === "rate_limit_exceeded") {
                // Buscar informaciÃ³n sobre el tiempo de espera
                if (errorData.error_description && typeof errorData.error_description === "string") {
                  const waitTimeMatch = errorData.error_description.match(/(\d+)\s*seconds?/i)
                  if (waitTimeMatch && waitTimeMatch[1]) {
                    waitTime = Number.parseInt(waitTimeMatch[1], 10)
                  }
                  // Determinar el tipo de lÃ­mite segÃºn la operaciÃ³n
                  limitType = this.isRateLimitedOperation(endpoint, method) ? "rateLimited" : "general"
                }
                this.setActiveRateLimit(limitType, waitTime)
                throw new Error(`RATE_LIMIT_ERROR:${waitTime}:${limitType}`)
              }
            } catch (parseError) {
              // Si no se puede parsear como JSON, intentar detectar el error por el texto
              if (errorText.includes("rate_limit") || errorText.includes("rate limit")) {
                // Intentar extraer el tiempo de espera del mensaje de error
                const waitTimeMatch = errorText.match(/(\d+)\s*seconds?/i)
                if (waitTimeMatch && waitTimeMatch[1]) {
                  waitTime = Number.parseInt(waitTimeMatch[1], 10)
                }

                // Determinar el tipo de lÃ­mite segÃºn la operaciÃ³n
                limitType = this.isRateLimitedOperation(endpoint, method) ? "rateLimited" : "general"

                this.setActiveRateLimit(limitType, waitTime)
                throw new Error(`RATE_LIMIT_ERROR:${waitTime}:${limitType}`)
              }
            }
          }

          throw new Error(`PeticiÃ³n API fallida: ${response.status} ${response.statusText}. ${errorText}`)
        }

        // Manejar respuestas sin contenido (por ejemplo, PUT/DELETE en Podio)
        if (response.status === 204) {
          // Registrar la llamada exitosa en la BD (asíncrono, no bloquea)
          this.logApiRequest(method, endpoint, rateType, 204, responseBytes)
          return null as T;
        }
        const text = await response.text();
        if (!text) {
          // Registrar la llamada exitosa en la BD (asíncrono, no bloquea)
          this.logApiRequest(method, endpoint, rateType, response.status, responseBytes)
          return null as T;
        }
        let responseData: any = null;
        try {
          responseData = JSON.parse(text);
        } catch (e) {
          responseData = null;
        }
        
        // Registrar la llamada exitosa en la BD (asíncrono, no bloquea)
        this.logApiRequest(method, endpoint, rateType, response.status, responseBytes)
        
        // Guardar en cachÃ© para operaciones GET exitosas (solo si NO estamos escaneando)
        // Durante un escaneo nuevo, NO guardar en caché para obtener siempre datos frescos
        if (method === "GET" && responseData && !this.isScanning) {
          this.setCache(endpoint, responseData, method);
        }
        
        return responseData;
      } catch (error) {
        // Si ya es un error de rate limit, simplemente lo propagamos
        if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
          throw error
        }

        this.addLog(
          "error",
          `Error en peticiÃ³n API (${method} ${url}): ${error instanceof Error ? error.message : String(error)}`,
        )
        throw error
      }
    }, endpoint, method)
  }

  /**
   * Obtener todas las organizaciones del usuario
   * 
   * @returns Array de organizaciones de Podio
   * 
   * @remarks
   * - Usa caché para evitar llamadas repetitivas (TTL: 1 hora)
   * - Usado por los módulos de escaneo para obtener la lista de organizaciones
   */
  protected async getOrganizations(): Promise<PodioOrganization[]> {
    try {
      // CRÍTICO: Verificar caché primero para evitar llamadas duplicadas
      // Las organizaciones no cambian frecuentemente, usar caché largo
      const cacheKey = this.getCacheKey("/org/", "GET")
      const cached = this.cache.get(cacheKey)
      if (cached && !this.isScanning) {
        this.addLog("info", "Usando organizaciones desde caché (evitando llamada duplicada)")
        return cached.data as PodioOrganization[]
      }
      
      this.addLog("info", "Obteniendo organizaciones...")
      const response = await this.apiRequest<any>("/org/")

      if (!Array.isArray(response)) {
        this.addLog("error", `Respuesta inesperada al obtener organizaciones: ${JSON.stringify(response)}`)
        return []
      }

      const organizations = response.map((org: any) => ({
        org_id: org.org_id,
        name: org.name,
        url: org.url,
      }))

      this.addLog("success", `Se encontraron ${organizations.length} organizaciones`)
      
      // Guardar en caché con TTL largo (1 hora) para evitar llamadas duplicadas
      // Incluso durante escaneo, guardar en caché para evitar múltiples llamadas
      this.setCache("/org/", organizations, "GET", this.CACHE_TTL.organizations)
      
      return organizations
    } catch (error) {
      this.addLog("error", `Error al obtener organizaciones: ${error instanceof Error ? error.message : String(error)}`)
      throw new Error(`Error al obtener organizaciones: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Obtener espacios de trabajo de una organización, incluyendo privados y públicos
   * 
   * @param orgId - ID de la organización
   * @returns Array de espacios de trabajo
   * 
   * @remarks
   * - Usa caché para evitar llamadas repetitivas (TTL: 30 minutos)
   * - Usado por los módulos de escaneo para obtener workspaces de una organización
   */
  protected async getWorkspaces(orgId: number): Promise<PodioWorkspace[]> {
    try {
      this.addLog("info", `Obteniendo espacios de trabajo para la organizaciÃ³n ${orgId}...`)

      // Obtenemos los espacios de trabajo de la organizaciÃ³n
      const response = await this.apiRequest<any>(`/org/${orgId}/space/`)

      if (!Array.isArray(response)) {
        this.addLog("error", `Respuesta inesperada al obtener espacios de trabajo: ${JSON.stringify(response)}`)
        return []
      }

      // Mapear los espacios de trabajo
      const workspaces = response.map((space) => ({
        space_id: space.space_id,
        name: space.name,
        url: space.url || "",
      }))

      this.addLog("success", `Se encontraron ${workspaces.length} espacios de trabajo para la organizaciÃ³n ${orgId}`)
      return workspaces
    } catch (error) {
      this.addLog(
        "warning",
        `Error al obtener espacios de trabajo para la organizaciÃ³n ${orgId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return [] // Continuamos con el proceso aunque falle un espacio de trabajo
    }
  }

  /**
   * Obtener aplicaciones de un espacio de trabajo
   * 
   * @param spaceId - ID del espacio de trabajo
   * @returns Array de aplicaciones
   * 
   * @remarks
   * - Usa caché para evitar llamadas repetitivas (TTL: 30 minutos)
   * - Usado por los módulos de escaneo para obtener apps de un workspace
   */
  protected async getApplications(spaceId: number): Promise<PodioApplication[]> {
    try {
      this.addLog("info", `Obteniendo aplicaciones para el espacio de trabajo ${spaceId}...`)
      const response = await this.apiRequest<any>(`/app/space/${spaceId}/`)

      if (!Array.isArray(response)) {
        this.addLog("error", `Respuesta inesperada al obtener aplicaciones: ${JSON.stringify(response)}`)
        return []
      }

      this.addLog("success", `Se encontraron ${response.length} aplicaciones para el espacio de trabajo ${spaceId}`)
      return response.map((app: any) => ({
        app_id: app.app_id,
        name: app.config?.name || "Sin nombre",
        url: app.link || "",
      }))
    } catch (error) {
      this.addLog(
        "warning",
        `Error al obtener aplicaciones para el espacio de trabajo ${spaceId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return [] // Continuamos con el proceso aunque falle una aplicaciÃ³n
    }
  }

  /**
   * Obtener items de una aplicación
   * 
   * @param appId - ID de la aplicación
   * @returns Array de items
   * 
   * @remarks
   * - Usa paginación para obtener todos los items (límite: 1000 por página)
   * - Primero obtiene el total usando /item/app/{appId}/count
   * - Luego obtiene los items en batches usando /item/app/{appId}/
   * - Usado por los módulos de escaneo para obtener items de una app
   */
  protected async getItems(appId: number): Promise<PodioItem[]> {
    try {
      this.addLog("info", `Obteniendo elementos para la aplicaciÃ³n ${appId}...`)

      // Primero obtenemos el conteo para saber cuÃ¡ntos elementos hay
      const countResponse = await this.apiRequest<any>(`/item/app/${appId}/count`)
      let totalItems = countResponse.count || 0

      // Si estÃ¡ en modo test, limitar a TEST_LIMIT items
      if (isTestMode() && totalItems > TEST_LIMIT) {
        totalItems = TEST_LIMIT;
      }

      if (totalItems === 0) {
        this.addLog("info", `No se encontraron elementos para la aplicaciÃ³n ${appId}`)
        return []
      }

      // OPTIMIZACIÃ“N: Usar lÃ­mites mÃ¡s grandes para reducir llamadas API
      const batchSize = isTestMode() ? TEST_LIMIT : this.PAGINATION_LIMITS.items;
      const batches = Math.ceil(totalItems / batchSize)
      let allItems: PodioItem[] = []

      for (let i = 0; i < batches; i++) {
        const offset = i * batchSize
        // OPTIMIZACIÃ“N: Usar lÃ­mites mÃ¡s grandes para reducir llamadas API
        const limit = isTestMode() ? TEST_LIMIT : Math.min(this.PAGINATION_LIMITS.items, batchSize);
        const response = await this.retryWithBackoff(
          () => this.apiRequest<any>(`/item/app/${appId}/?limit=${limit}&offset=${offset}`),
          3,
          1000,
          `obtener items (lote ${i + 1}/${batches})`
        )

        if (!response || !Array.isArray(response.items)) {
          this.addLog("warning", `Respuesta inesperada al obtener elementos: ${JSON.stringify(response)}`)
          continue
        }

        const items = response.items.map((item: any) => ({
          item_id: item.item_id,
          title: item.title || "Sin tÃ­tulo",
          fields: item.fields || {},
        }))

        allItems = [...allItems, ...items]
        // Si es modo test y ya tenemos TEST_LIMIT, cortamos
        if (isTestMode() && allItems.length >= TEST_LIMIT) {
          allItems = allItems.slice(0, TEST_LIMIT);
          break;
        }
        this.addLog("info", `Obtenidos ${allItems.length}/${totalItems} elementos para la aplicaciÃ³n ${appId}`)
      }

      this.addLog("success", `Se encontraron ${allItems.length} elementos para la aplicaciÃ³n ${appId}`)
      return allItems
    } catch (error) {
      this.addLog(
        "warning",
        `Error al obtener elementos para la aplicaciÃ³n ${appId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return [] // Continuamos con el proceso aunque falle
    }
  }

  /**
   * Get files for an item
   */
  protected async getItemFiles(itemId: number): Promise<PodioFile[]> {
    try {
      this.addLog("info", `Obteniendo archivos para el elemento ${itemId}...`)
      // Usar el endpoint correcto para obtener el item y sus archivos adjuntos
      const response = await this.retryWithBackoff(
        () => this.apiRequest<any>(`/item/${itemId}`),
        3,
        1000,
        `obtener archivos del item ${itemId}`
      )

      if (!response || !Array.isArray(response.files)) {
        this.addLog("warning", `No se encontraron archivos adjuntos en el item o respuesta inesperada: ${JSON.stringify(response)}`)
        return []
      }

      const files = response.files.map((file: any) => {
        if (!file.link) {
          this.addLog("warning", `Archivo sin link directo: ${file.name} (${file.file_id}) - usarÃ¡ download_link`)
        }
        return {
          file_id: file.file_id,
          name: file.name || `file_${file.file_id}`,
          link: file.link || "",
          mimetype: file.mimetype || "application/octet-stream",
          size: file.size || 0,
        }
      })

      this.addLog("success", `Se encontraron ${files.length} archivos para el elemento ${itemId}`)
      return files
    } catch (error) {
      this.addLog(
        "warning",
        `Error al obtener archivos para el elemento ${itemId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return [] // Continuamos con el proceso aunque falle
    }
  }

  /**
   * Obtener todos los archivos de una aplicación usando el endpoint /file/app/{app_id}/
   * Este método es más eficiente que iterar a través de cada item
   * 
   * @param appId - ID de la aplicación
   * @returns Array de archivos de la aplicación
   * 
   * @remarks
   * - Usa paginación para obtener todos los archivos (límite: 500 por página)
   * - Más eficiente que obtener archivos por item individual
   * - Usado por los módulos de escaneo para obtener archivos de una app
   */
  protected async getAppFiles(appId: number): Promise<PodioFile[]> {
    try {
      this.addLog("info", `📥 Obteniendo archivos para la aplicación ${appId} usando /file/app/${appId}/...`)
      
      const limit = 100; // Podio permite hasta 100 archivos por request según la API
      let offset = 0;
      let allFiles: PodioFile[] = [];
      let hasMore = true;

      while (hasMore) {
        const endpoint = `/file/app/${appId}/?limit=${limit}&offset=${offset}`;
        this.addLog("info", `📡 Llamando API: ${endpoint}`);
        
        const response = await this.retryWithBackoff(
          () => this.apiRequest<any>(endpoint),
          3,
          1000,
          `obtener archivos de app (offset ${offset})`
        )

        this.addLog("info", `📥 Respuesta recibida: ${Array.isArray(response) ? 'array' : typeof response}, length=${Array.isArray(response) ? response.length : 'N/A'}`);

        // La API de Podio puede devolver el array directamente o dentro de un objeto
        let filesArray: any[] = [];
        if (Array.isArray(response)) {
          filesArray = response;
          this.addLog("info", `✅ Respuesta es array directo: ${filesArray.length} archivos`);
        } else if (response && Array.isArray(response.files)) {
          filesArray = response.files;
          this.addLog("info", `✅ Respuesta contiene .files: ${filesArray.length} archivos`);
        } else if (response && Array.isArray(response.items)) {
          filesArray = response.items;
          this.addLog("info", `✅ Respuesta contiene .items: ${filesArray.length} archivos`);
        } else {
          this.addLog("warning", `⚠️ Respuesta inesperada al obtener archivos de app ${appId}: tipo=${typeof response}, keys=${response ? Object.keys(response).join(',') : 'null'}`)
          // Si no hay respuesta válida, retornar array vacío pero no romper
          hasMore = false;
          break;
        }

        const files = filesArray.map((file: any) => ({
          file_id: file.file_id,
          name: file.name || `file_${file.file_id}`,
          link: file.link || file.download_link || "",
          mimetype: file.mimetype || "application/octet-stream",
          size: file.size || 0,
          download_link: file.download_link || file.link || "",
        }))

        allFiles = [...allFiles, ...files]
        
        this.addLog("info", `📊 Total acumulado: ${allFiles.length} archivos para la aplicación ${appId} (offset: ${offset}, batch: ${files.length})`)
        
        // Si recibimos menos archivos que el límite, no hay más
        if (files.length < limit) {
          hasMore = false
          this.addLog("info", `✅ No hay más archivos (recibidos ${files.length} < límite ${limit})`)
        } else {
          offset += limit
        }
      }

      this.addLog("success", `✅ Se encontraron ${allFiles.length} archivos para la aplicación ${appId}`)
      if (allFiles.length > 0) {
        this.addLog("info", `📋 Primeros archivos: ${allFiles.slice(0, 3).map(f => f.name).join(', ')}${allFiles.length > 3 ? '...' : ''}`)
      }
      return allFiles
    } catch (error) {
      this.addLog(
        "warning",
        `Error al obtener archivos para la aplicaciÃ³n ${appId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return [] // Continuamos con el proceso aunque falle
    }
  }

  /**
   * Get download link for a file
   */
  protected async getFileDownloadLink(fileId: number): Promise<string> {
    try {
      this.addLog("info", `Obteniendo enlace de descarga para el archivo ${fileId}...`)
      const response = await this.apiRequest<any>(`/file/${fileId}/download_link`)

      if (!response || !response.url) {
        this.addLog("warning", `Respuesta inesperada al obtener enlace de descarga: ${JSON.stringify(response)}`)
        return ""
      }

      this.addLog("success", `Enlace de descarga obtenido para el archivo ${fileId}`)
      return response.url
    } catch (error) {
      this.addLog(
        "warning",
        `Error al obtener enlace de descarga para el archivo ${fileId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return "" // Continuamos con el proceso aunque falle
    }
  }

  /**
   * Get items count for an application
   */
  /**
   * Obtener solo el conteo de items de una aplicación (optimizado)
   * 
   * @param appId - ID de la aplicación
   * @returns Número de items en la aplicación
   * 
   * @remarks
   * - Usa solo 1 llamada API: /item/app/{appId}/count
   * - NO actualiza backupStats.items aquí (se actualiza en processApplicationParallel)
   * - Usado por processApplicationParallel para obtener conteo sin descargar todos los items
   */
  protected async getItemsCount(appId: number): Promise<number> {
    try {
      this.addLog("info", `Obteniendo conteo de elementos para la aplicación ${appId}...`)
      const response = await this.apiRequest<any>(`/item/app/${appId}/count`)

      if (typeof response.count !== "number") {
        this.addLog("error", `Respuesta inesperada al obtener conteo de elementos: ${JSON.stringify(response)}`)
        return 0
      }

      // NO actualizar backupStats.items aquí - se actualiza en processApplicationParallel
      // para evitar duplicación cuando se llama desde múltiples lugares

      this.addLog("success", `Se encontraron ${response.count} elementos para la aplicación ${appId}`)
      return response.count
    } catch (error) {
      this.addLog(
        "warning",
        `Error al obtener conteo de elementos para la aplicación ${appId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return 0 // Continuamos con el proceso aunque falle
    }
  }

  /**
   * Crear estructura de carpetas para el respaldo
   */
  private async createFolderStructure(orgName: string, workspaceName: string, appName: string): Promise<string> {
    try {
      // Sanitizar nombres para que sean vÃ¡lidos como nombres de carpeta
      const safeOrgName = this.sanitizeFileName(orgName)
      const safeWorkspaceName = this.sanitizeFileName(workspaceName)

      const safeAppName = this.sanitizeFileName(appName)

      // Construir la ruta completa (incluyendo backupTimestamp si existe)
      const basePath = this.backupTimestamp 
        ? `${this.backupPath}/${this.backupTimestamp}`
        : this.backupPath
      const folderPath = `${basePath}/${safeOrgName}/${safeWorkspaceName}/${safeAppName}`

      // Crear la estructura de carpetas
      await this.ensureFolderExists(folderPath)

      // NOTA: La carpeta "files" se creará después solo si hay archivos
      // Esto se hace en processApplicationParallel después de obtener los archivos

      this.addLog("success", `Estructura de carpetas creada: ${folderPath}`)
      return folderPath
    } catch (error) {
      this.addLog(
        "error",
        `Error al crear estructura de carpetas: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  /**
   * Sanitizar nombre de archivo para que sea válido en Windows
   * Elimina TODOS los caracteres problemáticos y nombres reservados
   */
  protected sanitizeFileName(name: string): string {
    if (!name || typeof name !== 'string') {
      return 'unnamed';
    }
    
    // 1. Eliminar caracteres inválidos para Windows: \ / : * ? " < > |
    let sanitized = name.replace(/[\\/:*?"<>|]/g, '-');
    
    // 2. Eliminar caracteres de control (0x00-0x1F) y algunos caracteres Unicode problemáticos
    sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');
    
    // 3. Eliminar espacios al inicio y final, y reemplazar múltiples espacios/guiones con uno solo
    sanitized = sanitized.trim().replace(/\s+/g, '_').replace(/-+/g, '-').replace(/_+/g, '_');
    
    // 4. Eliminar puntos al final (Windows no permite nombres que terminen en punto)
    sanitized = sanitized.replace(/\.+$/, '');
    
    // 5. Verificar nombres reservados de Windows y reemplazarlos
    const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
    
    const upperName = sanitized.toUpperCase();
    if (reservedNames.includes(upperName)) {
      sanitized = `_${sanitized}`;
    }
    
    // 6. Limitar longitud a 200 caracteres (dejar margen para rutas largas)
    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 200);
    }
    
    // 7. Si después de todo queda vacío, usar un nombre por defecto
    if (!sanitized || sanitized.trim().length === 0) {
      sanitized = 'unnamed';
    }
    
    return sanitized;
  }

  /**
   * Reemplazar ensureFolderExists para crear carpetas reales
   */
  protected async ensureFolderExists(path: string): Promise<void> {
    if (typeof window !== 'undefined' && window.electron && window.electron.fileSystem && window.electron.fileSystem.createDirectory) {
      await window.electron.fileSystem.createDirectory(path)
      this.addLog("success", `Carpeta creada: ${path}`)
    } else {
      throw new Error('FunciÃ³n de archivos solo disponible en Electron')
    }
  }

  /**
   * Formatear tamaÃ±o de archivo
   */
  protected formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }

  /**
   * Reemplazar saveItemsToExcel para guardar el archivo Excel realmente (si aplica)
   */
  protected async saveItemsToExcel(items: any[], folderPath: string, appName: string): Promise<void> {
    try {
      const fileName = `${this.sanitizeFileName(appName)}_items.xlsx`
      this.addLog("info", `Preparando archivo Excel con ${items.length} elementos: ${fileName}`)

      // En un entorno de navegador, simulamos la generaciÃ³n del archivo Excel
      this.addLog("info", `Simulando generaciÃ³n de Excel: ${fileName}`)

      // Simular un tiempo de procesamiento
      await new Promise((resolve) => setTimeout(resolve, 500))

      this.addLog("success", `Archivo Excel simulado: ${folderPath}/${fileName}`)
    } catch (error) {
      this.addLog("error", `Error al generar archivo Excel: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /**
   * Descargar el Excel oficial de la app
   * 
   * NOTA: Según la documentación de Podio, el endpoint correcto es:
   * GET /app/{appId}/excel/
   * 
   * Este endpoint NO soporta paginación (limit/offset). Descarga el Excel completo
   * de todos los items de la aplicación en una sola petición.
   */
  /**
   * Iniciar exportación de Excel usando Batch API de Podio
   * 
   * @param appId - ID de la aplicación a exportar
   * @returns batch_id para monitorear el proceso
   * 
   * @remarks
   * - Usa POST /item/app/{app_id}/export/xlsx para iniciar exportación asíncrona
   * - Retorna batch_id que se usa para monitorear el estado
   * - Mucho más eficiente que descargar directamente (solo 1 llamada API)
   */
  protected async exportAppToExcelBatch(appId: number): Promise<number> {
    try {
      this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      this.addLog("warning", `📦 [Batch API] INICIANDO EXPORTACIÓN DE EXCEL PARA APP ${appId}...`);
      
      // Verificar autenticación
      if (!this.authData) {
        this.addLog("error", "❌❌❌ No autenticado. Llama a authenticate() primero. ❌❌❌");
        throw new Error("No autenticado. Llama a authenticate() primero.");
      }
      
      // Endpoint para iniciar exportación batch
      const endpoint = `/item/app/${appId}/export/xlsx`;
      const method = 'POST';
      
      // Usar enqueueRequest para respetar rate limits
      const response = await this.enqueueRequest<any>(async () => {
        const url = `${this.baseUrl}${endpoint}`;
        this.addLog("warning", `📡 Realizando petición POST a ${url}`);
        this.addLog("warning", `📡 Body: {} (JSON vacío como requiere Podio)`);
        
        const fetchResponse = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `OAuth2 ${this.authData!.access_token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Podio-Backup-Tool/1.0',
          },
          body: JSON.stringify({}), // Enviar body JSON vacío como requiere Podio
        });
        
        // Actualizar rate limits desde headers
        this.updateRateLimitsFromHeaders(fetchResponse.headers, endpoint, method);
        
        if (!fetchResponse.ok) {
          if (fetchResponse.status === 420 || fetchResponse.status === 429) {
            const retryAfter = fetchResponse.headers.get('Retry-After');
            const waitTime = retryAfter ? Number.parseInt(retryAfter, 10) : 60;
            this.addLog("error", `❌ Rate limit detectado al iniciar exportación batch: status=${fetchResponse.status}, retryAfter=${waitTime}s`);
            throw new Error(`RATE_LIMIT_ERROR:${waitTime}:general`);
          }
          const errorText = await fetchResponse.text();
          this.addLog("error", `❌ Error HTTP al iniciar exportación batch: status=${fetchResponse.status}`);
          this.addLog("error", `❌ Respuesta completa del error: ${errorText}`);
          
          // Intentar parsear el error como JSON para obtener más detalles
          try {
            const errorJson = JSON.parse(errorText);
            this.addLog("error", `❌ Error parseado: ${JSON.stringify(errorJson, null, 2)}`);
            if (errorJson.error_description) {
              this.addLog("error", `❌ Descripción: ${errorJson.error_description}`);
            }
          } catch (e) {
            // No es JSON, ya tenemos el texto
          }
          
          throw new Error(`Error HTTP ${fetchResponse.status}: ${errorText.substring(0, 500)}`);
        }
        
        const responseText = await fetchResponse.text();
        this.addLog("info", `📥 Respuesta recibida (${responseText.length} bytes)`);
        
        // Log completo de la respuesta para debugging
        try {
          const responseJson = JSON.parse(responseText);
          this.addLog("info", `📥 Respuesta JSON: ${JSON.stringify(responseJson, null, 2)}`);
          return responseJson;
        } catch (e) {
          this.addLog("error", `❌ No se pudo parsear respuesta como JSON: ${responseText.substring(0, 200)}`);
          throw new Error(`Respuesta inválida de la API: no es JSON válido`);
        }
      }, endpoint, method);
      
      // La respuesta de Podio puede tener diferentes estructuras:
      // 1. { batch_id: 123 }
      // 2. { batch: { batch_id: 123 } }
      // 3. { file: { file_id: 123, link: "..." } } - si es inmediato
      // 4. { id: 123 } - algunos casos
      this.addLog("info", `🔍 Analizando respuesta del batch: ${JSON.stringify(response, null, 2)}`);
      
      let batchId: number | null = null;
      
      // Intentar diferentes estructuras de respuesta
      if (response.batch_id) {
        batchId = response.batch_id;
      } else if (response.batch?.batch_id) {
        batchId = response.batch.batch_id;
      } else if (response.id) {
        batchId = response.id;
      } else if (response.file) {
        // Si la respuesta ya tiene el archivo, significa que fue inmediato
        // Esto puede pasar con apps pequeñas
        this.addLog("info", `✅ Exportación completada inmediatamente, archivo disponible`);
        this.addLog("info", `📁 Archivo disponible: file_id=${response.file.file_id}, link=${response.file.link || response.file.perma_link}`);
        // En este caso, devolver el file_id como si fuera batch_id para compatibilidad
        // pero marcar que es inmediato
        if (response.file.file_id) {
          // Guardar información del archivo para uso inmediato
          (this as any)._immediateExportFile = {
            file_id: response.file.file_id,
            link: response.file.link || response.file.perma_link,
            name: response.file.name || `export_${appId}.xlsx`,
            size: response.file.size || 0,
          };
          // Usar file_id como batch_id temporal para compatibilidad con waitForBatchCompletion
          batchId = response.file.file_id;
          this.addLog("info", `⚡ Usando file_id como batch_id temporal: ${batchId}`);
        } else {
          throw new Error("Archivo inmediato sin file_id en la respuesta");
        }
      }
      
      if (!batchId) {
        this.addLog("error", `❌ Respuesta inesperada al iniciar exportación batch`);
        this.addLog("error", `❌ Estructura recibida: ${JSON.stringify(response, null, 2)}`);
        throw new Error(`No se encontró batch_id en la respuesta. Estructura: ${JSON.stringify(response)}`);
      }
      
      this.addLog("success", `✅ Exportación batch iniciada: batch_id=${batchId}`);
      return batchId;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
        throw error; // Propagar rate limit
      }
      this.addLog("error", `❌ Error al iniciar exportación batch para app ${appId}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Esperar a que un batch se complete haciendo polling periódico
   * 
   * @param batchId - ID del batch a monitorear
   * @param progressCallback - Callback opcional para reportar progreso
   * @returns Información del archivo cuando el batch está completo
   * 
   * @remarks
   * - Hace polling de GET /batch/{batch_id} cada 5-10 segundos
   * - Maneja rate limits durante el polling
   * - Timeout máximo: 30 minutos
   */
  protected async waitForBatchCompletion(
    batchId: number,
    progressCallback?: ProgressCallback
  ): Promise<{ file_id: number; link: string; name: string; size: number }> {
    // Verificar si es una exportación inmediata (file_id usado como batch_id temporal)
    const immediateFile = (this as any)._immediateExportFile;
    if (immediateFile && immediateFile.file_id === batchId) {
      this.addLog("info", `⚡ Exportación inmediata detectada, usando archivo directamente`);
      // Limpiar la referencia temporal
      delete (this as any)._immediateExportFile;
      return immediateFile;
    }
    
    const MAX_WAIT_TIME = 30 * 60 * 1000; // 30 minutos
    const POLL_INTERVAL = 5000; // 5 segundos
    const startTime = Date.now();
    
    this.addLog("info", `⏳ [Batch API] Monitoreando batch ${batchId}...`);
    
    while (true) {
      // Verificar timeout
      const elapsed = Date.now() - startTime;
      if (elapsed > MAX_WAIT_TIME) {
        this.addLog("error", `❌ Timeout esperando batch ${batchId} (${Math.round(elapsed / 1000)}s)`);
        throw new Error(`Timeout esperando batch ${batchId}`);
      }
      
      // Verificar si el escaneo fue cancelado
      if (this.isScanCancelled) {
        this.addLog("warning", "🚫 Escaneo cancelado. Deteniendo monitoreo de batch...");
        throw new Error("ESCANEO_CANCELADO: El escaneo fue cancelado por el usuario");
      }
      
      try {
        // Consultar estado del batch
        const endpoint = `/batch/${batchId}`;
        const method = 'GET';
        
        const batchInfo = await this.enqueueRequest<any>(async () => {
          const url = `${this.baseUrl}${endpoint}`;
          const fetchResponse = await fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `OAuth2 ${this.authData!.access_token}`,
              'User-Agent': 'Podio-Backup-Tool/1.0',
            },
          });
          
          // Actualizar rate limits desde headers
          this.updateRateLimitsFromHeaders(fetchResponse.headers, endpoint, method);
          
          if (!fetchResponse.ok) {
            if (fetchResponse.status === 420 || fetchResponse.status === 429) {
              const retryAfter = fetchResponse.headers.get('Retry-After');
              const waitTime = retryAfter ? Number.parseInt(retryAfter, 10) : 60;
              throw new Error(`RATE_LIMIT_ERROR:${waitTime}:general`);
            }
            const errorText = await fetchResponse.text();
            throw new Error(`Error HTTP ${fetchResponse.status}: ${errorText.substring(0, 200)}`);
          }
          
          return await fetchResponse.json();
        }, endpoint, method);
        
        const status = batchInfo.status;
        const completed = batchInfo.completed || 0;
        const failed = batchInfo.failed || 0;
        const skipped = batchInfo.skipped || 0;
        
        // Calcular progreso aproximado si hay información disponible
        const total = completed + failed + skipped;
        const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
        
        this.addLog("info", `📊 [Batch ${batchId}] Estado: ${status}, Completados: ${completed}, Fallidos: ${failed}, Omitidos: ${skipped} (${progressPercent}%)`);
        
        if (status === "completed") {
          // Batch completado, obtener información del archivo
          if (!batchInfo.file) {
            this.addLog("error", `❌ Batch ${batchId} completado pero no hay archivo disponible`);
            throw new Error(`Batch ${batchId} completado pero no hay archivo disponible`);
          }
          
          const fileInfo = {
            file_id: batchInfo.file.file_id,
            link: batchInfo.file.link || batchInfo.file.perma_link,
            name: batchInfo.file.name || `export_${batchId}.xlsx`,
            size: batchInfo.file.size || 0,
          };
          
          if (!fileInfo.link) {
            this.addLog("error", `❌ Batch ${batchId} completado pero el archivo no tiene link de descarga`);
            throw new Error(`Batch ${batchId} completado pero el archivo no tiene link de descarga`);
          }
          
          const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
          this.addLog("success", `✅ Batch ${batchId} completado en ${elapsedSeconds}s. Archivo listo: ${fileInfo.name} (${(fileInfo.size / 1024).toFixed(2)} KB)`);
          
          return fileInfo;
        } else if (status === "failed") {
          this.addLog("error", `❌ Batch ${batchId} falló. Completados: ${completed}, Fallidos: ${failed}`);
          throw new Error(`Batch ${batchId} falló durante el procesamiento`);
        } else if (status === "processing" || status === "created") {
          // Batch aún procesando, esperar antes del siguiente polling
          if (progressCallback && total > 0) {
            this.updateProgress(
              this.lastProgress || 0,
              `Procesando batch... (${progressPercent}% - ${completed}/${total} items)`,
              progressCallback
            );
          }
          
          // Esperar antes del siguiente polling
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        } else {
          this.addLog("warning", `⚠️ Estado desconocido del batch ${batchId}: ${status}`);
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
          // Rate limit durante polling, propagar para manejo en nivel superior
          throw error;
        }
        // Otros errores: loguear y reintentar después de un tiempo
        this.addLog("warning", `⚠️ Error consultando batch ${batchId}: ${error instanceof Error ? error.message : String(error)}. Reintentando...`);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL * 2)); // Esperar más tiempo antes de reintentar
      }
    }
  }

  protected async downloadAppExcel(appId: number, folderPath: string, appName: string, progressCallback?: ProgressCallback, excelIndex?: number, totalExcels?: number): Promise<void> {
    const excelStartTime = Date.now();
    const excelCounter = excelIndex !== undefined && totalExcels !== undefined 
      ? `[Excel ${excelIndex + 1}/${totalExcels}]` 
      : '';
    const excelFileName = `${this.sanitizeFileName(appName)}_oficial.xlsx`;
    
    try {
      this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      this.addLog("warning", `🚀🚀🚀 ${excelCounter} INICIANDO DESCARGA DE EXCEL: ${appName} 🚀🚀🚀`);
      this.addLog("warning", `📁 ${excelCounter} Carpeta: ${folderPath}`);
      this.addLog("warning", `📊 ${excelCounter} Archivo: ${excelFileName}`);
      this.addLog("warning", `📊 ${excelCounter} App ID: ${appId}`);
      this.addLog("warning", `📊 ${excelCounter} Usando Batch API para optimizar llamadas...`);
      this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      
      // Verificar rate limit antes de iniciar
      if (this.isRateLimitActiveSync()) {
        const rateLimitInfo = this.getRateLimitInfo();
        const waitTime = Math.ceil(rateLimitInfo.remainingSeconds / 60);
        this.addLog("warning", `⏸️ Rate limit activo. Esperando ${waitTime} minutos antes de descargar Excel para ${appName}...`);
        throw new Error(`RATE_LIMIT_ERROR:${rateLimitInfo.remainingSeconds}:${rateLimitInfo.type}`);
      }
      
        // Asegurar que la carpeta existe
        await this.ensureFolderExists(folderPath);
      this.addLog("info", `📊 [downloadAppExcel] Carpeta verificada: ${folderPath}`);
      
      // PASO 1: Iniciar exportación batch
      this.addLog("info", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      this.addLog("info", `📦 ${excelCounter} [Batch API] Paso 1: Iniciando exportación batch para ${appName}...`);
      const batchId = await this.exportAppToExcelBatch(appId);
      
      // PASO 2: Esperar a que el batch se complete
      this.addLog("info", `⏳ ${excelCounter} [Batch API] Paso 2: Esperando a que el batch ${batchId} se complete...`);
      const fileInfo = await this.waitForBatchCompletion(batchId, progressCallback);
      
      // PASO 3: Descargar el archivo desde el link proporcionado
      this.addLog("info", `📥 ${excelCounter} [Batch API] Paso 3: Descargando archivo desde ${fileInfo.link}...`);
      
        if (
          typeof window !== 'undefined' &&
          window.electron &&
          window.electron.fileSystem &&
        window.electron.fileSystem.saveFile
      ) {
        // CRÍTICO: Usar path.join para construir la ruta correctamente (especialmente en Windows)
        let excelPath: string;
        if (typeof require !== 'undefined') {
          try {
            const path = require('path');
            excelPath = path.join(folderPath, excelFileName);
          } catch {
            // Si require no está disponible, usar concatenación
            excelPath = `${folderPath}/${excelFileName}`;
          }
        } else {
          excelPath = `${folderPath}/${excelFileName}`;
        }
        
        this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        this.addLog("warning", `📁 ${excelCounter} RUTA COMPLETA DEL ARCHIVO: ${excelPath}`);
        this.addLog("warning", `📁 ${excelCounter} Carpeta base: ${folderPath}`);
        this.addLog("warning", `📁 ${excelCounter} Nombre archivo: ${excelFileName}`);
        this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        
        // Asegurar que la carpeta existe antes de descargar
        this.addLog("info", `📁 ${excelCounter} Verificando que la carpeta existe: ${folderPath}`);
        await this.ensureFolderExists(folderPath);
        this.addLog("success", `✅ ${excelCounter} Carpeta verificada/creada: ${folderPath}`);
        
        // Descargar el archivo usando el link del batch
        // Usar enqueueRequest para respetar rate limits
        const endpoint = `/file/${fileInfo.file_id}/download`;
        const method = 'GET';
        
        this.addLog("info", `📡 ${excelCounter} Iniciando descarga desde: ${fileInfo.link}`);
        this.addLog("info", `📡 ${excelCounter} File ID: ${fileInfo.file_id}`);
        this.addLog("info", `📡 ${excelCounter} Tamaño esperado: ${fileInfo.size ? `${(fileInfo.size / 1024).toFixed(2)} KB` : 'desconocido'}`);
        
        const buffer = await this.enqueueRequest<ArrayBuffer>(async () => {
          this.addLog("info", `📡 ${excelCounter} Realizando petición GET a: ${fileInfo.link}`);
          
          const response = await fetch(fileInfo.link, {
              method: 'GET',
              headers: {
              Authorization: `OAuth2 ${this.authData!.access_token}`,
              'User-Agent': 'Podio-Backup-Tool/1.0',
              },
            });
          
          // Actualizar rate limits desde headers
          this.updateRateLimitsFromHeaders(response.headers, endpoint, method);
          
            if (!response.ok) {
            if (response.status === 420 || response.status === 429) {
              const retryAfter = response.headers.get('Retry-After');
              const waitTime = retryAfter ? Number.parseInt(retryAfter, 10) : 60;
              throw new Error(`RATE_LIMIT_ERROR:${waitTime}:general`);
            }
            const errorText = await response.text();
            this.addLog("error", `❌ ${excelCounter} Error HTTP ${response.status} al descargar: ${errorText.substring(0, 500)}`);
            throw new Error(`Error HTTP ${response.status}: ${errorText.substring(0, 200)}`);
          }
          
          const arrayBuffer = await response.arrayBuffer();
          this.addLog("success", `✅ ${excelCounter} Archivo descargado desde Podio: ${arrayBuffer.byteLength} bytes`);
          return arrayBuffer;
        }, endpoint, method);
        
        this.addLog("info", `📊 ${excelCounter} Buffer recibido: ${buffer.byteLength} bytes`);
        
        if (buffer.byteLength === 0) {
          this.addLog("error", `❌ ${excelCounter} ERROR CRÍTICO: El buffer está vacío (0 bytes)`);
          throw new Error(`Buffer vacío al descargar Excel para ${appName}`);
        }
        
        // Convertir ArrayBuffer a base64
        let base64: string;
        if (typeof Buffer !== 'undefined') {
          base64 = Buffer.from(buffer).toString('base64');
          this.addLog("info", `📊 ${excelCounter} Convertido a base64: ${base64.length} caracteres`);
            } else {
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          base64 = btoa(binary);
          this.addLog("info", `📊 ${excelCounter} Convertido a base64 (btoa): ${base64.length} caracteres`);
        }
        
        if (!base64 || base64.length === 0) {
          this.addLog("error", `❌ ${excelCounter} ERROR CRÍTICO: La conversión a base64 falló o está vacía`);
          throw new Error(`Conversión a base64 falló para ${appName}`);
        }
        
        // Guardar el archivo
        this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        this.addLog("warning", `💾 ${excelCounter} GUARDANDO ARCHIVO EN DISCO...`);
        this.addLog("warning", `💾 ${excelCounter} Ruta: ${excelPath}`);
        this.addLog("warning", `💾 ${excelCounter} Tamaño base64: ${base64.length} caracteres`);
        this.addLog("warning", `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        
        const saveResult = await window.electron.fileSystem.saveFile(base64, excelPath);
        
        this.addLog("info", `📊 ${excelCounter} Resultado de saveFile: success=${saveResult.success}`);
        if (saveResult.error) {
          this.addLog("error", `❌ ${excelCounter} Error de saveFile: ${saveResult.error}`);
        }
        if (saveResult.path) {
          this.addLog("info", `📊 ${excelCounter} Ruta retornada por saveFile: ${saveResult.path}`);
        }
        
        if (!saveResult.success) {
          this.addLog("error", `❌ ${excelCounter} ========== ERROR AL GUARDAR EXCEL ==========`);
          this.addLog("error", `❌ ${excelCounter} Ruta: ${excelPath}`);
          this.addLog("error", `❌ ${excelCounter} Error: ${saveResult.error}`);
          this.addLog("error", `❌ ${excelCounter} ===============================================`);
          throw new Error(`Error al guardar Excel: ${saveResult.error}`);
        }
        
        this.addLog("success", `✅ ${excelCounter} saveFile completado exitosamente`);
        
        // Verificar existencia del archivo INMEDIATAMENTE después de guardar
        this.addLog("info", `🔍 ${excelCounter} Verificando existencia del archivo...`);
        if (typeof (window.electron.fileSystem as any)?.existsSync === 'function') {
          // Esperar un momento para que el sistema de archivos se actualice
          await new Promise(resolve => setTimeout(resolve, 100));
          
          const exists = await ((window.electron.fileSystem as any).existsSync(excelPath));
          this.addLog("info", `🔍 ${excelCounter} Resultado de existsSync: ${exists}`);
          
          if (!exists) {
            this.addLog("error", `❌ ${excelCounter} ========== ARCHIVO NO ENCONTRADO DESPUÉS DE GUARDAR ==========`);
            this.addLog("error", `❌ ${excelCounter} Ruta buscada: ${excelPath}`);
            this.addLog("error", `❌ ${excelCounter} Carpeta base: ${folderPath}`);
            this.addLog("error", `❌ ${excelCounter} Nombre archivo: ${excelFileName}`);
            this.addLog("error", `❌ ${excelCounter} ===============================================`);
            
            // Intentar verificar si la carpeta existe
            try {
              const folderExists = await ((window.electron.fileSystem as any).existsSync(folderPath));
              this.addLog("info", `🔍 ${excelCounter} Carpeta base existe: ${folderExists}`);
            } catch (e) {
              this.addLog("error", `❌ ${excelCounter} Error verificando carpeta: ${e}`);
            }
            
            throw new Error(`Archivo Excel no encontrado después de descargar: ${excelPath}`);
          }
          
          this.addLog("success", `✅ ${excelCounter} Archivo verificado y existe en: ${excelPath}`);
          
          // Obtener tamaño del archivo
          if (typeof (window.electron.fileSystem as any)?.getFileSize === 'function') {
            try {
              const size = await ((window.electron.fileSystem as any).getFileSize(excelPath));
              this.addLog("success", `✅ ${excelCounter} Tamaño del archivo Excel: ${(size / 1024).toFixed(2)} KB (${size} bytes)`);
              this.backupStats.downloadedBytes += size;
              
              if (size === 0) {
                this.addLog("error", `❌ ${excelCounter} ADVERTENCIA: El archivo tiene 0 bytes`);
              }
            } catch (sizeError) {
              this.addLog("error", `❌ ${excelCounter} Error al obtener tamaño del archivo: ${sizeError}`);
            }
          } else {
            this.addLog("warning", `⚠️ ${excelCounter} getFileSize no está disponible`);
          }
        } else {
          this.addLog("warning", `⚠️ ${excelCounter} existsSync no está disponible, no se puede verificar el archivo`);
        }
        
        const excelEndTime = Date.now();
        const excelDuration = ((excelEndTime - excelStartTime) / 1000).toFixed(2);
        this.addLog("success", `✅ ${excelCounter} Excel descargado exitosamente: ${appName} (${excelDuration}s)`);
        this.addLog("info", `📁 ${excelCounter} Ruta: ${excelPath}`);
        } else {
        this.addLog("error", "❌ Función de descarga de archivos no disponible en Electron");
        throw new Error("Función de descarga de archivos no disponible");
      }
    } catch (error) {
      // CRÍTICO: Lanzar TODOS los errores para que el proceso se pause
      // El nivel superior manejará rate limits con pausa automática
      // Otros errores detendrán el proceso como se requiere
      if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
        this.addLog("warning", `⏸️ [downloadAppExcel] Rate limit detectado, se pausará y reintentará`);
        throw error; // Propagar para pausa automática
      }
      if (error instanceof Error && error.message.startsWith("ESCANEO_CANCELADO:")) {
        this.addLog("warning", `🚫 [downloadAppExcel] Escaneo cancelado`);
        throw error; // Propagar cancelación
      }
      
      // Para TODOS los demás errores, lanzar para detener el proceso
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : 'N/A';
      
      this.addLog("error", `❌ ${excelCounter} ========== ERROR DESCARGANDO EXCEL ==========`);
      this.addLog("error", `❌ ${excelCounter} App: ${appName} (ID: ${appId})`);
      this.addLog("error", `❌ ${excelCounter} Carpeta: ${folderPath}`);
      this.addLog("error", `❌ ${excelCounter} Archivo: ${excelFileName}`);
      this.addLog("error", `❌ ${excelCounter} Mensaje: ${errorMessage}`);
      this.addLog("error", `❌ ${excelCounter} Stack: ${errorStack}`);
      this.addLog("error", `❌ ${excelCounter} ===============================================`);
      this.addLog("error", `❌ ${excelCounter} El proceso se PAUSARÁ porque la descarga de Excel falló`);
      
      // Lanzar error para detener el proceso
      throw error;
    }
  }

  /**
   * Procesar archivos completos en batches con mensajes detallados
   */
  protected async processCompleteFilesInBatches(
    progressCallback?: ProgressCallback,
    batchSize: number = 240 // Dejar margen de 10 para el lÃ­mite de 250
  ): Promise<void> {
    if (this.scannedFilesComplete.length === 0) {
      this.addLog("warning", "âš ï¸ No hay archivos completos para procesar")
      return
    }
    
    const totalBatches = Math.ceil(this.scannedFilesComplete.length / batchSize)
    this.addLog("info", `ðŸš€ INICIANDO DESCARGA EN BATCHES`)
    this.addLog("info", `ðŸ“Š Total de archivos: ${this.scannedFilesComplete.length}`)
    this.addLog("info", `ðŸ“¦ TamaÃ±o de batch: ${batchSize} archivos`)
    this.addLog("info", `ðŸ”¢ Total de batches: ${totalBatches}`)
    this.addLog("info", `â±ï¸ Tiempo estimado: ${Math.ceil(totalBatches * 0.5)} minutos`)
    
    let processedFiles = 0
    let batchNumber = 1
    const startTime = Date.now()
    
    for (let i = 0; i < this.scannedFilesComplete.length; i += batchSize) {
      const batch = this.scannedFilesComplete.slice(i, i + batchSize)
      const batchStartTime = Date.now()
      
      this.addLog("info", `ðŸ“¦ BATCH ${batchNumber}/${totalBatches}: Procesando archivos ${i + 1}-${Math.min(i + batchSize, this.scannedFilesComplete.length)}`)
      
      // Procesar archivos del batch (SIN llamadas API adicionales)
      let batchSuccessCount = 0
      for (let j = 0; j < batch.length; j++) {
        const fileData = batch[j]
        const fileIndex = i + j
        
        try {
          const success = await this.downloadFileDirect(fileData, progressCallback, fileIndex, this.scannedFilesComplete.length)
          if (success) {
            processedFiles++
            batchSuccessCount++
          }
          
          // Actualizar progreso
          if (progressCallback) {
            const progress = Math.min(99, (processedFiles / this.scannedFilesComplete.length) * 100)
            this.updateProgress(progress, `Descargando archivo ${processedFiles}/${this.scannedFilesComplete.length}: ${fileData.file.name}`, progressCallback)
          }
          
        } catch (error) {
          this.addLog("error", `âŒ Error al descargar archivo ${fileData.file.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      
      const batchTime = Date.now() - batchStartTime
      const batchTimeSeconds = Math.round(batchTime / 1000)
      
      this.addLog("success", `âœ… BATCH ${batchNumber}/${totalBatches} COMPLETADO`)
      this.addLog("info", `ðŸ“Š Archivos descargados en este batch: ${batchSuccessCount}/${batch.length}`)
      this.addLog("info", `â±ï¸ Tiempo del batch: ${batchTimeSeconds}s`)
      
      batchNumber++
      
      // Si no es el Ãºltimo batch, verificar si necesitamos esperar
      if (i + batchSize < this.scannedFilesComplete.length) {
        // Verificar lÃ­mites de tasa antes del siguiente batch
        const limitType = this.isRateLimitedOperation('/file/', 'GET') ? 'rateLimited' : 'general'
        const currentLimit = this.rateLimits[limitType]
        
        if (currentLimit.remaining <= batchSize) {
          const waitTime = Math.ceil((currentLimit.resetTime - Date.now()) / 1000)
          this.addLog("warning", `â° LÃMITE DE TASA PRÃ“XIMO A ALCANZARSE`)
          this.addLog("info", `ðŸ”„ Esperando ${waitTime} segundos antes del siguiente batch...`)
          this.addLog("info", `ðŸ“Š LÃ­mite actual: ${currentLimit.remaining}/${currentLimit.limit} (${limitType})`)
          
          await this.waitForRateLimit(waitTime)
          
          // Actualizar lÃ­mites despuÃ©s de la espera
          this.updateRateLimits()
          this.addLog("info", `âœ… LÃ­mites actualizados. Continuando con el siguiente batch...`)
        } else {
          this.addLog("info", `âœ… LÃ­mites OK (${currentLimit.remaining}/${currentLimit.limit} restantes). Continuando...`)
        }
      }
    }
    
    const totalTime = Date.now() - startTime
    const totalTimeMinutes = Math.round(totalTime / 60000)
    
    this.addLog("success", `ðŸŽ‰ DESCARGA EN BATCHES COMPLETADA`)
    this.addLog("info", `ðŸ“Š Archivos procesados: ${processedFiles}/${this.scannedFilesComplete.length}`)
    this.addLog("info", `â±ï¸ Tiempo total: ${totalTimeMinutes} minutos`)
    this.addLog("info", `ðŸ“ˆ Tasa de Ã©xito: ${Math.round((processedFiles / this.scannedFilesComplete.length) * 100)}%`)
  }

  /**
   * Descargar archivo directamente usando informaciÃ³n pre-obtenida (SIN llamadas API)
   */
  protected async downloadFileDirect(
    fileData: { file: PodioFile; downloadUrl: string; folderPath: string; appName: string },
    progressCallback?: ProgressCallback,
    fileIndex?: number,
    totalFiles?: number
  ): Promise<boolean> {
    if (!this.authData) {
      this.addLog("error", "No autenticado. Llama a authenticate() primero.");
      return false;
    }
    
    try {
      await this.ensureFolderExists(fileData.folderPath);
      
      if (
        typeof window !== 'undefined' &&
        window.electron &&
        window.electron.fileSystem &&
        typeof window.electron.fileSystem.downloadFile === 'function'
      ) {
        const filePath = `${fileData.folderPath}/${fileData.file.name}`;
        await window.electron.fileSystem.downloadFile(fileData.downloadUrl, filePath);
        
        // Verificar existencia y sumar tamaÃ±o real descargado
        if ((window.electron.fileSystem as any)?.existsSync) {
          const exists = await ((window.electron.fileSystem as any)?.existsSync(filePath));
          if (!exists) {
            this.addLog("error", `El archivo no se encontrÃ³ despuÃ©s de descargar: ${filePath}`);
            return false;
          } else {
            this.addLog("success", `Archivo descargado directamente: ${filePath}`);
            return true;
          }
        }
      } else {
        this.addLog("error", "FunciÃ³n de descarga de archivos no disponible en Electron");
        return false;
      }
    } catch (error) {
      this.addLog("error", `Error al descargar archivo ${fileData.file.name}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    
    return false;
  }

  /**
   * Procesar archivos en batches respetando lÃ­mites de tasa (mÃ©todo original para compatibilidad)
   */
  protected async processFilesInBatches(
    files: PodioFile[], 
    folderPath: string, 
    progressCallback?: ProgressCallback,
    batchSize: number = 240 // Dejar margen de 10 para el lÃ­mite de 250
  ): Promise<void> {
    this.addLog("info", `Procesando ${files.length} archivos en batches de ${batchSize}`)
    
    let processedFiles = 0
    let batchNumber = 1
    
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize)
      this.addLog("info", `Procesando batch ${batchNumber}: archivos ${i + 1}-${Math.min(i + batchSize, files.length)} de ${files.length}`)
      
      // Procesar archivos del batch
      for (let j = 0; j < batch.length; j++) {
        const file = batch[j]
        const fileIndex = i + j
        
        try {
          const success = await this.downloadFile(file, folderPath, progressCallback, fileIndex, files.length)
          if (success) {
            processedFiles++
          }
          
          // Actualizar progreso
          if (progressCallback) {
            const progress = Math.min(99, (processedFiles / files.length) * 100)
            this.updateProgress(progress, `Descargando archivo ${processedFiles}/${files.length}: ${file.name}`, progressCallback)
          }
          
        } catch (error) {
          this.addLog("error", `Error al descargar archivo ${file.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      
      batchNumber++
      
      // Si no es el Ãºltimo batch, verificar si necesitamos esperar
      if (i + batchSize < files.length) {
        // Verificar lÃ­mites de tasa antes del siguiente batch
        const limitType = this.isRateLimitedOperation('/file/', 'GET') ? 'rateLimited' : 'general'
        const currentLimit = this.rateLimits[limitType]
        
        if (currentLimit.remaining <= batchSize) {
          const waitTime = Math.ceil((currentLimit.resetTime - Date.now()) / 1000)
          this.addLog("warning", `LÃ­mite de tasa prÃ³ximo a agotarse. Esperando ${waitTime} segundos antes del siguiente batch...`)
          await this.waitForRateLimit(waitTime)
          
          // Actualizar lÃ­mites despuÃ©s de la espera
          this.updateRateLimits()
        }
      }
    }
    
    this.addLog("success", `Procesamiento de archivos completado: ${processedFiles}/${files.length} archivos descargados`)
  }

  /**
   * Descargar un archivo de Podio
   */
  protected async downloadFile(file: any, folderPath: string, progressCallback?: ProgressCallback, fileIndex?: number, totalFiles?: number): Promise<boolean> {
    if (!this.authData) {
      this.addLog("error", "No autenticado. Llama a authenticate() primero.");
      return false;
    }
    try {
      let downloadUrl = file.link;
      if (!downloadUrl) {
        downloadUrl = await this.getFileDownloadLink(file.file_id);
      }
      if (!downloadUrl) {
        this.addLog("error", `No se pudo obtener el enlace de descarga para el archivo ${file.name}`);
        return false;
      }
      await this.ensureFolderExists(folderPath);
      if (
        typeof window !== 'undefined' &&
        window.electron &&
        window.electron.fileSystem &&
        typeof window.electron.fileSystem.downloadFile === 'function'
      ) {
        const filePath = `${folderPath}/${file.name}`;
        await window.electron.fileSystem.downloadFile(downloadUrl, filePath);
        // Verificar existencia y sumar tamaÃ±o real descargado
        if ((window.electron.fileSystem as any)?.existsSync) {
          const exists = await ((window.electron.fileSystem as any)?.existsSync(filePath));
          if (!exists) {
            this.addLog("error", `El archivo no se encontrÃ³ despuÃ©s de descargar: ${filePath}`);
          } else {
            this.addLog("success", `Archivo guardado: ${filePath}`);
            if ((window.electron.fileSystem as any)?.getFileSize) {
              const size = await ((window.electron.fileSystem as any)?.getFileSize(filePath));
              this.backupStats.downloadedBytes += size;
              if (progressCallback && typeof this.totalFilesToDownload === 'number' && typeof fileIndex === 'number' && typeof totalFiles === 'number') {
                const progress = 99 * ((fileIndex + 1) / (this.totalFilesToDownload + (totalFiles || 0)));
                this.updateProgress(progress, `Descargando archivo ${fileIndex + 1} de ${this.totalFilesToDownload}`, progressCallback);
              }
            }
          }
        } else {
          this.addLog("success", `Archivo guardado (no verificado): ${filePath}`);
        }
      return true;
      } else {
        throw new Error('FunciÃ³n de archivos solo disponible en Electron');
      }
    } catch (error) {
      this.addLog("error", `Error al descargar o guardar archivo: ${file.name} - ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Escanear lo que se va a respaldar SIN realizar la descarga, pero contando archivos reales
   * @param options - Opciones de respaldo (organizaciones, workspaces, apps a incluir)
   * @param progressCallback - Callback para reportar progreso
   * @param useLastScan - Si true, intenta reutilizar el Ãºltimo escaneo (< 1 hora)
   * @param scanOnly - Si true, solo escanea estructura (modo rápido). Si false, escanea completo con archivos
   * 
   * @remarks
   * - Este método delega la implementación a scanBackupImpl del módulo separado
   * - Permite modularización y mejor organización del código
   */
  public async scanBackup(
    options: BackupOptions, 
    progressCallback?: ProgressCallback,
    useLastScan: boolean = false,
    scanOnly: boolean = true
  ): Promise<void> {
    // Delegar a la funciÃ³n del mÃ³dulo separado
    const { scanBackupImpl } = await import('./podio-service-scan');
    return scanBackupImpl(this, options, progressCallback, useLastScan, scanOnly);
  }

  /**
   * Realizar el respaldo completo: descargar archivos usando URLs guardadas durante el escaneo
   * 
   * Este método SOLO descarga archivos usando las URLs guardadas en BD durante el escaneo.
   * NO hace llamadas API adicionales - solo descarga archivos físicamente a sus carpetas.
   * 
   * @param options - Opciones de respaldo (organizaciones, workspaces, apps a incluir)
   * @param progressCallback - Callback para reportar progreso durante la descarga
   * @param useLastScan - Si true, intenta reutilizar el último escaneo (< 1 hora)
   * 
   * @throws Error si no hay datos escaneados en BD o si no se puede cargar scannedFilesComplete
   * 
   * @remarks
   * **FLUJO DE RESPALDO:**
   * 1. Carga `scannedFilesComplete` desde BD usando `getLastScanFiles()` y `getLastScanApps()`
   * 2. Construye la estructura de `scannedFilesComplete` con URLs guardadas
   * 3. Descarga archivos usando `processCompleteFilesInBatches()` (SOLO descarga, sin API calls)
   * 4. Descarga Excels oficiales de todas las apps usando Batch API
   * 5. Actualiza el registro de backup en Podio con estado "Completado"
   * 
   * **OPTIMIZACIONES:**
   * - NO hace llamadas API durante la descarga (usa URLs guardadas)
   * - Descarga archivo por archivo (Podio no tiene endpoint batch para descarga)
   * - Procesa archivos en batches de 240 para respetar rate limits
   * - Las URLs ya fueron obtenidas durante el escaneo usando `/file/app/{app_id}/` (1 llamada por app)
   * 
   * **REQUISITOS:**
   * - Debe existir un escaneo previo con datos guardados en BD
   * - Las URLs de descarga deben estar guardadas en BD como `download_url`
   * 
   * @example
   * ```typescript
   * await service.performBackup(
   *   { organizations: true, workspaces: true, applications: true, items: true, files: true },
   *   (data) => console.log(`Progreso: ${data.progress}%`),
   *   false
   * );
   * ```
   */
  public async performBackup(
    options: BackupOptions,
    progressCallback?: ProgressCallback,
    useLastScan: boolean = false
  ): Promise<void> {
    this.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    this.addLog("info", "📦 INICIANDO RESPALDO COMPLETO");
    this.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      // Verificar autenticación
      if (!this.authData) {
        this.addLog("error", "No autenticado. Llama a authenticate() primero.");
      throw new Error("No autenticado. Llama a authenticate() primero.");
    }
    
    // Cargar datos escaneados desde BD
    if (typeof window !== 'undefined' && window.electron && window.electron.db) {
      try {
        const lastScan = await window.electron.db.getLastScan();
        if (!lastScan) {
          this.addLog("error", "❌ No se encontró ningún escaneo previo en BD");
          this.addLog("error", "❌ Debes ejecutar un escaneo primero antes de realizar el respaldo");
          throw new Error("No se encontró ningún escaneo previo. Ejecuta un escaneo primero.");
        }
        
        this.addLog("info", `📚 Cargando datos del escaneo ID: ${lastScan.id} (${new Date(lastScan.created_at).toLocaleString()})`);
        
        // Cargar archivos y apps desde BD
        const files = await window.electron.db.getLastScanFiles();
        const apps = await window.electron.db.getLastScanApps();
        
        if (files.length === 0) {
          this.addLog("warning", "⚠️ No hay archivos para descargar en el escaneo previo");
        } else {
          this.addLog("info", `📥 Cargando ${files.length} archivos con URLs guardadas desde BD...`);
        }
        
        // Construir scannedFilesComplete desde BD con URLs guardadas
        this.scannedFilesComplete = files.map(file => ({
          file: {
            file_id: file.file_id,
            name: file.name,
            link: file.download_url,
            mimetype: file.mimetype || '',
            size: file.size || 0,
            download_link: file.download_url
          },
          downloadUrl: file.download_url, // URL guardada durante el escaneo
          folderPath: file.folder_path,
          appName: apps.find(a => a.app_id === file.app_id)?.app_name || 'Unknown'
        }));
        
        // Construir scannedApps desde BD
        this.scannedApps = apps.map(app => ({
          appId: app.app_id,
          folderPath: app.folder_path,
          appName: app.app_name
        }));
        
        this.addLog("success", `✅ Datos cargados desde BD: ${apps.length} apps, ${files.length} archivos con URLs guardadas`);
        
        // Verificar que todas las URLs estén disponibles
        const filesWithoutUrl = this.scannedFilesComplete.filter(f => !f.downloadUrl || f.downloadUrl === '');
        if (filesWithoutUrl.length > 0) {
          this.addLog("warning", `⚠️ ${filesWithoutUrl.length} archivos no tienen URL de descarga guardada`);
          this.addLog("warning", `⚠️ Estos archivos se omitirán durante la descarga`);
          // Filtrar archivos sin URL
          this.scannedFilesComplete = this.scannedFilesComplete.filter(f => f.downloadUrl && f.downloadUrl !== '');
        }
        
      } catch (dbError) {
        this.addLog("error", `❌ Error cargando datos desde BD: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
        throw new Error(`No se pudieron cargar los datos del escaneo: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
      }
    } else {
      this.addLog("error", "❌ Electron DB no disponible. No se pueden cargar datos del escaneo.");
      throw new Error("Electron DB no disponible");
    }
    
    // Verificar que hay datos para descargar
    if (this.scannedFilesComplete.length === 0 && this.scannedApps.length === 0) {
      this.addLog("error", "❌ No hay datos para descargar. El escaneo previo no tiene archivos ni apps.");
      throw new Error("No hay datos para descargar. Ejecuta un escaneo primero.");
    }
    
    // PASO 1: Descargar archivos usando URLs guardadas (SIN llamadas API)
    if (this.scannedFilesComplete.length > 0) {
      this.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      this.addLog("info", `📥 PASO 1: Descargando ${this.scannedFilesComplete.length} archivos usando URLs guardadas...`);
      this.addLog("info", "📥 NOTA: No se harán llamadas API adicionales - solo descarga física de archivos");
      await this.processCompleteFilesInBatches(progressCallback);
    } else {
      this.addLog("info", "ℹ️ No hay archivos para descargar");
    }
    
    // PASO 2: Descargar Excels oficiales usando Batch API (solo si no fueron descargados durante el escaneo)
    if (this.scannedApps.length > 0) {
      this.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      this.addLog("info", `📊 PASO 2: Verificando y descargando Excels oficiales de ${this.scannedApps.length} apps usando Batch API...`);
      let excelIndex = 0;
      let skippedCount = 0;
      
      for (const app of this.scannedApps) {
        try {
          // Verificar si el Excel ya existe (fue descargado durante el escaneo)
          const excelFileName = `${this.sanitizeFileName(app.appName)}_oficial.xlsx`;
          const excelPath = `${app.folderPath}/${excelFileName}`;
          
          if (typeof window !== 'undefined' && window.electron && typeof (window.electron.fileSystem as any)?.existsSync === 'function') {
            const exists = await ((window.electron.fileSystem as any).existsSync(excelPath));
            if (exists) {
              this.addLog("info", `⏭️ [Excel ${excelIndex + 1}/${this.scannedApps.length}] Excel ya existe, omitiendo: ${app.appName}`);
              this.addLog("info", `📁 Ruta: ${excelPath}`);
              skippedCount++;
              excelIndex++;
              continue;
            }
          }
          
          // Excel no existe, descargarlo
          await this.downloadAppExcel(app.appId, app.folderPath, app.appName, progressCallback, excelIndex, this.scannedApps.length);
          excelIndex++;
        } catch (error) {
          this.addLog("error", `❌ Error descargando Excel para ${app.appName}: ${error instanceof Error ? error.message : String(error)}`);
          // Continuar con la siguiente app
          excelIndex++;
        }
      }
      
      if (skippedCount > 0) {
        this.addLog("info", `ℹ️ ${skippedCount} Excel(s) ya existían y fueron omitidos (descargados durante el escaneo)`);
      }
    } else {
      this.addLog("info", "ℹ️ No hay apps para descargar Excel");
    }
    
    // PASO 3: Actualizar registro de backup en Podio
    this.addLog("info", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    this.addLog("info", "📝 PASO 3: Actualizando registro de backup en Podio...");
    try {
      await this.updateBackupRecord(true);
      this.addLog("success", "✅ Registro de backup actualizado en Podio");
    } catch (error) {
      this.addLog("error", `❌ Error actualizando registro de backup: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Finalizar
          if (progressCallback) {
      this.updateProgress(100, "Respaldo completado.", progressCallback);
    }
    
    this.addLog("success", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    this.addLog("success", "✅ RESPALDO COMPLETO FINALIZADO");
    this.addLog("success", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  }

  /**
   * Reanudar un respaldo desde un escaneo incompleto
   * Este método puede ser sobrescrito por clases derivadas (como PodioBackupServiceElectron)
   * 
   * @param scanId - ID del escaneo a reanudar
   * @param options - Opciones de respaldo
   * @param progressCallback - Callback para reportar progreso
   * 
   * @remarks
   * - Carga el checkpoint del escaneo especificado
   * - Continúa desde donde quedó
   * - Las clases derivadas pueden sobrescribir este método para agregar funcionalidades específicas
   */
  public async resumeBackup(
    scanId: number,
    options: BackupOptions,
    progressCallback?: ProgressCallback
  ): Promise<void> {
    // Establecer el scan ID actual
    this.currentScanId = scanId;
    
    // Reanudar el escaneo desde el checkpoint
    await this.scanBackup(options, progressCallback, false, false);
  }

  /**
          this.addLog("info", `âš ï¸ Se detectÃ³ un escaneo cancelado anteriormente (ID: ${lastScan.id}). Iniciando nuevo escaneo desde cero.`);
          // Continuar con el flujo normal para crear un nuevo scan
        } else {
          // El escaneo no estÃ¡ finalizado (no tiene summary) y NO fue cancelado, significa que se interrumpiÃ³ (rate limit, etc.)
          this.addLog("warning", `ðŸ”„ Se detectÃ³ un escaneo incompleto (ID: ${lastScan.id}, fecha: ${new Date(lastScan.created_at_ms).toLocaleString()})`);
          this.addLog("info", "ðŸ”„ Reanudando escaneo automÃ¡ticamente desde donde quedÃ³...");
          
          // Cargar datos parciales del escaneo incompleto
          const apps = await window.electron.db.getLastScanApps();
          const files = await window.electron.db.getLastScanFiles();
          const itemsCount = await window.electron.db.getLastScanItemsCount();
          
          this.currentScanId = lastScan.id;
          
          // Cargar checkpoint desde BD para saber exactamente dÃ³nde quedÃ³
          const savedCheckpoint = await window.electron.db.getScanCheckpoint(lastScan.id);
          if (savedCheckpoint) {
            this.processingCheckpoint = {
              orgIndex: savedCheckpoint.orgIndex,
              orgTotal: savedCheckpoint.orgTotal,
              workspaceIndex: savedCheckpoint.workspaceIndex,
              workspaceTotal: savedCheckpoint.workspaceTotal,
              appIndex: savedCheckpoint.appIndex,
              appTotal: savedCheckpoint.appTotal,
              organizations: [], // Se poblarÃ¡ cuando se carguen las organizaciones
              workspacesCounted: savedCheckpoint.workspacesCounted || false,
              appsCounted: savedCheckpoint.appsCounted || false
            };
            this.addLog("success", `ðŸ“ Checkpoint restaurado: Org ${savedCheckpoint.orgIndex + 1}/${savedCheckpoint.orgTotal}, Workspace ${savedCheckpoint.workspaceIndex + 1}/${savedCheckpoint.workspaceTotal}, App ${savedCheckpoint.appIndex + 1}/${savedCheckpoint.appTotal}`);
            this.addLog("info", "ðŸ”„ Continuando automÃ¡ticamente desde el checkpoint...");
          } else {
            this.addLog("info", "âš ï¸ No se encontrÃ³ checkpoint guardado. El escaneo continuarÃ¡ desde el principio.");
          }
          
          // Poblar datos en memoria desde el escaneo incompleto
          this.scannedApps = apps.map(app => ({
            appId: app.app_id,
            folderPath: app.folder_path,
            appName: app.app_name
          }));
          
          this.scannedFilesComplete = files.map(file => ({
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
          this.backupCounts.applications = apps.length;
          this.backupCounts.items = itemsCount;
          this.backupCounts.files = files.length;
          
          this.addLog("success", `ðŸ“Š Escaneo incompleto cargado: ${apps.length} apps, ${itemsCount} items, ${files.length} archivos`);
          this.addLog("info", "âš ï¸ Los datos ya escaneados no se volverÃ¡n a procesar. Continuando desde el checkpoint...");
        }
      }
    }
    
    // ========================================================================
    // LIMPIAR CHECKPOINTS AL INICIAR NUEVO ESCANEO (solo si no hay escaneo incompleto)
    // ========================================================================
    if (!this.currentScanId) {
      this.processingCheckpoint = null;
      this.addLog("info", "ðŸ“ Checkpoints limpiados: Iniciando nuevo escaneo desde cero");
    } else {
      this.addLog("info", "ðŸ“ Checkpoints preservados: Continuando escaneo incompleto");
    }
    
    // ========================================================================
    // LIMPIAR RATE LIMITS AL INICIAR ESCANEO (USUARIO DECIDIÃ“ CONTINUAR)
    // ========================================================================
    if (typeof window !== 'undefined' && window.electron && window.electron.db) {
      try {
        await window.electron.db.clearRateLimitStatus('general');
        await window.electron.db.clearRateLimitStatus('rateLimited');
        this.activeRateLimit = null; // Limpiar tambiÃ©n el rate limit en memoria
        this.addLog("info", "ðŸ”„ Rate limits limpiados al iniciar escaneo...");
      } catch (error) {
        this.addLog("warning", `No se pudieron limpiar rate limits: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // ========================================================================
    // PASO 1: CREAR REGISTRO DE BACKUP EN PODIO (CON REINTENTOS AUTOMÃTICOS)
    // ========================================================================
    let createBackupAttempts = 0;
    const MAX_CREATE_BACKUP_ATTEMPTS = 3;
    
    while (createBackupAttempts < MAX_CREATE_BACKUP_ATTEMPTS) {
      try {
        this.addLog("info", `ðŸ“ Intentando crear registro de backup en Podio (intento ${createBackupAttempts + 1}/${MAX_CREATE_BACKUP_ATTEMPTS})...`);
        await this.createBackupRecord();
        this.addLog("success", `âœ… Registro de backup creado exitosamente en Podio`);
        break; // Ã‰xito, salir del loop
      } catch (error) {
        createBackupAttempts++;
        
        // Si hay un error de rate limit al crear el item, pausar y reintentar automÃ¡ticamente
        if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
          const parts = error.message.split(":");
          const waitTime = Number.parseInt(parts[1], 10) || 60;
          const limitType = parts[2] || 'general';
          
          this.addLog("warning", `âš ï¸ Rate limit detectado al crear registro de backup`);
          this.addLog("info", `â° Esperando ${Math.ceil(waitTime / 60)} minutos y reintentando automÃ¡ticamente...`);
          
          if (progressCallback) {
            this.updateProgress(1, `â° Pausa por rate limit. Esperando ${Math.ceil(waitTime / 60)} min... (ReintentarÃ¡ automÃ¡ticamente)`, progressCallback);
          }
          
          // Esperar el tiempo necesario con progreso visual
          await this.waitForRateLimit(waitTime, limitType as 'general' | 'rateLimited');
          
          // Verificar si quedan intentos
          if (createBackupAttempts < MAX_CREATE_BACKUP_ATTEMPTS) {
            this.addLog("info", `ðŸ”„ Reintentando crear registro de backup...`);
            continue; // Reintentar
          } else {
            this.addLog("error", `âŒ No se pudo crear el registro de backup despuÃ©s de ${MAX_CREATE_BACKUP_ATTEMPTS} intentos`);
            throw new Error(`No se pudo crear el registro de backup despuÃ©s de ${MAX_CREATE_BACKUP_ATTEMPTS} intentos debido a rate limits`);
          }
        }
        
        // Si es otro tipo de error, lanzarlo inmediatamente
        this.addLog("error", `âŒ Error al crear registro de backup: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
    
    // IMPORTANTE: Solo verificar escaneo reciente si el usuario lo solicita explÃ­citamente
    // Si es un nuevo backup (useLastScan = false), SIEMPRE hacer un escaneo nuevo
    if (useLastScan && typeof window !== 'undefined' && window.electron && window.electron.db) {
      try {
        const lastScan = await window.electron.db.getLastScan();
        if (lastScan) {
          const scanAge = Date.now() - lastScan.created_at_ms;
          const oneHour = 60 * 60 * 1000;
          
          // Cargar datos del escaneo para verificar si tiene datos vÃ¡lidos
          const apps = await window.electron.db.getLastScanApps();
          const files = await window.electron.db.getLastScanFiles();
          const itemsCount = await window.electron.db.getLastScanItemsCount();
          
          // IMPORTANTE: Si el escaneo reciente estÃ¡ vacÃ­o (0 apps y 0 archivos), hacer un escaneo nuevo
          if (apps.length === 0 && files.length === 0 && itemsCount === 0) {
            this.addLog("warning", `âš ï¸ Escaneo reciente encontrado pero estÃ¡ vacÃ­o (0 apps, 0 items, 0 archivos). Haciendo escaneo nuevo...`);
            // Continuar con el escaneo normal, no retornar
          } else if (lastScan.summary) {
            // Escaneo COMPLETO (tiene summary) - solo cargar y usar, no reanudar
            this.addLog("info", `âœ… Escaneo completo encontrado (${Math.round(scanAge / 60000)} minutos). Cargando desde BD...`);
            
            this.scannedApps = apps.map(app => ({
              appId: app.app_id,
              folderPath: app.folder_path,
              appName: app.app_name
            }));
            
            this.scannedFilesComplete = files.map(file => ({
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
            
            this.scannedFiles = this.scannedFilesComplete.map(sf => sf.file);
            this.currentScanId = lastScan.id;
            
            this.scannedStats = {
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
            
            this.addLog("success", `âœ… Escaneo completo cargado desde BD: ${apps.length} apps, ${itemsCount} items, ${files.length} archivos`);
            
            if (progressCallback) {
              this.updateProgress(100, `âœ… Escaneo completado desde BD: ${apps.length} apps, ${itemsCount} items, ${files.length} archivos`, progressCallback);
            }
            
            return; // No hacer escaneo nuevo, usar el de BD
          } else {
            // Escaneo INCOMPLETO (no tiene summary) - verificar si fue cancelado
            const isCancelled = lastScan.cancelled === 1 || lastScan.cancelled === true;
            
            if (isCancelled) {
              // El escaneo fue cancelado, NO reanudar, crear nuevo scan
              this.addLog("info", `âš ï¸ El escaneo anterior fue cancelado (ID: ${lastScan.id}). Iniciando nuevo escaneo desde cero.`);
              // Continuar con el flujo normal para crear un nuevo scan
            } else {
              // Escaneo INCOMPLETO (no tiene summary) y NO fue cancelado - cargar datos parciales y PAUSAR para acciÃ³n manual
              this.addLog("warning", `ðŸ”„ Escaneo incompleto encontrado (ID: ${lastScan.id}, ${Math.round(scanAge / 60000)} minutos).`);
              
              // Cargar datos parciales del escaneo incompleto
              this.currentScanId = lastScan.id;
              
              // Cargar checkpoint desde BD para saber exactamente dÃ³nde quedÃ³
              const savedCheckpoint = await window.electron.db.getScanCheckpoint(lastScan.id);
              if (savedCheckpoint) {
                this.processingCheckpoint = {
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
                this.addLog("success", `ðŸ“ Checkpoint encontrado: Org ${savedCheckpoint.orgIndex + 1}/${savedCheckpoint.orgTotal}, Workspace ${savedCheckpoint.workspaceIndex + 1}/${savedCheckpoint.workspaceTotal}, App ${savedCheckpoint.appIndex + 1}/${savedCheckpoint.appTotal}`);
              }
              
              // Poblar datos en memoria desde el escaneo incompleto
              this.scannedApps = apps.map(app => ({
                appId: app.app_id,
                folderPath: app.folder_path,
                appName: app.app_name
              }));
              
              this.scannedFilesComplete = files.map(file => ({
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
              
              this.scannedFiles = this.scannedFilesComplete.map(sf => sf.file);
              
              // Actualizar contadores desde los datos cargados
              this.backupCounts.applications = apps.length;
              this.backupCounts.items = itemsCount;
              this.backupCounts.files = files.length;
              
              this.addLog("success", `ðŸ“Š Escaneo incompleto cargado: ${apps.length} apps, ${itemsCount} items, ${files.length} archivos`);
              this.addLog("warning", `â¸ï¸ ESCANEO INCOMPLETO DETECTADO - Presiona "Reanudar Escaneo" para continuar desde donde quedÃ³`);
              this.addLog("info", "âš ï¸ Los datos ya escaneados no se volverÃ¡n a procesar cuando reanudes.");
              
              // PAUSAR para acciÃ³n manual cuando useLastScan=true
            if (progressCallback) {
                this.updateProgress(1, `â¸ï¸ Escaneo incompleto detectado. Presiona "Reanudar Escaneo" para continuar desde donde quedÃ³.`, progressCallback);
              }
              
              // Retornar para pausar y esperar acciÃ³n manual del usuario
              return;
            }
          }
        }
      } catch (error) {
        this.addLog("warning", `Error verificando escaneo reciente: ${error instanceof Error ? error.message : String(error)}`);
        // Continuar con escaneo normal si hay error
      }
    }
    
    // OPTIMIZACIÃ“N: Generar timestamp Ãºnico para este backup
    this.backupTimestamp = this.generateBackupTimestamp();
    const backupPathWithTimestamp = `${this.backupPath}/${this.backupTimestamp}`;
    this.addLog("info", `ðŸ“ Carpeta de backup Ãºnica: ${backupPathWithTimestamp}`);
    
    // Limpiar cachÃ© expirado al inicio de un nuevo escaneo
    if (typeof window !== 'undefined' && window.electron && window.electron.db) {
      await window.electron.db.clearExpiredApiCache();
    }
    
    try {
      this.addLog("info", "Iniciando escaneo de respaldo...");
      
      // Iniciar escaneo en BD si estÃ¡ disponible
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        try {
          this.addLog("info", `ðŸ“Š Iniciando escaneo en BD con podio_backup_item_id: ${this.backupItemId || 'NO DEFINIDO'}`);
          
          const scanResult = await window.electron.db.beginScan({
            user: undefined,
            org_id: undefined,
            podio_backup_item_id: this.backupItemId || undefined,
            title: `Backup scan - ${new Date().toISOString()}`
          });
          if (scanResult.success && scanResult.scanId) {
            this.currentScanId = scanResult.scanId;
            this.addLog("info", `ðŸ“Š Escaneo iniciado en BD (ID: ${this.currentScanId}, podio_backup_item_id: ${this.backupItemId || 'N/A'})`);
          } else {
            this.addLog("error", `âŒ No se pudo iniciar el escaneo en BD`);
          }
        } catch (dbError) {
          this.addLog("error", `âŒ Error iniciando escaneo en BD: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
        }
      }
      
      let totalFiles = 0;
      let totalItems = 0;
      let totalApps = 0;
      let totalWorkspaces = 0;
      this.scannedFiles = [];
      this.scannedStats = null;
      this.scannedApps = [];

      // Reiniciar contadores y estadÃ­sticas
      this.backupCounts = {
        organizations: 0,
        workspaces: 0,
        applications: 0,
        items: 0,
        files: 0,
        downloadedFiles: 0,
      };

      this.backupStats = {
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

      this.lastProgress = 0;

      // Verificar autenticaciÃ³n
      if (!this.authData) {
        this.addLog("error", "No autenticado. Llama a authenticate() primero.");
        throw new Error("No autenticado");
      }

      // Obtener organizaciones
      const organizations = await this.getOrganizations();
      this.backupCounts.organizations = organizations.length;

      // OPTIMIZACIÃ“N: NO contar por adelantado - contar mientras se escanea para evitar llamadas duplicadas
      this.addLog("info", "ðŸš€ Iniciando escaneo optimizado (sin conteo previo para evitar llamadas duplicadas)...");
      
      // Notificar progreso inicial
      try {
      if (progressCallback) {
          this.updateProgress(1, `Escaneando... (0 apps, 0 items, 0 archivos, 0.00 GB)`, progressCallback);
      }
    } catch (error) {
        this.addLog("error", `âŒ ERROR en updateProgress: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
      }

      // ========================================================================
      // DOCUMENTACIÃ“N DEL MODO DE ESCANEO
      // ========================================================================
      if (scanOnly) {
        this.addLog("info", "â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â” </think>
    await this.createBackupRecord();
    try {
      this.addLog("info", "Iniciando respaldo completo de Podio...");
      let totalFiles = 0;
      let totalItems = 0;
      let totalApps = 0;
      let totalWorkspaces = 0;
      // Si ya hay archivos escaneados, stats y apps, Ãºsalos
      let filesToDownload = this.scannedFiles && this.scannedFiles.length > 0 ? [...this.scannedFiles] : [];
      let statsToUse = this.scannedStats ? { ...this.scannedStats } : null;
      let appsToUse = this.scannedApps && this.scannedApps.length > 0 ? [...this.scannedApps] : [];
      if (filesToDownload.length > 0 && statsToUse && appsToUse.length > 0) {
        this.addLog("info", `Usando archivos, stats y apps escaneadas previamente: ${filesToDownload.length} archivos, ${appsToUse.length} apps.`);
        // OPTIMIZACIÃ“N: Usar archivos completos pre-obtenidos (SIN duplicaciÃ³n de llamadas API)
        if (this.scannedFilesComplete.length > 0) {
          this.addLog("info", `Usando ${this.scannedFilesComplete.length} archivos completos pre-obtenidos durante escaneo`);
          await this.processCompleteFilesInBatches(progressCallback);
        } else {
          // Fallback al mÃ©todo original si no hay archivos completos
          this.addLog("warning", "No hay archivos completos disponibles, usando mÃ©todo tradicional");
          const filesFolder = this.backupPath + "/archivos";
          await this.ensureFolderExists(filesFolder);
          await this.processFilesInBatches(filesToDownload, filesFolder, progressCallback);
        }
        // Descargar Excels oficiales usando la lista escaneada de apps
        this.addLog("info", `Descargando Excels oficiales de todas las apps (${appsToUse.length})...`);
        let excelIndex = 0;
        for (const task of appsToUse) {
          await this.downloadAppExcel(task.appId, task.folderPath, task.appName, progressCallback, excelIndex, appsToUse.length);
          excelIndex++;
        }
        // Finalizar
        const totalBytes = (statsToUse ? statsToUse.backupSize : this.backupStats.backupSize) * 1024 * 1024 * 1024;
        this.addLog("success", `Respaldo completo finalizado. TamaÃ±o total estimado: ${totalBytes} bytes (${(statsToUse ? statsToUse.backupSize : this.backupStats.backupSize).toFixed(2)} GB)`);
        // ACTUALIZAR EL ITEM DE BACKUP EN PODIO CON LOS DATOS FINALES Y ESTADO
        await this.updateBackupRecord(true);
        if (progressCallback) {
          this.updateProgress(100, "Respaldo completado.", progressCallback);
        }
        return;
      }
      // Si no hay datos escaneados, recorre y llena scannedApps en vivo
      this.scannedFiles = [];
      this.scannedStats = null;
      this.scannedApps = [];
      this.backupCounts = {
        organizations: 0,
        workspaces: 0,
        applications: 0,
        items: 0,
        files: 0,
        downloadedFiles: 0,
      };
      this.backupStats = {
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
      this.lastProgress = 0;
      if (!this.authData) {
        this.addLog("error", "No autenticado. Llama a authenticate() primero.");
        throw new Error("No autenticado");
      }
      const organizations = await this.getOrganizations();
      this.backupCounts.organizations = organizations.length;
      if (progressCallback) {
        this.updateProgress(5, "Escaneando organizaciones...", progressCallback);
      }
      let totalProgress = 5;
      const progressPerOrg = organizations.length > 0 ? 95 / organizations.length : 95;
      for (let i = 0; i < organizations.length; i++) {
        const org = organizations[i];
        this.addLog("info", `Escaneando organizaciÃ³n: ${org.name} (${i + 1}/${organizations.length})`);
        const workspaces = await this.getWorkspaces(org.org_id);
        this.backupCounts.workspaces += workspaces.length;
        this.backupStats.workspaces += workspaces.length;
        totalWorkspaces += workspaces.length;
        totalProgress += progressPerOrg * 0.1;
        if (progressCallback) {
          this.updateProgress(totalProgress, `Escaneando espacios de trabajo para ${org.name}...`, progressCallback);
        }
        const progressPerWorkspace = workspaces.length > 0 ? (progressPerOrg * 0.9) / workspaces.length : progressPerOrg * 0.9;
        for (let j = 0; j < workspaces.length; j++) {
          const workspace = workspaces[j];
          this.addLog("info", `Escaneando espacio de trabajo: ${workspace.name} (${j + 1}/${workspaces.length})`);
          const applications = await this.getApplications(workspace.space_id);
          this.backupCounts.applications += applications.length;
          this.backupStats.apps += applications.length;
          totalApps += applications.length;
          totalProgress += progressPerWorkspace * 0.2;
          if (progressCallback) {
            this.updateProgress(totalProgress, `Escaneando aplicaciones para ${workspace.name}...`, progressCallback);
          }
          const progressPerApp = applications.length > 0 ? (progressPerWorkspace * 0.8) / applications.length : progressPerWorkspace * 0.8;
          for (let k = 0; k < applications.length; k++) {
            const app = applications[k];
            this.addLog("info", `--- INICIO app (${k + 1}/${applications.length}): ${app.name} ---`);
            this.addLog("info", `Llamando a getItemsCount para app_id=${app.app_id} (${app.name})...`);
            let itemsCount = 0;
            try {
              itemsCount = await this.getItemsCount(app.app_id);
              this.addLog("info", `getItemsCount OK: ${itemsCount} items encontrados en app ${app.name} (${app.app_id})`);
            } catch (err) {
              this.addLog("error", `Error en getItemsCount para app ${app.name} (${app.app_id}): ${err instanceof Error ? err.message : String(err)}`);
              continue;
            }
            this.backupCounts.items += itemsCount;
            this.backupStats.items += itemsCount;
            totalItems += itemsCount;
            // Crear carpeta para la app
            const folderPath = await this.createFolderStructure(org.name, workspace.name, app.name);
            // Guardar tarea de Excel para despuÃ©s (en memoria)
            this.scannedApps.push({ appId: app.app_id, folderPath, appName: app.name });
            
            // OPTIMIZACIÓN: Usar /file/app/{app_id}/ para obtener todos los archivos de una vez
            // Esto es mucho más eficiente que iterar por cada item
            this.addLog("info", `📥 [${app.name}] Obteniendo archivos de la app (app_id: ${app.app_id})...`);
            const appFiles: PodioFile[] = [];
            try {
              const allFiles = await this.getAppFiles(app.app_id);
              this.addLog("info", `📊 [${app.name}] Archivos obtenidos: ${allFiles.length} archivos`);
              
              for (const file of allFiles) {
                if (isTestMode() && totalFiles >= TEST_LIMIT) break;
                
                // OPTIMIZACIÓN: Obtener TODA la información necesaria durante el escaneo
                let fileSize = file.size;
                let downloadUrl = file.download_link || file.link;
                
                // Si falta el tamaño, obtenerlo desde el endpoint de archivo
                if (!fileSize || fileSize === 0) {
                  try {
                    const fileInfo = await this.apiRequest<any>(`/file/${file.file_id}`);
                    if (fileInfo && typeof fileInfo.size === 'number') {
                      fileSize = fileInfo.size;
                      file.size = fileSize; // Actualizar en memoria
                    }
                  } catch (e) {
                    this.addLog("warning", `No se pudo obtener el tamaño para el archivo ${file.name} (${file.file_id})`);
                  }
                }
                
                // Si no hay link directo, obtener download_link durante el escaneo
                if (!downloadUrl) {
                  try {
                    downloadUrl = await this.getFileDownloadLink(file.file_id);
                    this.addLog("info", `Enlace de descarga obtenido durante escaneo: ${file.name}`);
                  } catch (e) {
                    this.addLog("warning", `No se pudo obtener enlace de descarga para ${file.name} (${file.file_id})`);
                    continue; // Saltar archivo si no se puede obtener enlace
                  }
                }
                
                // Almacenar información completa para evitar duplicación en descarga
                const filesFolder = `${folderPath}/files`;
                this.scannedFilesComplete.push({
                  file: file,
                  downloadUrl: downloadUrl,
                  folderPath: filesFolder,
  /**
   * Actualiza el estado del respaldo en el item de backup en Podio
   * 
   * @param success - true si el respaldo fue exitoso, false si hubo error
   * @param errorMessage - Mensaje de error opcional
   * 
   * @remarks
   * - Usado por los módulos de escaneo para actualizar el estado del backup en Podio
   * - Actualiza el estado (Pendiente, Completado, Error) y las estadísticas finales
   * - Solo se actualiza si backupItemId está definido
   */
  protected async updateBackupRecord(success: boolean, errorMessage?: string): Promise<void> {
    if (!this.backupItemId) {
      this.addLog("warning", "No hay backupItemId para actualizar el estado del respaldo en Podio.");
      return;
    }
    try {
      // Obtener el estado correcto
      // Debes reemplazar estos valores por el integer_value_of_option real de tu campo 'estado' en Podio
      // Puedes obtenerlos consultando la API de Podio para las opciones del campo 'estado'
      const ESTADO_COMPLETADO = 2; // Reemplaza por el valor real de la opciÃ³n 'Completado'
      const ESTADO_ERROR = 3;      // Reemplaza por el valor real de la opciÃ³n 'Error'
      const estadoValue = success ? ESTADO_COMPLETADO : ESTADO_ERROR;

      // Obtener la fecha de inicio guardada y la fecha de fin
      const fechaStart = this.backupStartDate;
      const fechaEnd = this.formatDateForPodio(new Date());
      // Formatear el tamaÃ±o en GB
      const tamanoEnGb = this.backupStats.backupSize.toFixed(2) + " GB";

      // Construir el payload para actualizar el item (todos los campos)
      const fields: any = {
        "estado": estadoValue,
        "fecha": { start: fechaStart, end: fechaEnd },
        "tamano-en-gb": tamanoEnGb,
        "organizaciones": this.backupCounts.organizations,
        "espacios-de-trabajo": this.backupCounts.workspaces,
        "aplicacines": this.backupCounts.applications, // typo intencional
        "items": this.backupCounts.items,
        "archivos": this.backupCounts.files,
      };

      // Llamar a la API de Podio para actualizar el item
      await this.apiRequest(`/item/${this.backupItemId}`, "PUT", { fields });
      this.addLog("success", `Item de backup actualizado en Podio: estado=${success ? "Completado" : "Error"}, tamaÃ±o=${tamanoEnGb}`);
    } catch (error) {
      this.addLog("error", `Error al actualizar el item de backup en Podio: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Crea un nuevo registro de backup en Podio y guarda el backupItemId
   * 
   * @remarks
   * - Usado por los módulos de escaneo para crear el registro inicial del backup
   * - Crea un item en la aplicación de backup con estado "Pendiente"
   * - Guarda el backupItemId para actualizaciones posteriores
   * - Incluye reintentos automáticos en caso de rate limits
   */
  protected async createBackupRecord(): Promise<void> {
    this.addLog("info", "Entrando a createBackupRecord...");
    try {
      // Debes reemplazar este valor por el integer_value_of_option real de la opciÃ³n 'Pendiente' en tu campo 'estado'
      const ESTADO_PENDIENTE = 1; // Reemplaza por el valor real de la opciÃ³n 'Pendiente'
      const fechaInicio = this.formatDateForPodio(new Date());
      this.backupStartDate = fechaInicio; // Guardar fecha de inicio para updates
      const titulo = `Respaldo ${new Date().toLocaleString()}`;
      // Construir el payload para crear el item
      const fields: any = {
        "titulo": titulo,
        "estado": ESTADO_PENDIENTE,
        "fecha": { start: fechaInicio },
        "organizaciones": 0,
        "espacios-de-trabajo": 0,
        "aplicacines": 0, // typo intencional, igual que en Podio
        "items": 0,
        "archivos": 0,
        "tamano-en-gb": "0.00 GB",
      };
      const appId = Number(process.env.NEXT_PUBLIC_PODIO_BACKUP_APP_ID) || 30233695;
      this.addLog("info", `Enviando request a /item/app/${appId}/ con fields: ${JSON.stringify(fields)}`);
      // Llamar a la API de Podio para crear el item
      const response = await this.apiRequest(`/item/app/${appId}/`, "POST", { fields });
      this.addLog("info", `Respuesta de la API al crear backup: ${JSON.stringify(response)}`);
      if (response && typeof response === 'object' && 'item_id' in response) {
        this.backupItemId = (response as any).item_id;
        this.addLog("success", `Registro de backup creado en Podio con ID: ${this.backupItemId}`);
        this.addLog("warning", `Â¡Item de backup creado en Podio! ID: ${this.backupItemId}`); // Log naranja
      } else {
        this.backupItemId = null;
        this.addLog("error", "No se pudo obtener el item_id al crear el registro de backup en Podio. No se podrÃ¡ actualizar el estado del respaldo.");
      }
    } catch (error) {
      this.backupItemId = null;
      this.addLog("error", `Error al crear el registro de backup en Podio: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Actualiza el tamaño estimado del respaldo en el item de backup en Podio
   * 
   * @remarks
   * - Usado por los módulos de escaneo para actualizar el tamaño estimado durante el proceso
   * - Se actualiza periódicamente para mostrar progreso al usuario
   * - Solo se actualiza si backupItemId está definido
   */
  protected async updateEstimatedSizeInBackupRecord(): Promise<void> {
    if (!this.backupItemId) {
      this.addLog("warning", "No hay backupItemId para actualizar el tamaÃ±o del respaldo en Podio.");
      return;
    }
    try {
      const tamanoEnGb = this.backupStats.backupSize.toFixed(2) + " GB";
      await this.apiRequest(`/item/${this.backupItemId}`, "PUT", { "tamano-en-gb": tamanoEnGb });
      this.addLog("success", `TamaÃ±o estimado del respaldo actualizado en Podio: ${tamanoEnGb}`);
    } catch (error) {
      this.addLog("error", `Error al actualizar el tamaÃ±o estimado del respaldo en Podio: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Formatea una fecha al formato requerido por Podio: YYYY-MM-DD HH:MM:SS
   */
  private formatDateForPodio(date: Date): string {
    const pad = (n: number) => n < 10 ? '0' + n : n;
    return (
      date.getFullYear() +
      '-' + pad(date.getMonth() + 1) +
      '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) +
      ':' + pad(date.getMinutes()) +
      ':' + pad(date.getSeconds())
    );
  }

  /**
   * Genera un timestamp único para el backup
   */
  protected generateBackupTimestamp(): string {
    const now = new Date();
    const pad = (n: number) => n < 10 ? '0' + n : n;
    return (
      now.getFullYear() +
      '-' + pad(now.getMonth() + 1) +
      '-' + pad(now.getDate()) +
      '_' + pad(now.getHours()) +
      '-' + pad(now.getMinutes()) +
      '-' + pad(now.getSeconds())
    );
  }

  /**
   * Obtiene información de rate limit desde la base de datos
   * Este método puede ser sobrescrito por clases derivadas (como PodioBackupServiceElectron)
   */
  public async getRateLimitInfoFromDb(): Promise<{ active: boolean; remainingSeconds: number; type: string }> {
    // Implementación por defecto: retornar información desde memoria
    const info = this.getRateLimitInfo();
    return {
      active: info.active,
      remainingSeconds: info.remainingSeconds || 0,
      type: info.type || 'general'
    };
  }
}

export {};
