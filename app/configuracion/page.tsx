"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArrowLeft, Save, Info } from "lucide-react"
import Link from "next/link"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Switch } from "@/components/ui/switch"

export default function Configuracion() {
  const router = useRouter()
  const [backupOptions, setBackupOptions] = useState({
    organizations: true,
    workspaces: true,
    applications: true,
    items: true,
    files: true,
  })
  const [folderPath, setFolderPath] = useState("./public/backups")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [backupAppId, setBackupAppId] = useState("")
  const [showPathInfo, setShowPathInfo] = useState(false)
  const [testMode, setTestMode] = useState(
    () =>
      process.env.NEXT_PUBLIC_PODIO_TEST_MODE === "true" ||
      (typeof window !== "undefined" && localStorage.getItem("podio_test_mode") === "true")
  );

  useEffect(() => {
    // Verificar si hay credenciales almacenadas
    const credentials = sessionStorage.getItem("podio_credentials")
    if (!credentials) {
      router.push("/")
      return
    }

    // Cargar credenciales de API: primero desde localStorage, luego desde variables de entorno
    try {
      const savedCredentials = localStorage.getItem("podio_api_credentials")
      if (savedCredentials) {
        const creds = JSON.parse(savedCredentials)
        setClientId(creds.clientId || "")
        setClientSecret(creds.clientSecret || "")
        setBackupAppId(creds.backupAppId || "")
        console.log("✅ Credenciales cargadas desde localStorage")
      } else {
        // Si no hay en localStorage, cargar desde variables de entorno
        setClientId(process.env.NEXT_PUBLIC_PODIO_CLIENT_ID || "")
        setClientSecret(process.env.NEXT_PUBLIC_PODIO_CLIENT_SECRET || "")
        setBackupAppId(process.env.NEXT_PUBLIC_PODIO_BACKUP_APP_ID || "")
        console.log("✅ Credenciales cargadas desde variables de entorno")
      }
    } catch (e) {
      console.error("Error al cargar credenciales guardadas:", e)
      // Fallback a variables de entorno en caso de error
      setClientId(process.env.NEXT_PUBLIC_PODIO_CLIENT_ID || "")
      setClientSecret(process.env.NEXT_PUBLIC_PODIO_CLIENT_SECRET || "")
      setBackupAppId(process.env.NEXT_PUBLIC_PODIO_BACKUP_APP_ID || "")
    }

    // Cargar configuración guardada si existe
    const savedConfig = localStorage.getItem("podio_backup_config")
    if (savedConfig) {
      try {
        const config = JSON.parse(savedConfig)
        if (config.backupOptions) setBackupOptions(config.backupOptions)
        if (config.folderPath) setFolderPath(config.folderPath)
      } catch (e) {
        console.error("Error al cargar la configuración guardada:", e)
      }
    }

    setTestMode(
      process.env.NEXT_PUBLIC_PODIO_TEST_MODE === "true" ||
      (typeof window !== "undefined" && localStorage.getItem("podio_test_mode") === "true")
    );
  }, [router])

  const handleSaveConfig = () => {
    // Guardar configuración en localStorage
    localStorage.setItem(
      "podio_backup_config",
      JSON.stringify({
        backupOptions,
        folderPath,
      }),
    )

    // Guardar credenciales de API en localStorage
    localStorage.setItem(
      "podio_api_credentials",
      JSON.stringify({
        clientId,
        clientSecret,
        backupAppId,
      }),
    )

    alert("Configuración guardada correctamente")
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
          <div>
            <Link href="/dashboard">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Volver al Dashboard
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto py-6 px-4">
        <h1 className="text-2xl font-bold mb-6">Configuración</h1>

        <Tabs defaultValue="general">
          <TabsList className="mb-4">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="backup">Opciones de Respaldo</TabsTrigger>
            <TabsTrigger value="api">Configuración de API</TabsTrigger>
          </TabsList>

          <TabsContent value="general">
            <Card>
              <CardHeader>
                <CardTitle>Configuración General</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="folderPath">Ruta de Almacenamiento</Label>
                  <div className="flex gap-2">
                    <Input
                      id="folderPath"
                      value={folderPath}
                      onChange={(e) => setFolderPath(e.target.value)}
                      placeholder="Ruta donde se guardarán los respaldos"
                    />
                    <Button variant="outline" type="button" onClick={() => setShowPathInfo(!showPathInfo)}>
                      <Info className="h-4 w-4" />
                    </Button>
                  </div>

                  {showPathInfo && (
                    <Alert className="mt-2">
                      <AlertDescription>
                        Por limitaciones del navegador, no es posible seleccionar una carpeta del sistema. Los archivos
                        se guardarán en la carpeta <strong>{folderPath}</strong> dentro del proyecto. La estructura
                        será: Organización/Espacio de Trabajo/Aplicación/[items.xlsx y carpeta files/]
                      </AlertDescription>
                    </Alert>
                  )}

                  <p className="text-sm text-muted-foreground">
                    Los archivos se guardarán en una estructura jerárquica: Organización/Espacio de Trabajo/Aplicación/
                  </p>
                </div>

                <div className="pt-4">
                  <Button onClick={handleSaveConfig}>
                    <Save className="mr-2 h-4 w-4" />
                    Guardar Configuración
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="backup">
            <Card>
              <CardHeader>
                <CardTitle>Opciones de Respaldo</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h3 className="text-lg font-medium mb-2">Elementos a Respaldar</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {Object.entries(backupOptions).map(([key, value]) => (
                      <div key={key} className="flex items-center space-x-2">
                        <Checkbox
                          id={key}
                          checked={value}
                          onCheckedChange={(checked) => setBackupOptions({ ...backupOptions, [key]: !!checked })}
                        />
                        <Label htmlFor={key} className="capitalize">
                          {key === "organizations"
                            ? "Organizaciones"
                            : key === "workspaces"
                              ? "Espacios de Trabajo"
                              : key === "applications"
                                ? "Aplicaciones"
                                : key === "items"
                                  ? "Elementos"
                                  : "Archivos"}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="maxConcurrent">Descargas Simultáneas</Label>
                  <Input id="maxConcurrent" type="number" defaultValue={3} min={1} max={10} />
                  <p className="text-sm text-muted-foreground">
                    Número máximo de descargas simultáneas. Un número mayor puede acelerar el proceso pero consumir más
                    recursos.
                  </p>
                </div>

                <div className="pt-4">
                  <Button onClick={handleSaveConfig}>
                    <Save className="mr-2 h-4 w-4" />
                    Guardar Configuración
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="api">
            <Card>
              <CardHeader>
                <CardTitle>Configuración de API de Podio</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="clientId">Client ID</Label>
                  <Input
                    id="clientId"
                    type="text"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="Client ID de la API de Podio"
                  />
                  <p className="text-xs text-muted-foreground">Valor actual: {clientId || "No configurado"}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="clientSecret">Client Secret</Label>
                  <Input
                    id="clientSecret"
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="Client Secret de la API de Podio"
                  />
                  <p className="text-xs text-muted-foreground">{clientSecret ? "Configurado" : "No configurado"}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="backupAppId">ID de Aplicación de Respaldo</Label>
                  <Input
                    id="backupAppId"
                    type="text"
                    value={backupAppId}
                    onChange={(e) => setBackupAppId(e.target.value)}
                    placeholder="ID de la aplicación de respaldo en Podio"
                  />
                  <p className="text-xs text-muted-foreground">Valor actual: {backupAppId || "No configurado"}</p>
                </div>
                <div className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <Label htmlFor="testMode" className="text-base font-medium">🧪 Modo de Prueba</Label>
                      <p className="text-sm text-muted-foreground">
                        Activa este modo para probar el sistema sin procesar todos tus datos
                      </p>
                    </div>
                    <Switch
                      id="testMode"
                      checked={testMode}
                      onCheckedChange={(checked) => {
                        setTestMode(checked)
                        if (checked) {
                          localStorage.setItem("podio_test_mode", "true")
                        } else {
                          localStorage.removeItem("podio_test_mode")
                        }
                      }}
                    />
                  </div>
                  
                  {testMode && (
                    <Alert className="bg-yellow-50 border-yellow-200">
                      <AlertDescription>
                        <div className="space-y-2">
                          <p className="font-medium text-yellow-900">🧪 Modo de Prueba Activo</p>
                          <p className="text-sm text-yellow-800">
                            El sistema procesará solo el <strong>10%</strong> de tus datos con los siguientes límites:
                          </p>
                          <ul className="text-xs text-yellow-800 space-y-1 ml-4 list-disc">
                            <li><strong>Workspaces:</strong> 10% (máximo 2)</li>
                            <li><strong>Aplicaciones:</strong> 10% (máximo 2 por workspace)</li>
                            <li><strong>Items:</strong> 10% (máximo 5 por aplicación)</li>
                            <li><strong>Archivos:</strong> 10% (máximo 10 en total)</li>
                          </ul>
                          <p className="text-xs text-yellow-800 mt-2">
                            ✅ Perfecto para verificar que todo funciona correctamente antes del respaldo completo
                          </p>
                        </div>
                      </AlertDescription>
                    </Alert>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
