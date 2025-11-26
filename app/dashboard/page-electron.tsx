"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArrowLeft, Download, Search, Settings, AlertTriangle, Pause, Play, XCircle } from "lucide-react"
import Link from "next/link"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { PodioBackupService } from "@/lib/podio-service-electron"
import { getPodioCredentials } from "@/lib/podio-credentials"
import type { ProgressCallback } from "@/lib/podio-service"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export default function Dashboard() {
  const router = useRouter()
  const [backupService, setBackupService] = useState<PodioBackupService | null>(null)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState("Esperando iniciar respaldo...")
  const [logs, setLogs] = useState<any[]>([])
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
  const [isScanning, setIsScanning] = useState(false)
  const [isBackingUp, setIsBackingUp] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [backupHistory, setBackupHistory] = useState<any[]>([])
  const [isElectron, setIsElectron] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [showCancelDialog, setShowCancelDialog] = useState(false)

  useEffect(() => {
    // Verificar si estamos en Electron
    if (typeof window !== "undefined" && window.electron) {
      setIsElectron(true)
    }

    // Verificar si hay credenciales almacenadas
    const credentials = sessionStorage.getItem("podio_credentials")
    if (!credentials) {
      router.push("/")
      return
    }

    // Inicializar el servicio de respaldo
    const service = new PodioBackupService()
    setBackupService(service)

    // Autenticar con las credenciales almacenadas
    const { username, password } = JSON.parse(credentials)
    
    // Obtener credenciales desde la función utilitaria centralizada
    const apiCredentials = getPodioCredentials()
    
    service
      .authenticate(
        apiCredentials.clientId,
        apiCredentials.clientSecret,
        username,
        password,
      )
      .then((success) => {
        if (success) {
          console.log("Autenticación exitosa")
          // Cargar historial de respaldos
          loadBackupHistory(service)
        } else {
          console.error("Error de autenticación")
          router.push("/")
        }
      })
      .catch((error) => {
        console.error("Error de autenticación:", error)
        router.push("/")
      })
  }, [router])

  const loadBackupHistory = async (service: PodioBackupService) => {
    try {
      const apiCredentials = getPodioCredentials()
      const backupAppId = Number.parseInt(apiCredentials.backupAppId || "30233695")
      const history = await service.getBackupHistory(backupAppId)
      setBackupHistory(history)
    } catch (error) {
      console.error("Error al cargar historial de respaldos:", error)
    }
  }

  const handleStartScan = async () => {
    if (!backupService) return

    setShowConfirmDialog(false)
    setIsScanning(true)
    setProgress(0)
    setStatus("Iniciando escaneo...")
    setLogs([])
    setIsPaused(false)

    try {
      // Solicitar selección de carpeta antes de iniciar (solo en Electron)
      if (isElectron) {
        const folderSelected = await backupService.selectBackupFolder()
        if (!folderSelected) {
          setIsScanning(false)
          setStatus("Escaneo cancelado: No se seleccionó una carpeta de destino")
          return
        }
      }

      // Obtener opciones de respaldo
      const savedConfig = localStorage.getItem("podio_backup_config")
      const backupOptions = savedConfig
        ? JSON.parse(savedConfig).backupOptions
        : {
            organizations: true,
            workspaces: true,
            applications: true,
            items: true,
            files: true,
          }

      // Iniciar escaneo
      await backupService.scanBackup(backupOptions, ((data) => {
        setProgress(data.progress)
        setStatus(data.status)
        setLogs(data.logs)
        setCounts(data.counts)
        setStats(data.stats)
      }) as ProgressCallback)

      setStatus("Escaneo completado. Listo para iniciar respaldo.")
    } catch (error) {
      if (error instanceof Error && error.message === "OPERATION_CANCELLED") {
        setStatus("Escaneo cancelado por el usuario")
      } else {
        console.error("Error durante el escaneo:", error)
        setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      setIsScanning(false)
    }
  }

  const handleStartBackup = async () => {
    if (!backupService) return

    setIsBackingUp(true)
    setProgress(0)
    setStatus("Iniciando respaldo...")
    setIsPaused(false)

    try {
      // Solicitar selección de carpeta antes de iniciar (solo en Electron)
      if (isElectron) {
        const folderSelected = await backupService.selectBackupFolder()
        if (!folderSelected) {
          setIsBackingUp(false)
          setStatus("Respaldo cancelado: No se seleccionó una carpeta de destino")
          return
        }
      }

      // Obtener opciones de respaldo
      const savedConfig = localStorage.getItem("podio_backup_config")
      const backupOptions = savedConfig
        ? JSON.parse(savedConfig).backupOptions
        : {
            organizations: true,
            workspaces: true,
            applications: true,
            items: true,
            files: true,
          }

      // Iniciar respaldo
      await backupService.performBackup(backupOptions, ((data) => {
        setProgress(data.progress)
        setStatus(data.status)
        setLogs(data.logs)
        setCounts(data.counts)
        setStats(data.stats)
      }) as ProgressCallback)

      // Recargar historial después del respaldo
      await loadBackupHistory(backupService)

      setStatus("¡Respaldo completado con éxito!")
    } catch (error) {
      if (error instanceof Error && error.message === "OPERATION_CANCELLED") {
        setStatus("Respaldo cancelado por el usuario")
      } else {
        console.error("Error durante el respaldo:", error)
        setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      setIsBackingUp(false)
    }
  }

  const handlePauseResume = () => {
    if (!backupService) return

    if (isPaused) {
      // Reanudar
      backupService.resumePausedBackup()
      setIsPaused(false)
      setStatus("Reanudando operación...")
    } else {
      // Pausar
      backupService.pauseBackup()
      setIsPaused(true)
      setStatus("Operación pausada. Haz clic en Reanudar para continuar.")
    }
  }

  const handleCancel = () => {
    if (!backupService) return

    setShowCancelDialog(false)
    backupService.cancelBackup()

    if (isScanning) {
      setIsScanning(false)
      setStatus("Escaneo cancelado por el usuario")
    } else if (isBackingUp) {
      setIsBackingUp(false)
      setStatus("Respaldo cancelado por el usuario")
    }

    setIsPaused(false)
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }

  const formatDate = (dateString: string) => {
    if (!dateString) return ""
    const date = new Date(dateString)
    return date.toLocaleDateString() + " " + date.toLocaleTimeString()
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
          <div className="flex gap-2">
            <Link href="/configuracion">
              <Button variant="outline" size="sm">
                <Settings className="h-4 w-4 mr-2" />
                Configuración
              </Button>
            </Link>
            <Link href="/">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Cerrar Sesión
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto py-6 px-4">
        <h1 className="text-2xl font-bold mb-6">Dashboard de Respaldo</h1>

        {!isElectron && (
          <Alert className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Limitaciones del navegador</AlertTitle>
            <AlertDescription>
              Estás ejecutando la aplicación en un navegador web, lo que limita algunas funcionalidades:
              <ul className="list-disc pl-5 mt-2">
                <li>La creación de carpetas es simulada (no se crean carpetas reales)</li>
                <li>Las descargas se realizarán individualmente sin estructura de carpetas</li>
                <li>Para una experiencia completa, considera usar la versión de escritorio (Electron)</li>
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Aplicaciones</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.apps}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Elementos</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.items}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Archivos</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.files}</div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Respaldo</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Progreso</span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} />
                <p className="text-sm text-muted-foreground">{status}</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium">Organizaciones</p>
                  <p className="text-2xl font-bold">{counts.organizations}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Espacios de Trabajo</p>
                  <p className="text-2xl font-bold">{counts.workspaces}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Aplicaciones</p>
                  <p className="text-2xl font-bold">{counts.applications}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Elementos</p>
                  <p className="text-2xl font-bold">{counts.items}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Archivos</p>
                  <p className="text-2xl font-bold">{counts.files}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Descargados</p>
                  <p className="text-2xl font-bold">{counts.downloadedFiles}</p>
                </div>
              </div>

              {/* Botones de control */}
              <div className="flex flex-col gap-2 sm:flex-row">
                {!isScanning && !isBackingUp ? (
                  <>
                    <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
                      <DialogTrigger asChild>
                        <Button className="flex-1" variant="outline">
                          <Search className="mr-2 h-4 w-4" />
                          Escanear
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Confirmar Escaneo</DialogTitle>
                          <DialogDescription>
                            ¿Estás seguro de que deseas iniciar un escaneo ahora? Se analizará la estructura de Podio
                            para determinar qué se respaldará.
                          </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                          <Button variant="outline" onClick={() => setShowConfirmDialog(false)}>
                            Cancelar
                          </Button>
                          <Button onClick={handleStartScan}>Iniciar Escaneo</Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>

                    <Button onClick={handleStartBackup} disabled={stats.apps === 0} className="flex-1">
                      <Download className="mr-2 h-4 w-4" />
                      Iniciar Respaldo
                    </Button>
                  </>
                ) : (
                  <div className="flex flex-col gap-2 sm:flex-row w-full">
                    <Button onClick={handlePauseResume} variant="outline" className="flex-1">
                      {isPaused ? (
                        <>
                          <Play className="mr-2 h-4 w-4" />
                          Reanudar
                        </>
                      ) : (
                        <>
                          <Pause className="mr-2 h-4 w-4" />
                          Pausar
                        </>
                      )}
                    </Button>

                    <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
                      <DialogTrigger asChild>
                        <Button variant="destructive" className="flex-1">
                          <XCircle className="mr-2 h-4 w-4" />
                          Cancelar
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Confirmar Cancelación</DialogTitle>
                          <DialogDescription>
                            ¿Estás seguro de que deseas cancelar el proceso actual? Esta acción no se puede deshacer.
                          </DialogDescription>
                        </DialogHeader>
                        <DialogFooter>
                          <Button variant="outline" onClick={() => setShowCancelDialog(false)}>
                            No, Continuar
                          </Button>
                          <Button variant="destructive" onClick={handleCancel}>
                            Sí, Cancelar
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Estadísticas</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="stats">
                <TabsList className="mb-4">
                  <TabsTrigger value="stats">Estadísticas</TabsTrigger>
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                  <TabsTrigger value="history">Historial</TabsTrigger>
                </TabsList>

                <TabsContent value="stats" className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm font-medium">Tamaño Estimado</p>
                      <p className="text-2xl font-bold">{stats.backupSize.toFixed(2)} GB</p>
                    </div>
                    <div>
                      <p className="text-sm font-medium">Descargado</p>
                      <p className="text-2xl font-bold">{formatBytes(stats.downloadedBytes)}</p>
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
                </TabsContent>

                <TabsContent value="logs">
                  <div className="h-[300px] overflow-y-auto border rounded-md p-2 bg-gray-50">
                    {logs.map((log, index) => (
                      <div
                        key={index}
                        className={`text-sm py-1 ${
                          log.level === "error"
                            ? "text-red-600"
                            : log.level === "warning"
                              ? "text-amber-600"
                              : log.level === "success"
                                ? "text-green-600"
                                : "text-gray-600"
                        }`}
                      >
                        <span className="text-xs text-gray-500">{new Date(log.timestamp).toLocaleTimeString()} </span>
                        {log.message}
                      </div>
                    ))}
                    {logs.length === 0 && (
                      <div className="text-sm text-gray-500 p-4 text-center">No hay logs disponibles</div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="history">
                  <div className="h-[300px] overflow-y-auto border rounded-md">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Fecha
                          </th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Estado
                          </th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Elementos
                          </th>
                          <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            Tamaño
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {backupHistory.map((item, index) => (
                          <tr key={index}>
                            <td className="px-3 py-2 whitespace-nowrap text-xs">{formatDate(item.fecha.start)}</td>
                            <td className="px-3 py-2 whitespace-nowrap text-xs">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                  item.estado === "Completado"
                                    ? "bg-green-100 text-green-800"
                                    : item.estado === "Error"
                                      ? "bg-red-100 text-red-800"
                                      : "bg-yellow-100 text-yellow-800"
                                }`}
                              >
                                {item.estado}
                              </span>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-xs">
                              {item.items} elementos / {item.archivos} archivos
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-xs">{item.tamanoEnGb}</td>
                          </tr>
                        ))}
                        {backupHistory.length === 0 && (
                          <tr>
                            <td colSpan={4} className="px-3 py-4 text-sm text-gray-500 text-center">
                              No hay registros de respaldo
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
