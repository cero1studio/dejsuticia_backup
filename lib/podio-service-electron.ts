// Importamos el servicio original y lo extendemos
import { 
  PodioBackupService as OriginalPodioBackupService,
  type BackupOptions,
  type ProgressCallback
} from "./podio-service"
import * as path from "path"

// Extendemos la clase original para usar las APIs de Electron
export class PodioBackupService extends OriginalPodioBackupService {
  private selectedBackupPath: string | null = null
  private isCancelled = false
  private isPaused = false
  private pausePromiseResolve: (() => void) | null = null

  // Verificar si estamos en Electron
  private isElectron(): boolean {
    return typeof window !== "undefined" && !!window.electron
  }

  /**
   * Cancelar el proceso de respaldo
   */
  public cancelBackup(): void {
    this.isCancelled = true
    this.addLog("warning", "Proceso de respaldo cancelado por el usuario")

    // Si está pausado, también resolver la promesa de pausa para continuar y poder cancelar
    if (this.isPaused && this.pausePromiseResolve) {
      this.pausePromiseResolve()
      this.isPaused = false
      this.pausePromiseResolve = null
    }
  }

  /**
   * Pausar el proceso de respaldo
   */
  public pauseBackup(): Promise<void> {
    if (!this.isPaused) {
      this.isPaused = true
      this.addLog("info", "Proceso de respaldo pausado por el usuario")

      return new Promise<void>((resolve) => {
        this.pausePromiseResolve = resolve
      })
    }

    return Promise.resolve()
  }

  /**
   * Reanudar el proceso de respaldo pausado (override del método de pausa)
   */
  public resumePausedBackup(): void {
    if (this.isPaused && this.pausePromiseResolve) {
      this.isPaused = false
      this.addLog("info", "Proceso de respaldo reanudado")
      this.pausePromiseResolve()
      this.pausePromiseResolve = null
    }
  }

  /**
   * Implementar el método resumeBackup de la clase base
   */
  public async resumeBackup(scanId: number, options: BackupOptions, progressCallback?: ProgressCallback): Promise<void> {
    // Llamar al método de la clase base
    return super.resumeBackup(scanId, options, progressCallback)
  }

  /**
   * Verificar si el proceso está cancelado
   */
  public isBackupCancelled(): boolean {
    return this.isCancelled
  }

  /**
   * Verificar si el proceso está pausado
   */
  public isBackupPaused(): boolean {
    return this.isPaused
  }

  /**
   * Reiniciar el estado de cancelación y pausa
   */
  public resetBackupState(): void {
    this.isCancelled = false
    this.isPaused = false
    this.pausePromiseResolve = null
  }

  /**
   * Intentar cargar ruta de respaldo guardada en configuración
   */
  private loadBackupPathFromConfig(): void {
    try {
      if (typeof localStorage === "undefined") return
      const savedConfig = localStorage.getItem("podio_backup_config")
      if (!savedConfig) return
      const config = JSON.parse(savedConfig)
      if (config.folderPath && typeof config.folderPath === "string" && config.folderPath.length > 0) {
        this.selectedBackupPath = config.folderPath
        this.backupPath = config.folderPath
        this.addLog("info", `Carpeta de respaldo cargada de configuración: ${this.selectedBackupPath}`)
      }
    } catch (e) {
      // Ignorar errores de lectura de configuración
    }
  }

