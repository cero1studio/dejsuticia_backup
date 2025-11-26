"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
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
} from "lucide-react"
import { PodioBackupService } from "@/lib/podio-service"
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

// Función de utilidad para asegurar que los valores sean seguros para renderizar
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

export default function Dashboard() {
  const router = useRouter()
  const [progress, setProgress] = useState(0)
  const [isBackupRunning, setIsBackupRunning] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState("idle") // idle, connecting, connected, error
  const [connectionError, setConnectionError] = useState("")
  const [backupStatus, setBackupStatus] = useState("idle") // idle, scanning, ready, downloading, completed, error
  const [backupError, setBackupError] = useState("")
  const [podioService, setPodioService] = useState<PodioBackupService | null>(null)
  const [statusMessage, setStatusMessage] = useState("")
  const [logs, setLogs] = useState<any[]>([])
  const logsEndRef = useRef<HTMLDivElement>(null)

  // Nuevos estados para el rate limit
  const [isRateLimited, setIsRateLimited] = useState(false)
  const [rateLimitCountdown, setRateLimitCountdown] = useState(0)
  const [rateLimitType, setRateLimitType] = useState("minute")
  const rateLimitIntervalRef = useRef<NodeJS.Timeout | null>(null)

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

  const [backupHistory, setBackupHistory] = useState<any[]>([])

  useEffect(() => {
    // Verificar si hay credenciales almacenadas
    const credentialsStr = sessionStorage.getItem("podio_credentials")
    if (!credentialsStr) {
      router.push("/")
      return
    }

    const credentials = JSON.parse(credentialsStr)

    // Inicializar el servicio de Podio
    const service = new PodioBackupService()
    setPodioService(service)

    // Cargar historial de respaldos desde Podio
    const loadBackupHistory = async () => {
      try {
        setConnectionStatus("connecting")
        setStatusMessage("Conectando con Podio...")

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

          // Cargar historial de respaldos
          const backupAppId = Number.parseInt(apiCredentials.backupAppId || "30233695")
          const history = await service.getBackupHistory(backupAppId)
          setBackupHistory(history)

          // Actualizar estadísticas
          const stats = service.getBackupStats()
          setStats(stats)

          // Obtener logs
          setLogs(service.getLogs())
        } else {
          setConnectionStatus("error")
          setConnectionError("No se pudo conectar con Podio. Verifica tus credenciales.")
        }
      } catch (error) {
        setConnectionStatus("error")
        setConnectionError("Error al conectar con Podio: " + (error instanceof Error ? error.message : String(error)))
      }
    }

    loadBackupHistory()
  }, [router])

  const handleLogout = () => {
    sessionStorage.removeItem("podio_credentials")
    router.push("/")
  }

  // En la función scanBackup, mejoramos la detección del error de rate limit
  const scanBackup = async () => {
    if (!podioService || connectionStatus !== "connected") return

    setShowConfirmDialog(false)
    setBackupStatus("scanning")
    setProgress(0)
    setIsBackupRunning(true)
    setStatusMessage("Escaneando datos de Podio...")
    setBackupError("")

    // Reiniciar estadísticas para evitar acumulación
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

    try {
      // Verificar si hay un rate limit activo
      const rateLimitInfo = podioService.getRateLimitInfo()
      if (rateLimitInfo.active) {
        handleRateLimit(rateLimitInfo.remainingSeconds, rateLimitInfo.type)
        return
      }

      // Escanear lo que se va a respaldar
      await podioService.scanBackup(
        {
          organizations: true,
          workspaces: true,
          applications: true,
          items: true,
          files: true,
        },
        (data) => {
          setProgress(data.progress)
          setStats(data.stats)
          setStatusMessage(data.status)
          setLogs(data.logs)
        },
      )

      setBackupStatus("ready")
      setStatusMessage("Escaneo completado. Listo para respaldar.")
    } catch (error) {
      // Verificar si es un error de rate limit
      if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
        const parts = error.message.split(":")
        const waitTime = Number.parseInt(parts[1], 10) || 60
        const limitType = parts[2] || "minute"
        // Agregar el mensaje de error a los logs
        setLogs((prevLogs) => [
          ...prevLogs,
          {
            level: "error",
            message: `⚠️ LÍMITE DE TASA DE PODIO ALCANZADO (${limitType}). Se esperará ${waitTime} segundos antes de reintentar automáticamente.`,
            timestamp: new Date(),
          },
          {
            level: "error",
            message: `Error durante el escaneo: ${error.message}`,
            timestamp: new Date(),
          },
        ])
        handleRateLimit(waitTime, limitType)
      } else {
        setBackupStatus("error")
        setBackupError("Error al escanear: " + (error instanceof Error ? error.message : String(error)))
        setIsBackupRunning(false)
        // Agregar el error a los logs
        setLogs((prevLogs) => [
          ...prevLogs,
          {
            level: "error",
            message: `Error al escanear: ${error instanceof Error ? error.message : String(error)}`,
            timestamp: new Date(),
          },
        ])
      }
    } finally {
      if (!isRateLimited) {
        setIsBackupRunning(false)
      }
    }
  }

  // En la función startBackup, mejoramos la detección del error de rate limit
  const startBackup = async () => {
    if (!podioService || backupStatus !== "ready") return

    setIsBackupRunning(true)
    setProgress(0)
    setStatusMessage("Iniciando respaldo...")
    setBackupStatus("downloading")
    setBackupError("")

    try {
      // Verificar si hay un rate limit activo
      const rateLimitInfo = podioService.getRateLimitInfo()
      if (rateLimitInfo.active) {
        handleRateLimit(rateLimitInfo.remainingSeconds, rateLimitInfo.type)
        return
      }

      // Realizar el respaldo
      await podioService.performBackup(
        {
          organizations: true,
          workspaces: true,
          applications: true,
          items: true,
          files: true,
        },
        (data) => {
          setProgress(data.progress)
          setStats(data.stats)
          setStatusMessage(data.status)
          setLogs(data.logs)
        },
      )

      // Actualizar historial de respaldos
      const backupAppId = Number.parseInt(process.env.NEXT_PUBLIC_PODIO_BACKUP_APP_ID || "30233695")
      const history = await podioService.getBackupHistory(backupAppId)
      setBackupHistory(history)

      setBackupStatus("completed")
      setStatusMessage("¡Respaldo completado con éxito!")
    } catch (error) {
      // Verificar si es un error de rate limit
      if (error instanceof Error && error.message.startsWith("RATE_LIMIT_ERROR:")) {
        const parts = error.message.split(":")
        const waitTime = Number.parseInt(parts[1], 10) || 60
        const limitType = parts[2] || "minute"
        // Agregar el mensaje de error a los logs
        setLogs((prevLogs) => [
          ...prevLogs,
          {
            level: "error",
            message: `⚠️ LÍMITE DE TASA DE PODIO ALCANZADO (${limitType}). Se esperará ${waitTime} segundos antes de reintentar automáticamente.`,
            timestamp: new Date(),
          },
          {
            level: "error",
            message: `Error durante el respaldo: ${error.message}`,
            timestamp: new Date(),
          },
        ])
        handleRateLimit(waitTime, limitType)
      } else {
        setBackupStatus("error")
        setBackupError("Error al realizar el respaldo: " + (error instanceof Error ? error.message : String(error)))
        setIsBackupRunning(false)
        // Agregar el error a los logs
        setLogs((prevLogs) => [
          ...prevLogs,
          {
            level: "error",
            message: `Error al realizar el respaldo: ${error instanceof Error ? error.message : String(error)}`,
            timestamp: new Date(),
          },
        ])
      }
    } finally {
      if (!isRateLimited) {
        setIsBackupRunning(false)
      }
    }
  }

  // Función centralizada para manejar el rate limit
  const handleRateLimit = (waitTime: number, limitType = "minute") => {
    setIsRateLimited(true)
    setRateLimitCountdown(waitTime)
    setRateLimitType(limitType)
    setBackupStatus("rate_limited")
    setBackupError("LÍMITE DE TASA DE PODIO ALCANZADO")
    setStatusMessage(`Se reintentará automáticamente en ${formatTimeRemaining(waitTime)}`)

    // Iniciar el contador regresivo
    startRateLimitCountdown()
  }

  // Mejorar la función startRateLimitCountdown para actualizar el mensaje cada segundo
  const startRateLimitCountdown = () => {
    // Limpiar cualquier intervalo existente
    if (rateLimitIntervalRef.current) {
      clearInterval(rateLimitIntervalRef.current)
    }

    // Configurar el callback para cuando termine el rate limit
    if (podioService) {
      podioService.setRateLimitCallback(() => {
        stopRateLimitCountdown()
        setBackupError("")

        // Reintentar la operación según el estado actual
        if (backupStatus === "scanning" || backupStatus === "rate_limited") {
          scanBackup()
        } else if (backupStatus === "downloading") {
          startBackup()
        } else {
          setBackupStatus("idle")
          setIsBackupRunning(false)
        }
      })
    }

    // Iniciar el intervalo para actualizar el contador
    rateLimitIntervalRef.current = setInterval(() => {
      setRateLimitCountdown((prev) => {
        if (prev <= 1) {
          stopRateLimitCountdown()
          return 0
        }

        // Actualizar el mensaje de estado con cada tick
        setStatusMessage(`Se reintentará automáticamente en ${formatTimeRemaining(prev - 1)}`)

        return prev - 1
      })
    }, 1000)
  }

  // Función para detener el contador regresivo
  const stopRateLimitCountdown = () => {
    if (rateLimitIntervalRef.current) {
      clearInterval(rateLimitIntervalRef.current)
      rateLimitIntervalRef.current = null
    }

    setIsRateLimited(false)
    setRateLimitCountdown(0)
  }

  // Limpiar el intervalo cuando el componente se desmonte
  useEffect(() => {
    return () => {
      if (rateLimitIntervalRef.current) {
        clearInterval(rateLimitIntervalRef.current)
      }
    }
  }, [])

  // Función para obtener el color según el nivel de log
  const getLogColor = (level: string) => {
    switch (level) {
      case "error":
        return "text-red-600"
      case "warning":
        return "text-amber-600"
      case "success":
        return "text-green-600"
      default:
        return "text-blue-600"
    }
  }

  // Función para formatear bytes a un tamaño legible
  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }

  // Función para formatear segundos a formato hh:mm:ss
  const formatTimeRemaining = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }

  // Función para obtener el título del límite de tasa
  const getRateLimitTitle = (type: string) => {
    switch (type) {
      case "general":
        return "LÍMITE GENERAL (1,000 solicitudes/hora)"
      case "rateLimited":
        return "LÍMITE RATE-LIMITED (250 solicitudes/hora)"
      default:
        return "LÍMITE DE TASA DE PODIO ALCANZADO"
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Logo removido */}
            <h1 className="text-xl font-bold">Sistema de Respaldo Podio</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="h-4 w-4 mr-2" />
              Cerrar Sesión
            </Button>
            <Link href="/configuracion">
              <Button variant="ghost" size="sm">
                <Settings className="h-4 w-4 mr-2" />
                Configuración
              </Button>
            </Link>
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

        {/* Información de límites de tasa */}
        <Card className="mb-6 bg-blue-50">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center">
              <AlertTriangle className="h-5 w-5 mr-2 text-blue-600" />
              Límites de la API de Podio
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <p>La API de Podio ahora aplica un único límite de tasa para todas las operaciones:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <span className="font-medium">5,000 solicitudes por hora</span> — Límite unificado para todas las operaciones (lectura y descargas)
                </li>
              </ul>
              <p>El sistema respeta este límite y reintenta automáticamente cuando es necesario.</p>
            </div>
          </CardContent>
        </Card>

        {/* Información sobre la simulación de descarga */}
        <Card className="mb-6 bg-yellow-50">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center">
              <AlertTriangle className="h-5 w-5 mr-2 text-yellow-600" />
              Información sobre la descarga de archivos
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <p>
                Esta aplicación está funcionando en un entorno de navegador (Chrome en Windows) con las siguientes
                limitaciones:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <span className="font-medium">Restricciones de seguridad:</span> Los navegadores no pueden acceder
                  directamente al sistema de archivos por razones de seguridad.
                </li>
                <li>
                  <span className="font-medium">Simulación de descarga:</span> Los archivos no se descargan físicamente
                  a la ubicación especificada.
                </li>
                <li>
                  <span className="font-medium">Estructura de carpetas:</span> La estructura de carpetas se simula y no
                  se crea físicamente en el sistema de archivos.
                </li>
                <li>
                  <span className="font-medium">Archivos Excel:</span> Los archivos Excel se generan pero se descargan
                  individualmente.
                </li>
              </ul>
              <p>
                Para una implementación completa con descarga real de archivos a carpetas específicas, se recomienda:
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Convertir esta aplicación a una aplicación de escritorio usando Electron o similar.</li>
                <li>Implementar un servidor backend que maneje las descargas y la creación de carpetas.</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Stats Overview */}
        <Card className="mb-6">
          <CardContent className="p-6">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <StatCard
                icon={<FolderIcon className="h-6 w-6 text-blue-500" />}
                title="Espacios de trabajo"
                value={safeValue(stats.workspaces)}
                bgColor="bg-blue-50"
              />
              <StatCard
                icon={<FileTextIcon className="h-6 w-6 text-indigo-500" />}
                title="Apps"
                value={safeValue(stats.apps)}
                bgColor="bg-indigo-50"
              />
              <StatCard
                icon={<FileIcon className="h-6 w-6 text-green-500" />}
                title="Elementos"
                value={safeValue(stats.items)}
                bgColor="bg-green-50"
              />
              <StatCard
                icon={<FileArchive className="h-6 w-6 text-orange-500" />}
                title="Archivos"
                value={safeValue(stats.files)}
                bgColor="bg-orange-50"
              />
              <StatCard
                icon={<Download className="h-6 w-6 text-purple-500" />}
                title="Tamaño estimado"
                value={
                  typeof stats.backupSize === "number"
                    ? `${stats.backupSize.toFixed(2)} GB`
                    : safeValue(stats.backupSize)
                }
                bgColor="bg-purple-50"
              />
            </div>

            {backupStatus === "downloading" && (
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <StatCard
                  icon={<Download className="h-6 w-6 text-blue-500" />}
                  title="Archivos descargados"
                  value={`${safeValue(stats.downloadedFiles)} / ${safeValue(stats.files)}`}
                  bgColor="bg-blue-50"
                />
                <StatCard
                  icon={<FileArchive className="h-6 w-6 text-green-500" />}
                  title="Datos descargados"
                  value={safeValue(formatBytes(stats.downloadedBytes))}
                  bgColor="bg-green-50"
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Backup Progress */}
        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle>Progreso del Respaldo</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-sm mb-1">
                  <span>Progreso</span>
                  <span className="text-blue-500 font-medium">{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} className="h-2" />
              </div>
              <div className="text-sm text-blue-600">{statusMessage}</div>
              {stats.backupSize > 0 && (
                <div className="text-xs text-gray-600">
                  Tamaño estimado del respaldo:{" "}
                  <span className="font-medium">
                    {typeof stats.backupSize === "number"
                      ? `${stats.backupSize.toFixed(2)} GB`
                      : safeValue(stats.backupSize)}
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Logs */}
        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle>Registro de Actividad</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-40 w-full rounded border p-2">
              {logs.length === 0 ? (
                <div className="text-center py-4 text-gray-500">No hay registros de actividad</div>
              ) : (
                <div className="space-y-1">
                  {logs.map((log, index) => (
                    <div key={index} className="text-xs">
                      <span className="text-gray-500">[{new Date(log.timestamp).toLocaleTimeString()}]</span>{" "}
                      <span className={getLogColor(log.level)}>[{log.level.toUpperCase()}]</span>{" "}
                      <span>{safeValue(log.message)}</span>
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Backup Controls */}
        <Card className="mt-6">
          <CardContent className="p-6">
            <div className="flex flex-col md:flex-row gap-4 justify-between items-center">
              <div>
                <h3 className="text-lg font-medium">Controles de Respaldo</h3>
                <p className="text-gray-500">Administra las operaciones de respaldo de Podio</p>
              </div>
              <div className="flex gap-3 items-center">
                {/* Si hay rate limit, NO mostrar el botón principal, solo la alerta */}
                {!isRateLimited && (
                  <>
                    {backupStatus === "idle" && (
                      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
                        <DialogTrigger asChild>
                          <Button disabled={isBackupRunning || connectionStatus !== "connected"}>
                            <Download className="mr-2 h-4 w-4" />
                            Iniciar Respaldo
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Confirmar Respaldo</DialogTitle>
                            <DialogDescription>
                              ¿Estás seguro de que deseas iniciar un respaldo ahora? Primero se escaneará lo que se va a respaldar.
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
                    )}
                    {backupStatus === "scanning" && (
                      <Button disabled>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Escaneando...
                      </Button>
                    )}
                    {backupStatus === "downloading" && (
                      <Button disabled>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Descargando...
                      </Button>
                    )}
                    {backupStatus === "ready" && (
                      <Button onClick={startBackup} disabled={isBackupRunning}>
                        <Download className="mr-2 h-4 w-4" />
                        Descargar Respaldo
                      </Button>
                    )}
                    {backupStatus === "completed" && (
                      <Button variant="outline" onClick={() => setBackupStatus("idle")}> 
                        <Check className="mr-2 h-4 w-4 text-green-600" />
                        Respaldo Completado
                      </Button>
                    )}
                    {backupStatus === "error" && (
                      <Button variant="destructive" onClick={() => setBackupStatus("idle")}> 
                        <AlertCircle className="mr-2 h-4 w-4" />
                        Error en Respaldo
                      </Button>
                    )}
                  </>
                )}
                {/* Si hay rate limit, mostrar la alerta amarilla en el mismo espacio y alinear el botón */}
                {isRateLimited && (
                  <div className="flex flex-col w-full">
                    <div className="bg-yellow-100 border border-yellow-400 rounded p-4 flex flex-col items-start w-full">
                      <span className="font-bold text-yellow-800 mb-1">Límite de tasa de Podio alcanzado.</span>
                      <span className="text-yellow-900 mb-1">Esperando {formatTimeRemaining(rateLimitCountdown)} minutos para continuar automáticamente.</span>
                      <span className="text-yellow-900 mb-2">Puedes intentar continuar manualmente si lo deseas.</span>
                      <div className="flex gap-2 w-full">
                        <Button
                          variant="default"
                          onClick={() => {
                            stopRateLimitCountdown();
                            setBackupError("");
                            if (backupStatus === "scanning" || backupStatus === "rate_limited") {
                              scanBackup();
                            } else if (backupStatus === "downloading") {
                              startBackup();
                            } else {
                              setBackupStatus("idle");
                              setIsBackupRunning(false);
                            }
                          }}
                          className="mt-0"
                        >
                          Continuar respaldo
                        </Button>
                        <Button
                          variant="destructive"
                          onClick={async () => {
                            if (!podioService) return
                            const result = await podioService.forceRetryAfterRateLimit()
                            if (result.success) {
                              stopRateLimitCountdown();
                              setIsRateLimited(false);
                              setRateLimitCountdown(0);
                              setBackupError("");
                              alert(result.message + "\n\n⚠️ ADVERTENCIA: Si el rate limit de Podio aún está activo, las próximas peticiones pueden fallar. Usa esta opción bajo tu propio riesgo.")
                            } else {
                              alert("Error al forzar reintento: " + result.message)
                            }
                          }}
                          className="mt-0"
                          disabled={false}
                          title="⚠️ ADVERTENCIA: Esto omitirá la espera del rate limit. Podio puede rechazar las peticiones si el límite aún está activo."
                        >
                          🔄 Reintentar Ahora (Forzar)
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {backupError && backupStatus !== "rate_limited" && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{backupError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Backup History */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Historial de Respaldos</CardTitle>
          </CardHeader>
          <CardContent>
            {backupHistory.length === 0 ? (
              <div className="text-center py-6 text-gray-500">No hay respaldos registrados</div>
            ) : (
              <div className="space-y-4">
                {backupHistory.map((backup, index) => (
                  <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
                    <div className="flex items-center gap-3">
                      {backup.estado === "Completado" ? (
                        <CheckCircle className="h-5 w-5 text-green-500" />
                      ) : backup.estado === "Error" ? (
                        <AlertCircle className="h-5 w-5 text-red-500" />
                      ) : (
                        <Clock className="h-5 w-5 text-amber-500" />
                      )}
                      <div>
                        <p className="font-medium">{safeValue(backup.titulo)}</p>
                        <p className="text-sm text-gray-500">
                          {backup.fecha && backup.fecha.start
                            ? new Date(backup.fecha.start).toLocaleString()
                            : "Fecha no disponible"}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">{safeValue(backup.tamanoEnGb)}</p>
                      <p className="text-sm text-gray-500">{safeValue(backup.estado)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}

// Componente StatCard mejorado para manejar cualquier tipo de valor
type StatCardProps = {
  icon: React.ReactNode;
  title: string;
  value: string | number;
  bgColor: string;
};

function StatCard({ icon, title, value, bgColor }: StatCardProps) {
  // Asegurar que el valor es una cadena y no contiene HTML
  const safeValue = typeof value === "string" ? value.replace(/<\/?[^>]+(>|$)/g, "") : value

  return (
    <div className={`${bgColor} rounded-lg p-4 flex items-center`}>
      <div className="mr-4">{icon}</div>
      <div>
        <h3 className="text-sm font-medium text-gray-500">{title}</h3>
        <p className="text-2xl font-bold">{safeValue}</p>
      </div>
    </div>
  )
}
