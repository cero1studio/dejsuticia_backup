"use client"

import type React from "react"
import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  FileIcon,
  FileTextIcon,
  FolderIcon,
  AlertCircle,
  CheckCircle,
  Clock,
  LogOut,
  Settings,
  Download,
  Check,
  FileArchive,
  Loader2,
  AlertTriangle,
  Eye,
  Activity,
  XCircle,
  HardDrive,
} from "lucide-react"
import { PodioBackupService } from "@/lib/podio-service-electron"
import { getPodioCredentials } from "@/lib/podio-credentials"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ScrollArea } from "@/components/ui/scroll-area"
import Link from "next/link"

function safeValue(value: any): string {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "object") {
    try {
      if (value.text) return String(value.text)
      return JSON.stringify(value)
    } catch (e) {
      return "[Objeto complejo]"
    }
  }
  return String(value)
}

// Tipos de estado para el backup (mejorado para distinguir pausado/cancelado/completado)
type BackupStatus = 
  | "idle"           // Sin actividad
  | "scanning"       // Escaneando estructura
  | "ready"          // Escaneo completado, listo para backup
  | "downloading"    // Descargando archivos
  | "paused"         // Pausado manualmente por el usuario
  | "cancelled"      // Cancelado por el usuario
  | "error"          // Error ocurrido
  | "completed"      // Completado exitosamente