  /**
   * Solicitar al usuario que seleccione una carpeta para el respaldo
   */
  public async selectBackupFolder(): Promise<boolean> {
    if (!this.isElectron()) {
      this.addLog("warning", "La selección de carpetas solo está disponible en la versión de escritorio")
      return false
    }

    try {
      const result = await window.electron.fileSystem.selectDirectory()
      if (result.canceled) {
        this.addLog("warning", "Selección de carpeta cancelada por el usuario")
        return false
      }

      this.selectedBackupPath = result.filePath || null
      this.backupPath = result.filePath || this.backupPath
      this.addLog("success", `Carpeta de respaldo seleccionada: ${this.selectedBackupPath}`)

      // Guardar la ruta en la configuración
      if (typeof localStorage !== "undefined") {
        const savedConfig = localStorage.getItem("podio_backup_config") || "{}"
        const config = JSON.parse(savedConfig)
        config.folderPath = this.selectedBackupPath
        localStorage.setItem("podio_backup_config", JSON.stringify(config))
      }

      return true
    } catch (error) {
      this.addLog("error", `Error al seleccionar carpeta: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Inicializar la carpeta de respaldos
   */
  protected async initializeBackupFolder(): Promise<void> {
    try {
      // Si no hay una ruta seleccionada, usar la predeterminada
      if (!this.selectedBackupPath) {
        // Intentar cargar desde la configuración
        if (typeof localStorage !== "undefined") {
          const savedConfig = localStorage.getItem("podio_backup_config")
          if (savedConfig) {
            const config = JSON.parse(savedConfig)
            if (config.folderPath) {
              this.selectedBackupPath = config.folderPath
              this.backupPath = config.folderPath
            }
          }
        }
      }

      this.addLog("info", `Inicializando carpeta de respaldos: ${this.backupPath}`)

      if (this.isElectron()) {
        // Usar la API de Electron para crear la carpeta
        const result = await window.electron.fileSystem.createDirectory(this.backupPath)
        if (result.success) {
          this.addLog("success", `Carpeta de respaldos inicializada: ${result.path}`)
        } else {
          this.addLog("warning", `No se pudo inicializar la carpeta de respaldos: ${result.error}`)
        }
      } else {
        // Fallback para navegador
        this.addLog("info", `Simulando creación de carpeta en navegador: ${this.backupPath}`)
      }
    } catch (error) {
      this.addLog(
        "warning",
        `Error al inicializar carpeta de respaldos: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Crear estructura de carpetas para el respaldo con verificación de permisos
   */
  protected async createFolderStructure(orgName: string, workspaceName: string, appName: string): Promise<string> {
    try {
      // Verificar si el proceso ha sido cancelado
      if (this.isCancelled) {
        throw new Error("OPERATION_CANCELLED")
      }

      // Verificar si el proceso está pausado
      if (this.isPaused) {
        await this.pauseBackup()
      }

      // Sanitizar nombres para que sean válidos como nombres de carpeta
      const safeOrgName = this.sanitizeFileName(orgName)
      const safeWorkspaceName = this.sanitizeFileName(workspaceName)
      const safeAppName = this.sanitizeFileName(appName)

      // IMPORTANTE: Usar backupTimestamp para crear carpeta única por backup
      const basePath = this.backupTimestamp 
        ? path.join(this.backupPath, this.backupTimestamp)
        : this.backupPath

      // Construir la ruta completa
      const folderPath = path.join(basePath, safeOrgName, safeWorkspaceName, safeAppName)

      if (this.isElectron()) {
        // Verificar permisos de escritura en la carpeta base
        await this.verifyWritePermissions(this.backupPath)
        
        // Usar la API de Electron para crear carpetas
        this.addLog("info", `Creando estructura de carpetas: ${folderPath}`)
        const result = await window.electron.fileSystem.createDirectory(folderPath)
        
        if (result.success) {
          this.addLog("success", `✅ Estructura de carpetas creada: ${folderPath}`)
          // NOTA: La carpeta "files" se creará después solo si hay archivos
          // Esto se hace en processApplicationParallel después de obtener los archivos
        } else {
          // Analizar el tipo de error para dar mensajes más claros
          const errorMsg = result.error || 'Unknown error';
          
          // Si es porque ya existe, no es un error crítico
          if (errorMsg.includes('existe') || errorMsg.includes('exists') || errorMsg.includes('EEXIST')) {
            this.addLog("info", `ℹ️ La carpeta ya existe: ${folderPath}`)
            return folderPath; // Retornar la ruta aunque ya exista
          }
          
          // Si es por permisos
          if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM') || errorMsg.includes('permission')) {
            this.addLog("error", `❌ Error de permisos al crear carpeta: ${folderPath}`)
            this.addLog("error", `❌ Verifica que tengas permisos de escritura en: ${this.backupPath}`)
            throw new Error(`Permisos insuficientes: ${errorMsg}`);
          }
          
          // Si es por caracteres inválidos
          if (errorMsg.includes('EINVAL') || errorMsg.includes('invalid') || errorMsg.includes('caracter')) {
            this.addLog("error", `❌ Caracteres inválidos en nombre de carpeta: ${folderPath}`)
            this.addLog("error", `❌ Nombres originales: org="${orgName}", workspace="${workspaceName}", app="${appName}"`)
            throw new Error(`Caracteres inválidos en nombre: ${errorMsg}`);
          }
          
          // Otros errores
          this.addLog("error", `❌ Error crítico al crear carpetas: ${result.error}`)
          throw new Error(`No se pudo crear estructura de carpetas: ${result.error}`)
        }
      } else {
        // Fallback para navegador
        this.addLog("info", `🌐 Simulando estructura de carpetas: ${folderPath}`)
      }

      return folderPath
    } catch (error) {
      if (error instanceof Error && error.message === "OPERATION_CANCELLED") {
        throw error
      }

      this.addLog(
        "error",
        `❌ Error al crear estructura de carpetas: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  /**
   * Verificar permisos de escritura en una carpeta
   */
  private async verifyWritePermissions(folderPath: string): Promise<void> {
    try {
      if (this.isElectron()) {
        // Verificar si la carpeta existe
        const exists = await window.electron.fileSystem.existsSync(folderPath)
        if (!exists) {
          this.addLog("info", `📁 Carpeta base no existe, creando: ${folderPath}`)
          const createResult = await window.electron.fileSystem.createDirectory(folderPath)
          if (!createResult.success) {
            throw new Error(`No se pudo crear carpeta base: ${createResult.error}`)
          }
        }

        // Verificar permisos de escritura creando un archivo temporal
        const testFilePath = path.join(folderPath, `.podio-backup-test-${Date.now()}.tmp`)
        const testResult = await window.electron.fileSystem.saveFile("test", testFilePath)
        
        if (testResult.success) {
          this.addLog("success", `✅ Permisos de escritura verificados en: ${folderPath}`)
          // Limpiar archivo temporal
          try {
            await window.electron.fileSystem.deleteFile(testFilePath)
          } catch (cleanupError) {
            this.addLog("warning", `⚠️ No se pudo limpiar archivo temporal: ${cleanupError}`)
          }
        } else {
          throw new Error(`Sin permisos de escritura en: ${folderPath}. Error: ${testResult.error}`)
        }
      }
    } catch (error) {
      this.addLog("error", `❌ Error de permisos: ${error instanceof Error ? error.message : String(error)}`)
      throw new Error(`Verificación de permisos falló: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Asegurar que una carpeta existe, creándola si es necesario
   */
  protected async ensureFolderExists(folderPath: string): Promise<void> {
    // Verificar si el proceso ha sido cancelado
    if (this.isCancelled) {
      throw new Error("OPERATION_CANCELLED")
    }

    // Verificar si el proceso está pausado
    if (this.isPaused) {
      await this.pauseBackup()
    }

    if (this.isElectron()) {
      try {
        // Log ANTES de crear
        this.addLog("info", `📁 Creando carpeta: ${folderPath}`)
        
        // Usar la API de Electron para crear la carpeta
        const result = await window.electron.fileSystem.createDirectory(folderPath)
        if (result.success) {
          this.addLog("success", `✅ Carpeta lista: ${folderPath}`)
        } else {
          // Si no es error (puede que ya exista), no mostrar warning
          if (result.error && !result.error.includes('existe') && !result.error.includes('exists')) {
            this.addLog("warning", `⚠️ Error al crear carpeta ${folderPath}: ${result.error}`)
          }
        }
      } catch (error) {
        this.addLog(
          "warning",
          `⚠️ Error al crear carpeta ${folderPath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } else {
      // Fallback para navegador
      this.addLog("info", `📁 Simulando creación de carpeta: ${folderPath}`)
    }
  }

  /**
   * Convertir items a formato Excel y descargar
   */
  protected async saveItemsToExcel(items: any[], folderPath: string, appName: string): Promise<void> {
    try {
      // Verificar si el proceso ha sido cancelado
      if (this.isCancelled) {
        throw new Error("OPERATION_CANCELLED")
      }

      // Verificar si el proceso está pausado
      if (this.isPaused) {
        await this.pauseBackup()
      }

      const fileName = `${this.sanitizeFileName(appName)}_items.xlsx`
      this.addLog("info", `Preparando archivo Excel con ${items.length} elementos: ${fileName}`)

      // En Electron, podríamos usar una biblioteca como xlsx para generar el archivo
      if (this.isElectron()) {
        // Aquí deberías usar una biblioteca como xlsx para generar el contenido del Excel
        // Por ahora, simularemos con un JSON
        const jsonContent = JSON.stringify(items, null, 2)
        const filePath = path.join(folderPath, fileName)

        const result = await window.electron.fileSystem.saveFile(jsonContent, filePath)
        if (result.success) {
          this.addLog("success", `Archivo Excel guardado en: ${result.path}`)
        } else {
          this.addLog("error", `Error al guardar archivo Excel: ${result.error}`)
        }
      } else {
        // Fallback para navegador
        this.addLog("info", `Simulando generación de Excel: ${fileName}`)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } catch (error) {
      if (error instanceof Error && error.message === "OPERATION_CANCELLED") {
        throw error
      }

      this.addLog("error", `Error al generar archivo Excel: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  /**
   * Descargar un archivo de Podio
   */
  protected async downloadFile(file: any, folderPath: string, progressCallback?: ProgressCallback): Promise<boolean> {
    if (!this.authData) {
      this.addLog("error", "No autenticado. Llama a authenticate() primero.")
      return false
    }

    try {
      // Verificar si el proceso ha sido cancelado
      if (this.isCancelled) {
        throw new Error("OPERATION_CANCELLED")
      }

      // Verificar si el proceso está pausado
      if (this.isPaused) {
        await this.pauseBackup()
      }

      // ========================================================================
      // PASO 1: Asegurar que la carpeta existe ANTES de descargar
      // ========================================================================
      await this.ensureFolderExists(folderPath)

      // Preparar candidatos de URL de descarga
      const urlCandidates: string[] = []
      if (file.download_link) urlCandidates.push(file.download_link)
      if (file.link) urlCandidates.push(file.link) // https://files.podio.com/{id}
      // Siempre agregar el directo por si los anteriores no existen
      urlCandidates.push(await this.getFileDownloadLink(file.file_id))

      if (this.isElectron()) {
        // Usar la API de Electron para descargar el archivo
        const safeFileName = this.sanitizeFileName(file.name)
        const filePath = path.join(folderPath, safeFileName)

        // ========================================================================
        // PASO 2: Log claro ANTES de descargar
        // ========================================================================
        this.addLog("info", `📥 Descargando: ${file.name} (${this.formatFileSize(file.size)})`)

        // Preparar headers de autenticación
        const headers = {
          'Authorization': `OAuth2 ${this.authData.access_token}`,
          'User-Agent': 'Podio-Backup-Tool/1.0',
          'Accept': 'application/octet-stream'
        }

        // Intentar con cada URL candidata
        let result: any = { success: false, error: 'No URL candidates' }
        for (const url of urlCandidates.filter(Boolean)) {
          result = await window.electron.fileSystem.downloadFile(url, filePath, headers)
          if (result.success) break
        }

        // ========================================================================
        // PASO 3: Confirmar que se guardó correctamente
        // ========================================================================
        if (result.success) {
          // Verificar que el archivo existe y tiene contenido
          const fileExists = await window.electron.fileSystem.existsSync(filePath)
          if (!fileExists) {
            this.addLog("error", `❌ Archivo no encontrado después de descargar: ${file.name}`)
            return false
          }
          
          const fileSize = await window.electron.fileSystem.getFileSize(filePath)
          if (fileSize === 0) {
            this.addLog("warning", `⚠️ Archivo descargado está vacío: ${file.name}`)
          } else {
            // Log de confirmación con tamaño verificado
            this.addLog("success", `✅ Guardado: ${file.name} → ${this.formatFileSize(fileSize)}`)
          }
        } else {
          this.addLog("error", `❌ Error al descargar: ${file.name} - ${result.error}`)
          return false
        }
      } else {
        // Fallback para navegador
        this.addLog("info", `Simulando descarga de archivo: ${file.name}`)
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000 + 500))
      }

      // Actualizar estadísticas
      this.backupCounts.downloadedFiles++
      this.backupStats.downloadedFiles++
      this.backupStats.downloadedBytes += file.size

      // Notificar progreso
      if (progressCallback) {
        progressCallback({
          progress: this.lastProgress,
          status: `Descargando archivos... ${this.backupCounts.downloadedFiles}/${this.backupCounts.files}`,
          counts: this.backupCounts,
          stats: this.backupStats,
          logs: [...this.logs],
        })
      }

      return true
    } catch (error) {
      if (error instanceof Error && error.message === "OPERATION_CANCELLED") {
        throw error
      }

      this.addLog(
        "error",
        `Error al descargar archivo ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  /**
   * Sobrescribir el método scanBackup para solicitar la carpeta antes de iniciar
   */
  public async scanBackup(
    options: BackupOptions, 
    progressCallback?: ProgressCallback, 
    useLastScan: boolean = false,
    scanOnly: boolean = true
  ): Promise<void> {
    // Reiniciar el estado de cancelación y pausa
    this.resetBackupState()

    // Nota: durante el escaneo NO pedimos carpeta. Solo se solicita al iniciar el respaldo.
    // Pero si existe en configuración, la cargamos para no pedirla luego innecesariamente.
    if (!this.selectedBackupPath) {
      this.loadBackupPathFromConfig()
    }

    try {
      // Llamar al método original con todos los parámetros
      await super.scanBackup(options, ((data) => {
        // Verificar si el proceso ha sido cancelado
        if (this.isCancelled) {
          throw new Error("OPERATION_CANCELLED")
        }

        // Pasar los datos al callback original
        if (progressCallback) {
          progressCallback(data)
        }
      }) as ProgressCallback, useLastScan, scanOnly)
    } catch (error) {
      if (error instanceof Error && error.message === "OPERATION_CANCELLED") {
        this.addLog("warning", "Escaneo cancelado por el usuario")
        throw error
      }
      throw error
    }
  }

  /**
   * Sobrescribir el método performBackup para asegurar que tenemos una carpeta seleccionada
   */
  public async performBackup(options: BackupOptions, progressCallback?: ProgressCallback, useLastScan: boolean = false): Promise<void> {
    // Reiniciar el estado de cancelación y pausa
    this.resetBackupState()

    // Solicitar carpeta de respaldo si estamos en Electron y no la tenemos
    if (this.isElectron() && !this.selectedBackupPath) {
      // Intentar cargar desde configuración primero
      this.loadBackupPathFromConfig()
    }

    if (this.isElectron() && !this.selectedBackupPath) {
      const selected = await this.selectBackupFolder()
      if (!selected) {
        this.addLog("error", "No se seleccionó una carpeta de respaldo. Operación cancelada.")
        throw new Error("No se seleccionó una carpeta de respaldo")
      }
    }

    try {
      // Llamar al método original
      await super.performBackup(options, ((data) => {
        // Verificar si el proceso ha sido cancelado
        if (this.isCancelled) {
          throw new Error("OPERATION_CANCELLED")
        }

        // Pasar los datos al callback original
        if (progressCallback) {
          progressCallback(data)
        }
      }) as ProgressCallback, useLastScan)
    } catch (error) {
      if (error instanceof Error && error.message === "OPERATION_CANCELLED") {
        this.addLog("warning", "Respaldo cancelado por el usuario")
        throw error
      }
      throw error
    }
  }

  /**
   * Obtener información de rate limit desde la base de datos persistente
   * Este método consulta la BD de Electron para obtener el estado actual de rate limits
   * @returns Información del rate limit activo (si hay alguno)
   */
  public async getRateLimitInfoFromDb(): Promise<{ active: boolean; remainingSeconds: number; type: string }> {
    try {
      if (!this.isElectron() || !window.electron?.db) {
        // Si no estamos en Electron, retornar estado inactivo
        return { active: false, remainingSeconds: 0, type: "none" }
      }

      // Consultar ambos tipos de rate limit
      const generalStatus = await window.electron.db.getRateLimitStatus('general')
      const rateLimitedStatus = await window.electron.db.getRateLimitStatus('rateLimited')

      // Determinar cuál está activo (si hay alguno)
      if (generalStatus.active && generalStatus.resetInSeconds !== null && generalStatus.resetInSeconds > 0) {
        return {
          active: true,
          remainingSeconds: generalStatus.resetInSeconds,
          type: 'general'
        }
      }

      if (rateLimitedStatus.active && rateLimitedStatus.resetInSeconds !== null && rateLimitedStatus.resetInSeconds > 0) {
        return {
          active: true,
          remainingSeconds: rateLimitedStatus.resetInSeconds,
          type: 'rateLimited'
        }
      }

      // No hay rate limit activo
      return { active: false, remainingSeconds: 0, type: "none" }
    } catch (error) {
      // En caso de error, retornar estado inactivo
      console.warn('Error obteniendo rate limit desde BD:', error)
      return { active: false, remainingSeconds: 0, type: "none" }
    }
  }
}