export default function DashboardElectron() {
  const router = useRouter()
  const [progress, setProgress] = useState(0)
  const [isBackupRunning, setIsBackupRunning] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState("idle")
  const [connectionError, setConnectionError] = useState("")
  const [backupStatus, setBackupStatus] = useState<BackupStatus>("idle")
  const [backupError, setBackupError] = useState("")
  const [podioService, setPodioService] = useState<PodioBackupService | null>(null)
  const [statusMessage, setStatusMessage] = useState("")
  const [logs, setLogs] = useState<any[]>([])
  
  // Renderizar logs directamente sin memoización compleja para evitar loops
  const renderLogs = () => {
    if (logs.length === 0) {
      return <div className="text-gray-400 text-center">No hay logs disponibles</div>
    }
    // Limitar a los últimos 100 logs para evitar problemas de rendimiento
    const recentLogs = logs.slice(-100)
    return recentLogs.map((log, idx) => (
      <div key={`${log.timestamp}-${idx}`} className={`text-xs py-1 ${getLogColor(log.level)}`}>
        <span className="text-gray-500">{new Date(log.timestamp).toLocaleTimeString()} </span>
        {log.message}
      </div>
    ))
  }
  const [stats, setStats] = useState({
    apps: 0,
    items: 0,
    workspaces: 0,
    files: 0,
    backupSize: 0,
    successfulBackups: 0,
    backupWarnings: 0,
    downloadedFiles: 0,
    downloadedBytes: 0,
  })
  const [counts, setCounts] = useState({
    organizations: 0,
    workspaces: 0,
    applications: 0,
    items: 0,
    files: 0,
    downloadedFiles: 0,
  })
  const [backupHistory, setBackupHistory] = useState<any[]>([])
  const [backupFolder, setBackupFolder] = useState<string>("")
  const [rateLimit, setRateLimit] = useState({ active: false, remainingSeconds: 0, type: "none" })
  const [isPausedByRateLimit, setIsPausedByRateLimit] = useState(false)
  const rateLimitIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const continueBackupCalledRef = useRef<boolean>(false)
  const lastRateLimitRef = useRef<{ active: boolean; remainingSeconds: number; type: string } | null>(null)
  const continueBackupRef = useRef<(() => Promise<void>) | null>(null)
  const [planned, setPlanned] = useState<{apps:number; items:number}>({apps:0, items:0})
  const [processed, setProcessed] = useState<{apps:number; items:number}>({apps:0, items:0})
  const [lastScan, setLastScan] = useState<any>(null)
  const [useLastScan, setUseLastScan] = useState(false)
  const [incompleteBackup, setIncompleteBackup] = useState<{
    scanId: number
    scanDate: number
    stats: { total: number; done: number; pending: number; error: number }
  } | null>(null)
  // Mostrar un solo límite unificado en la UI (5000 requests/hora)
  const [rateLimitStats, setRateLimitStats] = useState({
    general: { used: 0, remaining: 5000, limit: 5000, resetInSeconds: null as number | null },
    rateLimited: { used: 0, remaining: 5000, limit: 5000, resetInSeconds: null as number | null }
  })
  const [selectedBackupDetails, setSelectedBackupDetails] = useState<any>(null)
  const [showBackupDetails, setShowBackupDetails] = useState(false)
  const [backupDetailsLoading, setBackupDetailsLoading] = useState(false)
  const [backupDetailsData, setBackupDetailsData] = useState<{
    scan: any
    apps: any[]
    files: any[]
  } | null>(null)

  // Usar useRef para evitar recrear el servicio en cada render
  const podioServiceRef = useRef<PodioBackupService | null>(null)
  const hasInitializedRef = useRef(false)
  
  useEffect(() => {
    // Evitar ejecución múltiple
    if (hasInitializedRef.current) {
      return
    }
    
    // Verificar si estamos en Electron
    if (!(typeof window !== "undefined" && window.electron)) {
      router.push("/")
      return
    }
    // Verificar si hay credenciales almacenadas
    const credentialsStr = sessionStorage.getItem("podio_credentials")
    if (!credentialsStr) {
      router.push("/")
      return
    }
    
    // Marcar como inicializado ANTES de crear el servicio
    hasInitializedRef.current = true
    
    const credentials = JSON.parse(credentialsStr)
    // Inicializar el servicio de Podio extendido solo una vez
    if (!podioServiceRef.current) {
      console.log("🔧 Inicializando PodioBackupService (solo una vez)...")
      podioServiceRef.current = new PodioBackupService()
      setPodioService(podioServiceRef.current)
      console.log("✅ PodioBackupService inicializado correctamente")
    }
    
    const service = podioServiceRef.current
    
    // Flag para evitar múltiples intentos de autenticación
    let isAuthenticating = false
    
    // Cargar historial de respaldos desde Podio
    const loadBackupHistory = async () => {
      // Evitar múltiples intentos simultáneos
      if (isAuthenticating) {
        console.log('⏸️ Autenticación ya en progreso, omitiendo...')
        return
      }
      
      try {
        isAuthenticating = true
        setConnectionStatus("connecting")
        setStatusMessage("Conectando con Podio...")
        
        // Verificar rate limit ANTES de intentar autenticar
        if (typeof window !== 'undefined' && window.electron && window.electron.db) {
          try {
            const rateLimitInfo = await service.getRateLimitInfoFromDb()
            if (rateLimitInfo.active && rateLimitInfo.remainingSeconds > 0) {
              setConnectionStatus("error")
              const minutes = Math.ceil(rateLimitInfo.remainingSeconds / 60)
              setConnectionError(`⏰ Rate limit activo. Espera ${minutes} minutos antes de intentar autenticarte.`)
              console.log(`⏰ Rate limit activo detectado: ${minutes} minutos restantes`)
              return
            }
          } catch (rateLimitError) {
            console.warn('Error verificando rate limit:', rateLimitError)
            // Continuar con autenticación si no se puede verificar
          }
        }
        
        // Obtener credenciales desde la función utilitaria centralizada
        const apiCredentials = getPodioCredentials()
        
        const success = await service.authenticate(
          apiCredentials.clientId,
          apiCredentials.clientSecret,
          credentials.username,
          credentials.password,
        )
        if (success) {
          setConnectionStatus("connected")
          setStatusMessage("Conectado a Podio correctamente")
          console.log("✅ Autenticación exitosa, cargando historial...")
          
          // Cargar historial desde BD local en lugar de Podio
          if (typeof window !== 'undefined' && window.electron && window.electron.db) {
            const historyResult = await window.electron.db.getLocalBackupHistory(10)
            if (historyResult.success) {
              console.log(`📋 Dashboard: Historial local cargado con ${historyResult.data.length} items`, historyResult.data)
              setBackupHistory(historyResult.data)
            } else {
              console.warn(`⚠️ Error cargando historial local:`, historyResult.error)
              setBackupHistory([])
            }
          }
          const stats = service.getBackupStats()
          setStats(stats)
          setLogs(service.getLogs())
        } else {
          setConnectionStatus("error")
          setConnectionError("No se pudo conectar con Podio. Verifica tus credenciales.")
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        setConnectionStatus("error")
        
        // Detectar si es un rate limit
        if (errorMsg.includes('RATE_LIMIT') || errorMsg.includes('420') || errorMsg.includes('429')) {
          setConnectionError("⏰ Rate limit alcanzado. Por favor espera antes de intentar nuevamente.")
        } else {
          setConnectionError("Error al conectar con Podio: " + errorMsg)
        }
      } finally {
        isAuthenticating = false
      }
    }
    loadBackupHistory()
    
    // Cargar último escaneo desde BD
    const loadLastScan = async () => {
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        try {
          const lastScanData = await window.electron.db.getLastScan()
          if (lastScanData) {
            setLastScan(lastScanData)
            console.log(`📦 Último escaneo encontrado: ${new Date(lastScanData.created_at_ms).toLocaleString()}`)
          }
        } catch (error) {
          console.warn('Error cargando último escaneo:', error)
        }
      }
    }
    loadLastScan()
    
    // Detectar si hay backup incompleto
    const checkIncompleteBackup = async () => {
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        try {
          const result = await window.electron.db.hasIncompleteBackup()
          if (result.hasIncomplete && result.scanId && result.stats) {
            setIncompleteBackup({
              scanId: result.scanId,
              scanDate: result.scanDate!,
              stats: result.stats
            })
            console.log(`⚠️ Backup incompleto detectado: Scan ID ${result.scanId}, ${result.stats.pending + result.stats.error} archivos pendientes`)
          }
        } catch (error) {
          console.warn('Error detectando backup incompleto:', error)
        }
      }
    }
    checkIncompleteBackup()
    
    // Cargar rate limit inicial desde BD (para mostrar tiempo restante correcto)
    const loadInitialRateLimit = async () => {
      // Usar el servicio desde el ref en lugar del estado
      const service = podioServiceRef.current
      if (service) {
        try {
          const info = await service.getRateLimitInfoFromDb()
          setRateLimit(info)
          if (info.active) {
            setIsPausedByRateLimit(true)
            console.log(`⏰ Rate limit activo detectado al cargar: ${Math.ceil(info.remainingSeconds / 60)} minutos restantes`)
          }
        } catch (error) {
          console.warn('Error cargando rate limit inicial:', error)
        }
      }
    }
    loadInitialRateLimit()
  }, [router]) // Solo router como dependencia - el servicio se crea una vez y se guarda en el ref
  
  // Actualizar límites remanentes desde BD cada 10 segundos
  useEffect(() => {
    // No necesitamos podioService aquí, solo la BD
    if (typeof window === 'undefined' || !window.electron || !window.electron.db) return
    
    const updateRateLimits = async () => {
      try {
        const general = await window.electron.db.getRateLimitStatus('general')
        const rateLimited = await window.electron.db.getRateLimitStatus('rateLimited')
        
        setRateLimitStats(prev => {
          // Comparación profunda simple para evitar re-renders
          if (prev.general.remaining === general.remaining && 
              prev.rateLimited.remaining === rateLimited.remaining &&
              prev.general.used === general.used &&
              prev.rateLimited.used === rateLimited.used &&
              prev.general.resetInSeconds === general.resetInSeconds &&
              prev.rateLimited.resetInSeconds === rateLimited.resetInSeconds) {
            return prev
          }
          
          return {
            general: {
              used: general.used,
              remaining: general.remaining,
              limit: general.limit,
              resetInSeconds: general.resetInSeconds
            },
            rateLimited: {
              used: rateLimited.used,
              remaining: rateLimited.remaining,
              limit: rateLimited.limit,
              resetInSeconds: rateLimited.resetInSeconds
            }
          }
        })
      } catch (error) {
        // Silenciar errores para evitar loops
      }
    }
    
    updateRateLimits()
    const interval = setInterval(updateRateLimits, 5000) // Reducir frecuencia a 5 segundos
    
    return () => clearInterval(interval)
  }, []) // Array vacío - solo se ejecuta una vez al montar

  useEffect(() => {
    // Usar el servicio desde el ref en lugar del estado para evitar loops
    const service = podioServiceRef.current
    if (!service) return
    if (rateLimitIntervalRef.current) clearInterval(rateLimitIntervalRef.current)
    
    // Función para actualizar el rate limit
    const updateRateLimit = async () => {
      try {
        // IMPORTANTE: Usar getRateLimitInfoFromDb() para leer el timestamp preservado desde BD
        const info = await service.getRateLimitInfoFromDb()
        
        // Comparar con el último valor usando useRef para evitar recrear objetos
        const last = lastRateLimitRef.current
        if (!last || 
            last.active !== info.active || 
            last.remainingSeconds !== info.remainingSeconds ||
            last.type !== info.type) {
          // Solo actualizar si los valores realmente cambiaron
          lastRateLimitRef.current = { ...info }
          
          // Actualizar estado de forma atómica para evitar múltiples re-renders
          setRateLimit((prev) => {
            // Doble verificación: solo actualizar si realmente cambió
            if (prev.active !== info.active || 
                prev.remainingSeconds !== info.remainingSeconds ||
                prev.type !== info.type) {
              return info
            }
            return prev
          })
          
          setIsPausedByRateLimit((prev) => {
            // Solo actualizar si realmente cambió
            if (prev !== info.active) {
              return info.active
            }
            return prev
          })
        }
      } catch (error) {
        // Silenciar errores completamente para evitar loops
      }
    }
    
    // Llamar inmediatamente para obtener el estado inicial
    updateRateLimit()
    
    // Configurar intervalo con un delay más largo para reducir actualizaciones
    rateLimitIntervalRef.current = setInterval(updateRateLimit, 3000) // Aumentar a 3 segundos
    
    return () => {
      if (rateLimitIntervalRef.current) {
        clearInterval(rateLimitIntervalRef.current)
        rateLimitIntervalRef.current = null
      }
    }
  }, []) // Array vacío - solo se ejecuta una vez al montar

  // TEMPORALMENTE DESHABILITADO: Este useEffect estaba causando loops infinitos
  // La funcionalidad de continuar automáticamente se puede activar manualmente con el botón
  // useEffect(() => {
  //   if (isPausedByRateLimit && rateLimit.active && rateLimit.remainingSeconds === 0 && !continueBackupCalledRef.current) {
  //     continueBackupCalledRef.current = true
  //     continueBackup()
  //     setTimeout(() => {
  //       continueBackupCalledRef.current = false
  //     }, 5000)
  //   }
  // }, [isPausedByRateLimit, rateLimit.active, rateLimit.remainingSeconds])

  const handleLogout = () => {
    sessionStorage.removeItem("podio_credentials")
    router.push("/")
  }

  /**
   * Cancela el proceso actual (escaneo o backup)
   * Muestra confirmación y actualiza el estado correctamente
   */
  const handleCancelBackup = () => {
    if (!podioService) return
    
    const isScanning = backupStatus === "scanning"
    const confirmMessage = isScanning 
      ? "¿Estás seguro de cancelar el escaneo actual?" 
      : "¿Estás seguro de cancelar el backup actual?"
    
    if (window.confirm(confirmMessage)) {
      // Llamar al método correspondiente según el proceso activo
      if (isScanning) {
        podioService.cancelScan()
      } else {
        podioService.cancelBackup()
      }
      
      // Actualizar estados de UI
      setIsBackupRunning(false)
      setBackupStatus("cancelled")
      setStatusMessage(`${isScanning ? "Escaneo" : "Backup"} cancelado por el usuario`)
      setIsPausedByRateLimit(false)
    }
  }

  // Función helper para actualizar estado desde callbacks de progreso
  const handleProgressUpdate = useCallback((data: any) => {
    // ACTUALIZAR PROGRESO
    if (typeof data.progress === 'number') {
      setProgress(data.progress)
    }
    
    // ACTUALIZAR STATS (apps, items, workspaces, files, backupSize, etc.)
    if (data.stats) {
      setStats(prevStats => ({
        ...prevStats,
        ...data.stats,
        // Asegurar que los valores numéricos sean correctos
        apps: data.stats.apps ?? prevStats.apps,
        items: data.stats.items ?? prevStats.items,
        workspaces: data.stats.workspaces ?? prevStats.workspaces,
        files: data.stats.files ?? prevStats.files,
        backupSize: data.stats.backupSize ?? prevStats.backupSize,
        downloadedFiles: data.stats.downloadedFiles ?? prevStats.downloadedFiles,
        downloadedBytes: data.stats.downloadedBytes ?? prevStats.downloadedBytes,
      }))
    }
    
    // ACTUALIZAR COUNTS (organizations, workspaces, applications, items, files)
    if (data.counts) {
      setCounts(prevCounts => ({
        ...prevCounts,
        ...data.counts,
        // Asegurar que los valores numéricos sean correctos
        organizations: data.counts.organizations ?? prevCounts.organizations,
        workspaces: data.counts.workspaces ?? prevCounts.workspaces,
        applications: data.counts.applications ?? prevCounts.applications,
        items: data.counts.items ?? prevCounts.items,
        files: data.counts.files ?? prevCounts.files,
        downloadedFiles: data.counts.downloadedFiles ?? prevCounts.downloadedFiles,
      }))
    }
    
    // ACTUALIZAR STATUS MESSAGE
    if (data.status) {
      setStatusMessage(data.status)
    }
    
    // ACTUALIZAR LOGS - Actualizar más frecuentemente para ver cambios en tiempo real
    if (data.logs && Array.isArray(data.logs)) {
      setLogs(data.logs.slice(-200)) // Mantener últimos 200 logs
    }
    
    if (data.planned) setPlanned(data.planned)
    if (data.processed) setProcessed(data.processed)
  }, [])

  const scanBackup = async () => {
    if (!podioService || connectionStatus !== "connected") return
    setShowConfirmDialog(false)
    setBackupStatus("scanning")
    setProgress(0)
    setIsBackupRunning(true)
    setStatusMessage("Escaneando datos de Podio...")
    setBackupError("")
    // Reiniciar stats y counts al iniciar nuevo escaneo
    setStats({
      apps: 0,
      items: 0,
      workspaces: 0,
      files: 0,
      backupSize: 0,
      successfulBackups: 0,
      backupWarnings: 0,
      downloadedFiles: 0,
      downloadedBytes: 0,
    })
    setCounts({
      organizations: 0,
      workspaces: 0,
      applications: 0,
      items: 0,
      files: 0,
      downloadedFiles: 0,
    })
    
    // IMPORTANTE: NO limpiar rate limits en la UI al iniciar escaneo
    // El rate limit puede estar activo en la BD (timestamp preservado)
    // El intervalo que actualiza cada segundo leerá el estado correcto desde la BD
    // Solo limpiar en la BD si el usuario realmente quiere forzar (se hace en forceRetryAfterRateLimit)
    console.log('ℹ️ Iniciando escaneo - El rate limit se leerá desde BD automáticamente')
    
    // Variable para rastrear el último progreso del callback
    let lastProgressFromCallback = 0
    
    try {
      await podioService.scanBackup(
        {
          organizations: true,
          workspaces: true,
          applications: true,
          items: true,
          files: true,
        },
        (data: any) => {
          lastProgressFromCallback = data.progress // Guardar el progreso del callback
          handleProgressUpdate(data)
        },
        useLastScan, // Pasar el valor del checkbox: solo usar último escaneo si el usuario lo marca
        false // scanOnly: false para descargar excels durante el escaneo
      )
      // IMPORTANTE: Solo establecer progreso a 100% si realmente completó sin errores
      // Si hay un error de rate limit, el progreso ya está establecido correctamente en el servicio
      // Usar el progreso del último callback en lugar del estado (que puede no estar actualizado)
      if (lastProgressFromCallback === 100) {
        setProgress(100)
        setBackupStatus("ready")
        setStatusMessage("✅ Escaneo completado. Listo para respaldar.")
      } else {
        // Si el progreso no es 100%, mantener el estado actual y no cambiar a "ready"
        // El servicio ya estableció el progreso y mensaje correctos
        setBackupStatus("paused")
        setIsPausedByRateLimit(true)
      }
      
      // Recargar último escaneo después del escaneo
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        try {
          const lastScanData = await window.electron.db.getLastScan()
          if (lastScanData) {
            setLastScan(lastScanData)
            
            // Verificar URLs de descarga guardadas
            if (lastScanData.id && window.electron.db.checkDownloadUrls) {
              try {
                const urlCheck = await window.electron.db.checkDownloadUrls(lastScanData.id)
                if (urlCheck.success) {
                  console.log(`✅ Verificación de URLs de descarga:`)
                  console.log(`   Total archivos: ${urlCheck.total}`)
                  console.log(`   ✅ Con URL: ${urlCheck.withUrl}`)
                  console.log(`   ❌ Sin URL: ${urlCheck.withoutUrl}`)
                  console.log(`   URLs de API Podio: ${urlCheck.apiUrls}`)
                  
                  if (urlCheck.withoutUrl > 0) {
                    console.warn(`⚠️ ADVERTENCIA: ${urlCheck.withoutUrl} archivos sin URL de descarga`)
                  }
                  
                  if (urlCheck.sample && urlCheck.sample.length > 0) {
                    console.log(`📋 Ejemplos de archivos guardados:`)
                    urlCheck.sample.forEach((file, idx) => {
                      console.log(`   ${idx + 1}. ${file.name} - ${file.has_url ? '✅' : '❌'} URL: ${file.url_preview}`)
                    })
                  }
                }
              } catch (urlError) {
                console.warn('Error verificando URLs de descarga:', urlError)
              }
            }
          }
        } catch (error) {
          console.warn('Error recargando último escaneo:', error)
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      
      // Si fue cancelación, no es un error
      if (errorMsg.includes("cancelado") || errorMsg.includes("ESCANEO_CANCELADO")) {
        setBackupStatus("cancelled")
        setStatusMessage("Escaneo cancelado por el usuario")
        setLogs((prevLogs) => [
          ...prevLogs,
          {
            level: "warning",
            message: "⛔ Escaneo cancelado por el usuario",
            timestamp: new Date(),
          },
        ])
      } 
      // Verificar si es un error de rate limit (incluyendo escaneo incompleto)
      else if (errorMsg.startsWith("RATE_LIMIT_ERROR:")) {
        const parts = errorMsg.split(":")
        const waitTime = Number.parseInt(parts[1], 10) || 60
        const limitType = parts[2] || "general"
        const errorDetail = parts[3] || ""
        
        // Agregar el mensaje de error a los logs
        setLogs((prevLogs) => [
          ...prevLogs,
          {
            level: "error",
            message: errorDetail || `⚠️ LÍMITE DE TASA DE PODIO ALCANZADO (${limitType}). Se esperará ${waitTime} segundos antes de reintentar automáticamente.`,
            timestamp: new Date(),
          },
          {
            level: "error",
            message: `Error durante el escaneo: ${errorMsg}`,
            timestamp: new Date(),
          },
        ])
        
        // NO establecer backupStatus a "error" - mantener en "paused" para permitir reanudación
        setBackupStatus("paused")
        setIsPausedByRateLimit(true)
      } else {
        // Es un error real
        setBackupStatus("error")
        const fullErrorMsg = "Error al escanear: " + errorMsg
        setBackupError(fullErrorMsg)
        setLogs((prevLogs) => [
          ...prevLogs,
          {
            level: "error",
            message: fullErrorMsg,
            timestamp: new Date(),
          },
        ])
      }
    } finally {
      // Solo desactivar isBackupRunning si no está pausado por rate limit
      if (backupStatus !== "paused") {
        setIsBackupRunning(false)
      }
    }
  }

  // Nueva función para seleccionar carpeta
  const selectBackupFolder = async () => {
    if (window.electron && window.electron.fileSystem && window.electron.fileSystem.selectDirectory) {
      const result = await window.electron.fileSystem.selectDirectory()
      if (!result.canceled && result.filePath) {
        setBackupFolder(result.filePath)
        return result.filePath
      }
    }
    return null
  }

  // Iniciar respaldo (la selección de carpeta la gestiona el servicio Electron)
  const startBackup = async () => {
    if (!podioService || backupStatus !== "ready") return

    // IMPORTANTE: NO limpiar rate limits en la UI al iniciar backup
    // El rate limit puede estar activo en la BD (timestamp preservado)
    // El intervalo que actualiza cada segundo leerá el estado correcto desde la BD
    // Solo limpiar en la BD si el usuario realmente quiere forzar (se hace en forceRetryAfterRateLimit)
    console.log('ℹ️ Iniciando backup - El rate limit se leerá desde BD automáticamente')

    setIsBackupRunning(true)
    setProgress(0)
    setStatusMessage("Iniciando respaldo...")
    setBackupStatus("downloading")
    setBackupError("")
    try {
      await podioService.performBackup(
        {
          organizations: true,
          workspaces: true,
          applications: true,
          items: true,
          files: true,
        },
        (data: any) => {
          handleProgressUpdate(data)
        },
        useLastScan
      )
      
      // Esperar un momento para que Podio actualice el item antes de recargar el historial
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      console.log(`📋 Recargando historial local desde BD...`)
      
      // Cargar historial desde BD local
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        const historyResult = await window.electron.db.getLocalBackupHistory(10)
        if (historyResult.success) {
          console.log(`📋 Historial local actualizado: ${historyResult.data.length} items`)
          setBackupHistory(historyResult.data)
        } else {
          console.warn(`⚠️ Error recargando historial local:`, historyResult.error)
        }
      }
      
      // Agregar log para informar al usuario
      setLogs((prevLogs) => [
        ...prevLogs,
        {
          level: "success",
          message: `✅ Historial actualizado: ${history.length} backups encontrados`,
          timestamp: new Date(),
        },
      ])
      
      // Recargar último escaneo después del backup para actualizar la UI
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        try {
          const lastScanData = await window.electron.db.getLastScan()
          if (lastScanData) {
            setLastScan(lastScanData)
          }
        } catch (error) {
          console.warn('Error recargando último escaneo:', error)
        }
      }
      
      setProgress(100) // Asegurar que el progreso llegue a 100%
      setBackupStatus("completed")
      setStatusMessage("✅ ¡Respaldo completado con éxito!")
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      
      // Si fue cancelación, no es un error
      if (errorMsg.includes("cancelado") || errorMsg.includes("BACKUP_CANCELADO")) {
        setBackupStatus("cancelled")
        setStatusMessage("Backup cancelado por el usuario")
        setLogs((prevLogs) => [
          ...prevLogs,
          {
            level: "warning",
            message: "⛔ Backup cancelado por el usuario",
            timestamp: new Date(),
          },
        ])
      } else {
        // Es un error real
        setBackupStatus("error")
        const fullErrorMsg = "Error al realizar el respaldo: " + errorMsg
        setBackupError(fullErrorMsg)
        setLogs((prevLogs) => [
          ...prevLogs,
          {
            level: "error",
            message: fullErrorMsg,
            timestamp: new Date(),
          },
        ])
      }
      setIsBackupRunning(false)
    } finally {
      setIsBackupRunning(false)
    }
  }

  // Función para cargar detalles de un backup
  const loadBackupDetails = async (backupItem: any) => {
    if (!backupItem.item_id) {
      console.warn('⚠️ No hay item_id en el backup:', backupItem);
      return;
    }

    console.log('🔍 Cargando detalles del backup con item_id:', backupItem.item_id);
    setSelectedBackupDetails(backupItem);
    setShowBackupDetails(true);
    setBackupDetailsLoading(true);
    setBackupDetailsData(null);

    try {
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        // Asegurarse de que el item_id sea un número
        const podioItemId = Number(backupItem.item_id);
        
        if (isNaN(podioItemId)) {
          console.error('❌ item_id no es un número válido:', backupItem.item_id);
          setBackupDetailsData({
            scan: null,
            apps: [],
            files: []
          });
          return;
        }

        console.log('🔎 Buscando scan con podio_backup_item_id:', podioItemId);
        
        // Buscar el scan por podio_backup_item_id
        const scan = await window.electron.db.getScanByPodioItemId(podioItemId);
        
        console.log('📋 Resultado de búsqueda de scan:', scan ? `Encontrado scan ID: ${scan.id}` : 'No encontrado');
        
        if (scan) {
          console.log('📦 Obteniendo apps y archivos del scan ID:', scan.id);
          
          // Obtener apps y archivos del scan
          const apps = await window.electron.db.getScanAppsByScanId(scan.id);
          const files = await window.electron.db.getScanFilesByScanId(scan.id);
          
          console.log(`✅ Datos cargados: ${apps.length} apps, ${files.length} archivos`);
          
          setBackupDetailsData({
            scan,
            apps,
            files
          });
        } else {
          console.warn('⚠️ No se encontró scan en BD para item_id:', podioItemId);
          // Si no hay scan en BD, mostrar mensaje informativo
          setBackupDetailsData({
            scan: null,
            apps: [],
            files: []
          });
        }
      } else {
        console.error('❌ window.electron.db no está disponible');
      }
    } catch (error) {
      console.error('❌ Error cargando detalles del backup:', error);
    } finally {
      setBackupDetailsLoading(false);
    }
  };

  // Función para continuar respaldo manualmente
  const continueBackup = useCallback(async () => {
    if (!podioService) return
    setIsBackupRunning(true)
    setBackupStatus("downloading")
    setStatusMessage("Reanudando respaldo tras rate limit...")
    setBackupError("")
    try {
      await podioService.performBackup(
        {
          organizations: true,
          workspaces: true,
          applications: true,
          items: true,
          files: true,
        },
        (data: any) => {
          handleProgressUpdate(data)
        },
        useLastScan
      )
      
      // Esperar un momento para que Podio actualice el item antes de recargar el historial
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      console.log(`📋 Recargando historial local desde BD...`)
      
      // Cargar historial desde BD local
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        const historyResult = await window.electron.db.getLocalBackupHistory(10)
        if (historyResult.success) {
          console.log(`📋 Historial local actualizado: ${historyResult.data.length} items`)
          setBackupHistory(historyResult.data)
        } else {
          console.warn(`⚠️ Error recargando historial local:`, historyResult.error)
        }
      }
      
      // Agregar log para informar al usuario
      setLogs((prevLogs) => [
        ...prevLogs,
        {
          level: "success",
          message: `✅ Historial actualizado: ${history.length} backups encontrados`,
          timestamp: new Date(),
        },
      ])
      
      setProgress(100) // Asegurar que el progreso llegue a 100%
      setBackupStatus("completed")
      setStatusMessage("✅ ¡Respaldo completado con éxito!")
    } catch (error) {
      setBackupStatus("error")
      const errorMsg = "Error al realizar el respaldo: " + (error instanceof Error ? error.message : String(error))
      setBackupError(errorMsg)
      setIsBackupRunning(false)
      setLogs((prevLogs) => [
        ...prevLogs,
        {
          level: "error",
          message: errorMsg,
          timestamp: new Date(),
        },
      ])
    } finally {
      setIsBackupRunning(false)
    }
  }, [podioService])

  // Función para reanudar backup interrumpido desde checkpoints
  const resumeBackupFromCheckpoint = async () => {
    if (!podioService || !incompleteBackup) return
    
    setIsBackupRunning(true)
    setBackupStatus("downloading")
    setProgress(0)
    setStatusMessage("Reanudando backup interrumpido desde checkpoints...")
    setBackupError("")
    
    try {
      await podioService.resumeBackup(
        incompleteBackup.scanId,
        {
          organizations: true,
          workspaces: true,
          applications: true,
          items: true,
          files: true,
        },
        (data: any) => {
          handleProgressUpdate(data)
        }
      )
      
      // Esperar para que Podio actualice
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      // Cargar historial desde BD local
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        const historyResult = await window.electron.db.getLocalBackupHistory(10)
        if (historyResult.success) {
          setBackupHistory(historyResult.data)
        }
      }
      
      // Limpiar el backup incompleto ya que se completó exitosamente
      setIncompleteBackup(null)
      
      setBackupStatus("completed")
      setStatusMessage("¡Backup reanudado y completado con éxito!")
    } catch (error) {
      setBackupStatus("error")
      const errorMsg = "Error al reanudar el backup: " + (error instanceof Error ? error.message : String(error))
      setBackupError(errorMsg)
      setStatusMessage(errorMsg)
    } finally {
      setIsBackupRunning(false)
    }
  }

  // Función para descartar backup incompleto
  const discardIncompleteBackup = () => {
    if (window.confirm("¿Estás seguro de que deseas descartar el backup incompleto? No podrás recuperar el progreso.")) {
      setIncompleteBackup(null)
      alert("Backup incompleto descartado. Puedes iniciar un nuevo escaneo.")
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Logo removido */}
          </div>
          <div className="flex gap-2">
            <Link href="/configuracion-electron">
              <Button variant="outline" size="sm">
                <Settings className="h-4 w-4 mr-2" />
                Configuración
              </Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="h-4 w-4 mr-2" />
              Cerrar Sesión
            </Button>
          </div>
        </div>
      </header>
      <main className="container mx-auto py-6 px-4">
        {/* Estado de conexión */}
        {connectionStatus === "connecting" && (
          <Alert className="mb-6">
            <Clock className="h-4 w-4" />
            <AlertDescription>Conectando con Podio...</AlertDescription>
          </Alert>
        )}

        {connectionStatus === "connected" && (
          <Alert className="mb-6 bg-green-50 border-green-200">
            <Check className="h-4 w-4 text-green-600" />
            <AlertDescription>Conectado a Podio correctamente</AlertDescription>
          </Alert>
        )}

        {connectionStatus === "error" && (
          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{connectionError}</AlertDescription>
          </Alert>
        )}

        {/* Información de límites de tasa con desglose detallado */}
        <Card className="mb-6 bg-blue-50 border-blue-200">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center text-base">
              <AlertTriangle className="h-5 w-5 mr-2 text-blue-600" />
              Límites de la API de Podio (5,000 req/hora)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              {/* Desglose de peticiones */}
              {(() => {
                const general = rateLimitStats.general
                const rateLimited = rateLimitStats.rateLimited
                const total = general.used + rateLimited.used
                const totalLimit = 5000
                const totalRemaining = totalLimit - total
                
                // Función para obtener clase de color según porcentaje usado
                const getColorClass = (used: number, limit: number) => {
                  const percentage = (used / limit) * 100
                  if (percentage >= 95) return "text-red-600 font-bold"
                  if (percentage >= 80) return "text-orange-600 font-semibold"
                  return "text-green-600"
                }
                
                return (
                  <>
                    {/* Peticiones Normales (GET mayormente) */}
                    <div className="flex items-center justify-between p-2 bg-white rounded">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">🟢 Peticiones Normales:</span>
                        <span className="text-xs text-gray-500 cursor-help" title="GET y consultas: /org, /space, /app, /item/app/{id}">
                          ℹ️
                        </span>
                      </div>
                      <span className={getColorClass(general.used, general.limit)}>
                        {general.used}/{general.limit}
                        {general.resetInSeconds !== null && general.resetInSeconds > 0 && (
                          <span className="text-xs ml-2 text-gray-600">(Reset: {Math.ceil(general.resetInSeconds / 60)}m)</span>
                        )}
                      </span>
                    </div>

                    {/* Peticiones Pesadas (POST/PUT/DELETE) */}
                    <div className="flex items-center justify-between p-2 bg-white rounded">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">🔴 Peticiones Pesadas:</span>
                        <span className="text-xs text-gray-500 cursor-help" title="POST/PUT/DELETE: /oauth/token, /item (crear/modificar), y endpoints específicos">
                          ℹ️
                        </span>
                      </div>
                      <span className={getColorClass(rateLimited.used, rateLimited.limit)}>
                        {rateLimited.used}/{rateLimited.limit}
                        {rateLimited.resetInSeconds !== null && rateLimited.resetInSeconds > 0 && (
                          <span className="text-xs ml-2 text-gray-600">(Reset: {Math.ceil(rateLimited.resetInSeconds / 60)}m)</span>
                        )}
                      </span>
                    </div>

                    {/* Total Combinado */}
                    <div className="flex items-center justify-between p-3 bg-gradient-to-r from-blue-100 to-blue-50 rounded border-2 border-blue-300">
                      <span className="font-bold text-blue-900">📊 TOTAL COMBINADO:</span>
                      <span className={`text-lg ${getColorClass(total, totalLimit)}`}>
                        {total}/{totalLimit}
                        <span className="text-xs ml-2 text-gray-700">
                          ({totalRemaining} restantes)
                        </span>
                      </span>
                    </div>
                  </>
                )
              })()}
              
              {/* Explicación */}
              <div className="mt-3 p-3 bg-white rounded border border-blue-200">
                <p className="text-xs text-gray-700 leading-relaxed">
                  <strong>💡 Explicación:</strong> Podio limita a <strong>5,000 peticiones/hora</strong>. 
                  Las <span className="text-green-700 font-semibold">peticiones normales</span> (GET) son consultas de lectura. 
                  Las <span className="text-red-700 font-semibold">peticiones pesadas</span> (POST/PUT/DELETE) son operaciones de escritura 
                  y autenticación que consumen más recursos.
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  ⏱️ Actualizado cada 2 segundos desde la base de datos local.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Card para backup incompleto detectado */}
        {incompleteBackup && !isBackupRunning && (
          <Card className="mb-6 bg-orange-50 border-orange-300 border-2">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center text-base text-orange-900">
                <AlertTriangle className="h-5 w-5 mr-2 text-orange-600" />
                ⚠️ Backup Interrumpido Detectado
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="text-sm text-orange-900">
                  <p className="font-medium mb-2">
                    Se detectó un backup incompleto del {new Date(incompleteBackup.scanDate).toLocaleString('es-ES')}
                  </p>
                  <div className="grid grid-cols-2 gap-2 mb-3 p-3 bg-white rounded border border-orange-200">
                    <div>
                      <span className="text-xs text-gray-600">Total archivos:</span>
                      <p className="font-bold text-orange-700">{incompleteBackup.stats.total}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-600">✅ Descargados:</span>
                      <p className="font-bold text-green-600">{incompleteBackup.stats.done}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-600">⏳ Pendientes:</span>
                      <p className="font-bold text-yellow-600">{incompleteBackup.stats.pending}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-600">❌ Con error:</span>
                      <p className="font-bold text-red-600">{incompleteBackup.stats.error}</p>
                    </div>
                  </div>
                  <div className="mb-3 p-3 bg-blue-50 rounded border border-blue-200">
                    <p className="text-xs text-blue-800">
                      💡 <strong>¿Qué significa esto?</strong> El backup anterior no terminó completamente. 
                      Puedes continuar desde donde se quedó sin tener que descargar los archivos que ya se completaron.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 pt-2 border-t border-orange-200">
                  <Button 
                    onClick={resumeBackupFromCheckpoint}
                    className="flex-1 bg-orange-600 hover:bg-orange-700"
                    disabled={!podioService}
                  >
                    <Download className="mr-2 h-4 w-4" />
                    Continuar Backup Interrumpido
                  </Button>
                  <Button 
                    variant="outline" 
                    onClick={discardIncompleteBackup}
                    className="border-orange-300 text-orange-900 hover:bg-orange-100"
                  >
                    <XCircle className="mr-2 h-4 w-4" />
                    Descartar
                  </Button>
                </div>
                <p className="text-xs text-gray-600 italic">
                  ⏱️ Los backups incompletos se detectan automáticamente si tienen menos de 48 horas.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Card para último escaneo */}
        {lastScan && (
          <Card className="mb-6 bg-green-50 border-green-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center text-base">
                <FileArchive className="h-5 w-5 mr-2 text-green-600" />
                Último Escaneo Guardado
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Fecha:</span>
                  <span className="text-sm">{new Date(lastScan.created_at_ms).toLocaleString('es-ES')}</span>
                </div>
                {lastScan.summary && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Organizaciones:</span>
                      <span className="text-sm font-semibold">{lastScan.summary.organizations || 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Espacios de trabajo:</span>
                      <span className="text-sm font-semibold">{lastScan.summary.workspaces || 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Apps:</span>
                      <span className="text-sm font-semibold">{lastScan.summary.applications || 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Items:</span>
                      <span className="text-sm font-semibold">{lastScan.summary.items || 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Archivos:</span>
                      <span className="text-sm font-semibold">{lastScan.summary.files || 0}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Tamaño Estimado:</span>
                      <span className="text-sm font-semibold text-purple-600">
                        {lastScan.summary.backupSize 
                          ? formatSizeGBorMB(lastScan.summary.backupSize) 
                          : '0.00 MB'}
                      </span>
                    </div>
                  </>
                )}
                <div className="flex items-center gap-2 pt-2 border-t">
                  <input
                    type="checkbox"
                    id="useLastScan"
                    checked={useLastScan}
                    onChange={(e) => {
                      const checked = e.target.checked
                      setUseLastScan(checked)
                      
                      // Si marca checkbox y hay lastScan, cargar stats
                      if (checked && lastScan && lastScan.summary) {
                        setStats({
                          apps: lastScan.summary.applications || 0,
                          items: lastScan.summary.items || 0,
                          workspaces: lastScan.summary.workspaces || 0,
                          files: lastScan.summary.files || 0,
                          backupSize: lastScan.summary.backupSize || 0,
                          successfulBackups: stats.successfulBackups,
                          backupWarnings: stats.backupWarnings,
                          downloadedFiles: 0,
                          downloadedBytes: 0
                        })
                        setBackupStatus("ready")
                        setStatusMessage("✅ Listo para respaldar con datos del último escaneo")
                        
                        console.log("📊 Stats cargados desde último escaneo:", lastScan.summary)
                      } else if (!checked) {
                        // Si desmarca, limpiar stats
                        setStats({
                          apps: 0,
                          items: 0,
                          workspaces: 0,
                          files: 0,
                          backupSize: 0,
                          successfulBackups: 0,
                          backupWarnings: 0,
                          downloadedFiles: 0,
                          downloadedBytes: 0
                        })
                        setBackupStatus("idle")
                        setStatusMessage("Esperando...")
                      }
                    }}
                    className="h-4 w-4"
                  />
                  <label htmlFor="useLastScan" className="text-sm font-medium cursor-pointer">
                    Usar este escaneo para el próximo backup (no escanear de nuevo)
                  </label>
                </div>
                {useLastScan && (
                  <p className="text-xs text-blue-600 mt-1">
                    ℹ️ El backup usará los datos guardados sin re-escanear Podio.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stats Overview con iconos - UI CONDICIONAL según fase */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center">
              <Activity className="h-5 w-5 mr-2" />
              {backupStatus === "scanning" && "📊 Escaneo en Progreso"}
              {backupStatus === "downloading" && "📥 Descarga en Progreso"}
              {(backupStatus === "idle" || backupStatus === "cancelled" || backupStatus === "error") && "📊 Estadísticas"}
              {backupStatus === "ready" && "✅ Escaneo Completado"}
              {backupStatus === "completed" && "✅ Backup Completado"}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {/* Mostrar SIEMPRE durante escaneo y después */}
              {/* Mostrar organizaciones solo si hay datos */}
              {(counts.organizations > 0 || backupStatus === "scanning") && (
                <StatCard
                  icon={<FolderIcon className="h-6 w-6 text-purple-500" />}
                  title="Organizaciones"
                  value={counts.organizations || 0}
                  bgColor="bg-purple-50"
                />
              )}
              <StatCard
                icon={<FolderIcon className="h-6 w-6 text-blue-500" />}
                title="Espacios"
                value={counts.workspaces || stats.workspaces || 0}
                bgColor="bg-blue-50"
              />
              <StatCard
                icon={<FileTextIcon className="h-6 w-6 text-indigo-500" />}
                title="Apps"
                value={counts.applications || stats.apps || 0}
                bgColor="bg-indigo-50"
              />
              <StatCard
                icon={<FileIcon className="h-6 w-6 text-green-500" />}
                title="Items"
                value={counts.items || stats.items || 0}
                bgColor="bg-green-50"
              />
              
              {/* Mostrar archivos siempre que haya datos o durante escaneo */}
              {(backupStatus === "scanning" || backupStatus === "downloading" || backupStatus === "completed" || backupStatus === "ready" || counts.files > 0 || stats.files > 0) && (
                <StatCard
                  icon={<FileArchive className="h-6 w-6 text-orange-500" />}
                  title="Archivos"
                  value={counts.files || stats.files || 0}
                  bgColor="bg-orange-50"
                />
              )}
              
              {/* SOLO mostrar durante descarga o cuando hay datos de descarga */}
              {(backupStatus === "downloading" || backupStatus === "completed" || stats.downloadedBytes > 0) && (
                <>
                  <StatCard
                    icon={<Download className="h-6 w-6 text-purple-500" />}
                    title="Descargados"
                    value={stats.downloadedFiles}
                    bgColor="bg-purple-50"
                  />
                  <StatCard
                    icon={<Download className="h-6 w-6 text-blue-500" />}
                    title="Descargado"
                    value={formatBytes(stats.downloadedBytes)}
                    bgColor="bg-blue-50"
                  />
                </>
              )}
              
              {/* Solo mostrar tamaño estimado si está disponible */}
              {stats.backupSize > 0 && (
                <StatCard
                  icon={<HardDrive className="h-6 w-6 text-purple-600" />}
                  title="Tamaño Total"
                  value={formatSizeGBorMB(stats.backupSize)}
                  bgColor="bg-purple-50"
                />
              )}
            </div>
          </CardContent>
        </Card>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Respaldo</span>
                {/* Badge de estado visual */}
                {backupStatus === "idle" && (
                  <Badge variant="outline" className="ml-2">Esperando</Badge>
                )}
                {backupStatus === "scanning" && (
                  <Badge className="ml-2 bg-blue-500">Escaneando...</Badge>
                )}
                {backupStatus === "ready" && (
                  <Badge className="ml-2 bg-green-500">Listo</Badge>
                )}
                {backupStatus === "downloading" && (
                  <Badge className="ml-2 bg-purple-500">Descargando...</Badge>
                )}
                {backupStatus === "paused" && (
                  <Badge className="ml-2 bg-yellow-500">En Pausa</Badge>
                )}
                {backupStatus === "cancelled" && (
                  <Badge className="ml-2 bg-gray-500">Cancelado</Badge>
                )}
                {backupStatus === "completed" && (
                  <Badge className="ml-2 bg-green-600">Completado</Badge>
                )}
                {backupStatus === "error" && (
                  <Badge className="ml-2 bg-red-500">Error</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* PROGRESS BAR MODERNO estilo VS Code/npm */}
              <div className="space-y-3">
                {/* Barra de progreso principal con animación */}
                <div className="relative w-full h-4 bg-gray-200 rounded-full overflow-hidden shadow-inner">
                  <div 
                    className="absolute top-0 left-0 h-full bg-gradient-to-r from-blue-500 via-blue-600 to-blue-500 transition-all duration-300 ease-out rounded-full"
                    style={{ width: `${progress}%` }}
                  >
                    {/* Animación shimmer para indicar actividad */}
                    {isBackupRunning && (
                      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent animate-shimmer" />
                    )}
                  </div>
                </div>
                
                {/* Línea de status detallado */}
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-700">
                      {backupStatus === "scanning" && `🔍 Escaneando: ${counts.applications || stats.apps} apps, ${counts.items || stats.items} items, ${counts.files || stats.files} archivos`}
                      {backupStatus === "downloading" && `📥 Descargando: ${stats.downloadedFiles}/${stats.files} archivos (${stats.items} items totales)`}
                      {backupStatus === "idle" && "⏸️ Esperando..."}
                      {backupStatus === "ready" && `✅ Listo para respaldar: ${stats.items} items, ${stats.files} archivos`}
                      {backupStatus === "cancelled" && "⛔ Cancelado"}
                      {backupStatus === "completed" && "✅ Completado"}
                      {backupStatus === "error" && "❌ Error"}
                    </p>
                    {/* Mini-indicadores de sub-progreso (estilo npm) */}
                    {backupStatus === "scanning" && (
                      <div className="flex gap-3 text-xs text-gray-500 mt-1 font-mono">
                        <span>├─ {counts.organizations || 0} orgs</span>
                        <span>├─ {counts.workspaces || stats.workspaces || 0} espacios</span>
                        <span>├─ {counts.applications || stats.apps || 0} apps</span>
                        <span>├─ {counts.items || stats.items || 0} items</span>
                        <span>├─ {counts.files || stats.files || 0} archivos</span>
                        <span>└─ {stats.backupSize ? `${stats.backupSize.toFixed(2)} GB` : '0 GB'}</span>
                      </div>
                    )}
                    {backupStatus === "downloading" && (
                      <div className="flex gap-3 text-xs text-gray-500 mt-1 font-mono">
                        <span>├─ {stats.downloadedFiles}/{stats.files} archivos</span>
                        <span>├─ {stats.items} items</span>
                        <span>├─ {formatBytes(stats.downloadedBytes)} descargados</span>
                        <span>└─ {stats.backupSize ? `${stats.backupSize.toFixed(2)} GB total` : '0 GB'}</span>
                      </div>
                    )}
                    {backupStatus === "ready" && (
                      <div className="flex gap-3 text-xs text-gray-500 mt-1 font-mono">
                        <span>├─ {stats.apps} apps</span>
                        <span>├─ {stats.items} items</span>
                        <span>├─ {stats.files} archivos</span>
                        <span>└─ {stats.backupSize ? `${stats.backupSize.toFixed(2)} GB` : '0 GB'}</span>
                      </div>
                    )}
                  </div>
                  <span className="text-lg font-bold text-blue-600 ml-4">
                    {progress.toFixed(1)}%
                  </span>
                </div>
                
                {/* Status message detallado */}
                <p className="text-sm text-gray-600 italic">{statusMessage}</p>
                
                {/* Indicador de progreso por apps/items si disponible */}
                {(planned.items > 0 || planned.apps > 0) && (
                  <div className="text-xs text-gray-500 bg-gray-50 p-2 rounded">
                    <span className="font-semibold">Progreso detallado:</span> Apps: {processed.apps}/{planned.apps} · Items: {processed.items}/{planned.items}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium">Aplicaciones</p>
                  <p className="text-2xl font-bold">{stats.apps}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Elementos</p>
                  <p className="text-2xl font-bold">{stats.items}</p>
                </div>
                {/* SOLO mostrar "Archivos" cuando tengamos datos reales */}
                {(backupStatus === "downloading" || backupStatus === "completed" || backupStatus === "ready" || stats.files > 0) && (
                  <div>
                    <p className="text-sm font-medium">Archivos</p>
                    <p className="text-2xl font-bold">{stats.files}</p>
                  </div>
                )}
                {/* SOLO mostrar "Descargados" durante o después de descarga */}
                {(backupStatus === "downloading" || backupStatus === "completed" || stats.downloadedFiles > 0) && (
                  <div>
                    <p className="text-sm font-medium">Descargados</p>
                    <p className="text-2xl font-bold">{stats.downloadedFiles}</p>
                    {stats.downloadedBytes > 0 && (
                      <p className="text-xs text-gray-500 mt-1">
                        {formatBytes(stats.downloadedBytes)}
                      </p>
                    )}
                  </div>
                )}
                {stats.backupSize > 0 && (
                  <div className="col-span-2">
                    <p className="text-sm font-medium">Tamaño Estimado</p>
                    <p className="text-2xl font-bold text-purple-600">{formatSizeGBorMB(stats.backupSize)}</p>
                  </div>
                )}
              </div>
              {backupFolder && (
                <div className="mb-2 text-xs text-blue-700">Carpeta seleccionada: {backupFolder}</div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
                  <DialogTrigger asChild>
                    <Button className="flex-1" variant="outline">
                      <Check className="mr-2 h-4 w-4" />
                      Escanear
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Confirmar Escaneo</DialogTitle>
                      <DialogDescription>
                        ¿Estás seguro de que deseas iniciar un escaneo ahora? Se analizará la estructura de Podio para determinar qué se respaldará.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setShowConfirmDialog(false)}>
                        Cancelar
                      </Button>
                      <Button onClick={scanBackup}>Iniciar Escaneo</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                {isPausedByRateLimit && rateLimit.active && (
                  <div className="mb-4 p-3 bg-yellow-100 border border-yellow-300 rounded text-yellow-800 flex flex-col items-center">
                    <span className="font-bold">Límite de tasa de Podio alcanzado.</span>
                    <span>Esperando {Math.floor(rateLimit.remainingSeconds / 60)}:{(rateLimit.remainingSeconds % 60).toString().padStart(2, "0")} minutos para continuar automáticamente.</span>
                    <div className="flex gap-2 mt-2">
                      <Button className="mt-2" onClick={continueBackup} disabled={rateLimit.remainingSeconds > 0 || isBackupRunning}>
                        Continuar respaldo
                      </Button>
                      <Button 
                        variant="destructive" 
                        className="mt-2" 
                        onClick={async () => {
                          if (!podioService) return
                          
                          console.log("🔄 FORZAR REINTENTO: Limpiando rate limit y continuando...")
                          
                          const result = await podioService.forceRetryAfterRateLimit()
                          if (result.success) {
                            // Limpiar UI inmediatamente (esto detiene el contador)
                            setIsPausedByRateLimit(false)
                            setRateLimit({ active: false, remainingSeconds: 0, type: "none" })
                            setStatusMessage("🔄 Reintento forzado - Continuando...")
                            
                            console.log("✅ Rate limit limpiado en memoria y BD")
                            console.log("⚠️ ADVERTENCIA: Si Podio responde 429/420, se volverá a aplicar automáticamente")
                            
                            // El intervalo que corre cada segundo (línea 257) ahora leerá active: false
                            // y solo se volverá a activar si el servidor responde 429/420 en la próxima petición
                          } else {
                            console.error("❌ Error al forzar reintento:", result.message)
                            alert("Error al forzar reintento: " + result.message)
                          }
                        }} 
                        disabled={false}
                        title="⚠️ ADVERTENCIA: Esto limpia el rate limit de memoria y BD. Las peticiones se reintentarán inmediatamente. Si Podio responde 429/420, se volverá a aplicar."
                      >
                        🔄 Reintentar Ahora (Forzar)
                      </Button>
                    </div>
                  </div>
                )}
                <Button 
                  onClick={isPausedByRateLimit ? continueBackup : startBackup} 
                  disabled={(stats.apps === 0 && !useLastScan && !lastScan) || isBackupRunning} 
                  className="flex-1"
                  title={useLastScan || lastScan ? "Usar datos del escaneo guardado" : "Requiere escanear primero"}
                >
                  <Download className="mr-2 h-4 w-4" />
                  {isPausedByRateLimit ? "Continuar Respaldo" : "Iniciar Respaldo"}
                </Button>
              </div>
              
              {/* Botón Cancelar - visible solo cuando hay un proceso activo */}
              {isBackupRunning && (
                <Button 
                  variant="destructive" 
                  onClick={handleCancelBackup}
                  className="w-full mt-2"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  Cancelar {backupStatus === "scanning" ? "Escaneo" : "Backup"}
                </Button>
              )}
            </CardContent>
          </Card>
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Estadísticas</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium">Tamaño Estimado</p>
                  <p className="text-2xl font-bold text-purple-600">
                    {(stats.backupSize > 0 || backupStatus !== 'scanning') ? formatSizeGBorMB(stats.backupSize) : <span className="text-gray-300">--</span>}
                  </p>
                  {stats.files > 0 && (
                    <p className="text-xs text-gray-500 mt-1">
                      {stats.files} archivos
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium">Descargado</p>
                  <p className="text-2xl font-bold text-blue-600">
                    {(stats.downloadedBytes > 0 || backupStatus === 'downloading' || backupStatus === 'completed') ? formatBytes(stats.downloadedBytes) : <span className="text-gray-300">--</span>}
                  </p>
                  {stats.downloadedFiles > 0 && (
                    <p className="text-xs text-gray-500 mt-1">
                      {stats.downloadedFiles} archivos descargados
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium">Respaldos Exitosos</p>
                  <p className="text-2xl font-bold">{stats.successfulBackups}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Advertencias</p>
                  <p className="text-2xl font-bold">{stats.backupWarnings}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
        <div className="mt-8">
          <Card>
            <CardHeader>
              <CardTitle>Logs</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-64 overflow-y-auto border rounded-md p-4">
                {renderLogs()}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tabla de últimos 10 backups */}
        <div className="mt-10">
          <Card>
            <CardHeader>
              <CardTitle>Últimos 10 respaldos</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm text-gray-800">
                  <thead>
                    <tr className="bg-gray-100">
                      <th className="px-3 py-2 font-semibold">Fecha</th>
                      <th className="px-3 py-2 font-semibold">Estado</th>
                      <th className="px-3 py-2 font-semibold">Org.</th>
                      <th className="px-3 py-2 font-semibold">Espacios</th>
                      <th className="px-3 py-2 font-semibold">Apps</th>
                      <th className="px-3 py-2 font-semibold">Items</th>
                      <th className="px-3 py-2 font-semibold">Archivos</th>
                      <th className="px-3 py-2 font-semibold">Tamaño</th>
                      <th className="px-3 py-2 font-semibold">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backupHistory.slice(0, 10).map((item, idx) => (
                      <tr key={idx} className="border-b hover:bg-gray-50 transition">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="block font-medium">
                            {item.fecha?.start ? new Date(item.fecha.start).toLocaleString() : "-"}
                          </span>
                          {item.fecha?.end && (
                            <span className="block text-xs text-gray-500">
                              Fin: {new Date(item.fecha.end).toLocaleString()}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold ${
                            (typeof item.estado === 'object' ? item.estado.text : item.estado) === "Completado"
                              ? "bg-green-100 text-green-700 border border-green-300"
                              : (typeof item.estado === 'object' ? item.estado.text : item.estado) === "Error"
                              ? "bg-red-100 text-red-700 border border-red-300"
                              : "bg-yellow-100 text-yellow-700 border border-yellow-300"
                          }`}>
                            {typeof item.estado === 'object' ? item.estado.text : item.estado}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center">{safeValue(item.organizaciones)}</td>
                        <td className="px-3 py-2 text-center">{safeValue(item.espaciosDeTrabajo)}</td>
                        <td className="px-3 py-2 text-center">{safeValue(item.aplicaciones)}</td>
                        <td className="px-3 py-2 text-center">{safeValue(item.items)}</td>
                        <td className="px-3 py-2 text-center">{safeValue(item.archivos)}</td>
                        <td className="px-3 py-2 text-center font-mono">
                          {typeof item.tamanoEnGb === 'object' ? item.tamanoEnGb.text : String(item.tamanoEnGb).replace(/<[^>]+>/g, '')}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => loadBackupDetails(item)}
                            className="h-8 w-8 p-0"
                            title="Ver detalles del backup"
                          >
                            <Eye className="h-4 w-4 text-blue-600" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {backupHistory.length === 0 && (
                  <div className="text-gray-400 text-center py-6">No hay respaldos previos registrados</div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Modal de detalles del backup */}
        <Dialog open={showBackupDetails} onOpenChange={setShowBackupDetails}>
          <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle className="text-xl">
                Detalles del Backup: {selectedBackupDetails?.titulo || 'Sin título'}
              </DialogTitle>
              <DialogDescription>
                Información completa de lo que se escaneó y guardó en este backup
              </DialogDescription>
            </DialogHeader>
            
            <ScrollArea className="flex-1 pr-4">
              {backupDetailsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
                  <span className="ml-3">Cargando detalles...</span>
                </div>
              ) : backupDetailsData ? (
                <div className="space-y-6">
                  {/* Información general del backup */}
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Información General</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <p className="text-sm text-gray-500">Fecha de inicio</p>
                          <p className="font-semibold">
                            {selectedBackupDetails?.fecha?.start 
                              ? new Date(selectedBackupDetails.fecha.start).toLocaleString('es-ES')
                              : '-'}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-500">Estado</p>
                          <p className="font-semibold">
                            {typeof selectedBackupDetails?.estado === 'object' 
                              ? selectedBackupDetails.estado.text 
                              : selectedBackupDetails?.estado || '-'}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-500">Organizaciones</p>
                          <p className="font-semibold">{selectedBackupDetails?.organizaciones || 0}</p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-500">Tamaño</p>
                          <p className="font-semibold">
                            {typeof selectedBackupDetails?.tamanoEnGb === 'object' 
                              ? selectedBackupDetails.tamanoEnGb.text 
                              : String(selectedBackupDetails?.tamanoEnGb || '0 GB').replace(/<[^>]+>/g, '')}
                          </p>
                        </div>
                      </div>
                      {backupDetailsData.scan?.summary && (
                        <div className="mt-4 pt-4 border-t">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                              <p className="text-sm text-gray-500">Espacios de trabajo</p>
                              <p className="font-semibold">{backupDetailsData.scan.summary.workspaces || 0}</p>
                            </div>
                            <div>
                              <p className="text-sm text-gray-500">Aplicaciones</p>
                              <p className="font-semibold">{backupDetailsData.scan.summary.applications || 0}</p>
                            </div>
                            <div>
                              <p className="text-sm text-gray-500">Items</p>
                              <p className="font-semibold">{backupDetailsData.scan.summary.items || 0}</p>
                            </div>
                            <div>
                              <p className="text-sm text-gray-500">Archivos</p>
                              <p className="font-semibold">{backupDetailsData.scan.summary.files || 0}</p>
                            </div>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Lista de aplicaciones */}
                  {backupDetailsData.apps && backupDetailsData.apps.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">
                          Aplicaciones Escaneadas ({backupDetailsData.apps.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ScrollArea className="h-64">
                          <table className="min-w-full text-sm">
                            <thead>
                              <tr className="bg-gray-50 border-b">
                                <th className="px-3 py-2 text-left font-semibold">Organización</th>
                                <th className="px-3 py-2 text-left font-semibold">Espacio</th>
                                <th className="px-3 py-2 text-left font-semibold">Aplicación</th>
                                <th className="px-3 py-2 text-left font-semibold">Ruta de carpeta</th>
                              </tr>
                            </thead>
                            <tbody>
                              {backupDetailsData.apps.map((app: any, idx: number) => (
                                <tr key={idx} className="border-b hover:bg-gray-50">
                                  <td className="px-3 py-2">{app.org_name}</td>
                                  <td className="px-3 py-2">{app.space_name}</td>
                                  <td className="px-3 py-2 font-medium">{app.app_name}</td>
                                  <td className="px-3 py-2 text-xs text-gray-600 font-mono">
                                    {app.folder_path}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </ScrollArea>
                      </CardContent>
                    </Card>
                  )}

                  {/* Lista de archivos */}
                  {backupDetailsData.files && backupDetailsData.files.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">
                          Archivos Escaneados ({backupDetailsData.files.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ScrollArea className="h-96">
                          <table className="min-w-full text-sm">
                            <thead>
                              <tr className="bg-gray-50 border-b">
                                <th className="px-3 py-2 text-left font-semibold">Nombre</th>
                                <th className="px-3 py-2 text-left font-semibold">Tamaño</th>
                                <th className="px-3 py-2 text-left font-semibold">Tipo</th>
                                <th className="px-3 py-2 text-left font-semibold">Ruta de carpeta</th>
                              </tr>
                            </thead>
                            <tbody>
                              {backupDetailsData.files.map((file: any, idx: number) => (
                                <tr key={idx} className="border-b hover:bg-gray-50">
                                  <td className="px-3 py-2 font-medium">{file.name}</td>
                                  <td className="px-3 py-2">
                                    {file.size ? formatBytes(file.size) : '-'}
                                  </td>
                                  <td className="px-3 py-2 text-xs text-gray-600">
                                    {file.mimetype || '-'}
                                  </td>
                                  <td className="px-3 py-2 text-xs text-gray-600 font-mono">
                                    {file.folder_path}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </ScrollArea>
                      </CardContent>
                    </Card>
                  )}

                  {(!backupDetailsData.scan || (backupDetailsData.apps.length === 0 && backupDetailsData.files.length === 0)) && (
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        <div className="space-y-2">
                          <p>
                            No se encontró información detallada en la base de datos local para este backup.
                          </p>
                          <p className="text-sm text-gray-600">
                            <strong>Item ID buscado:</strong> {selectedBackupDetails?.item_id || 'N/A'}
                          </p>
                          <p className="text-xs text-gray-500">
                            Esto puede ocurrir si:
                            <ul className="list-disc list-inside mt-1">
                              <li>El backup se realizó antes de implementar el guardado en BD</li>
                              <li>El scan no se guardó correctamente con el podio_backup_item_id</li>
                              <li>El item_id del historial no coincide con el podio_backup_item_id guardado</li>
                            </ul>
                          </p>
                          <p className="text-xs text-blue-600 mt-2">
                            💡 <strong>Nota:</strong> Los backups futuros deberían mostrar la información completa. 
                            Revisa la consola de Electron para ver logs de debug.
                          </p>
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              ) : (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    No se pudo cargar la información del backup.
                  </AlertDescription>
                </Alert>
              )}
            </ScrollArea>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowBackupDetails(false)}>
                Cerrar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </main>
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 Bytes"
  const k = 1024
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

function getLogColor(level: string) {
  if (level === "error") return "text-red-600"
  if (level === "warning") return "text-amber-600"
  if (level === "success") return "text-green-600"
  return "text-gray-600"
}

function formatSizeGBorMB(gb: number) {
  if (gb < 1) {
    return (gb * 1024).toFixed(2) + ' MB';
  }
  return gb.toFixed(2) + ' GB';
}

// Componente StatCard para mostrar estadísticas con iconos
type StatCardProps = {
  icon: React.ReactNode;
  title: string;
  value: string | number;
  bgColor: string;
};

function StatCard({ icon, title, value, bgColor }: StatCardProps) {
  return (
    <div className={`${bgColor} rounded-lg p-4 flex items-center`}>
      <div className="mr-4">{icon}</div>
      <div>
        <h3 className="text-sm font-medium text-gray-500">{title}</h3>
        <p className="text-2xl font-bold">{value}</p>
      </div>
    </div>
  )
} 