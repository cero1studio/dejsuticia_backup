"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArrowLeft, Save, Info, FolderOpen, Loader2 } from "lucide-react"
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
  const [apiUrl, setApiUrl] = useState("")
  const [showPathInfo, setShowPathInfo] = useState(false)
  const [isElectron, setIsElectron] = useState(false)
  const [testMode, setTestMode] = useState(
    () =>
      process.env.NEXT_PUBLIC_PODIO_TEST_MODE === "true" ||
      (typeof window !== "undefined" && localStorage.getItem("podio_test_mode") === "true")
  );
  
  // Estados para límites de rate configurables
  const [rateLimitHour, setRateLimitHour] = useState("5000")
  const [rateLimitDay, setRateLimitDay] = useState("60000")
  
  // Estados para probador de API
  const [isTesting, setIsTesting] = useState(false)
  const [testResults, setTestResults] = useState<{
    successful: number
    firstRateLimitAt: number | string
    estimatedLimit: number
    recommendation: string
    elapsedSeconds: number
    requestsPerSecond: number
    targetTimeMinutes?: number
    completedInTime?: boolean
    actualSpeed?: number
  } | null>(null)
  const [testProgress, setTestProgress] = useState("")
  
  // Estados para configuración del probador (independiente de la configuración principal)
  const [testClientId, setTestClientId] = useState("")
  const [testClientSecret, setTestClientSecret] = useState("")
  const [testMaxRequests, setTestMaxRequests] = useState("100")
  const [testTargetTimeMinutes, setTestTargetTimeMinutes] = useState("30")
  const [calculatedDelay, setCalculatedDelay] = useState<number | null>(null)
  const [testApiKeyName, setTestApiKeyName] = useState("")
  
  // Estados para gestión de múltiples API keys
  interface ApiKeyRecord {
    id: string
    name: string
    clientId: string
    clientSecret: string
    lastTestDate?: number
    lastTestResult?: {
      estimatedLimit: number
      successful: number
      elapsedSeconds: number
    }
  }
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([])
  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string | null>(null)
  const [showApiKeyManager, setShowApiKeyManager] = useState(false)

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

    // Cargar credenciales de API: primero desde localStorage, luego desde variables de entorno
    try {
      const savedCredentials = localStorage.getItem("podio_api_credentials")
      if (savedCredentials) {
        const creds = JSON.parse(savedCredentials)
        // Solo usar credenciales guardadas si realmente tienen valores (no strings vacíos)
        if (creds.clientId && creds.clientId.trim() !== '' && 
            creds.clientSecret && creds.clientSecret.trim() !== '') {
          setClientId(creds.clientId)
          setClientSecret(creds.clientSecret)
          setBackupAppId(creds.backupAppId || "")
          console.log("✅ Credenciales cargadas desde localStorage (configuración guardada)")
        } else {
          // Si las credenciales guardadas están vacías, usar variables de entorno
          console.log("⚠️ Credenciales en localStorage están vacías, usando variables de entorno")
          setClientId(process.env.NEXT_PUBLIC_PODIO_CLIENT_ID || "")
          setClientSecret(process.env.NEXT_PUBLIC_PODIO_CLIENT_SECRET || "")
          setBackupAppId(process.env.NEXT_PUBLIC_PODIO_BACKUP_APP_ID || "")
        }
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

    // Cargar API URL desde localStorage o .env
    try {
      const savedApiUrl = localStorage.getItem("podio_api_url")
      if (savedApiUrl && savedApiUrl.trim() !== "") {
        setApiUrl(savedApiUrl.trim())
      } else {
        const envApiUrl = process.env.NEXT_PUBLIC_PODIO_API_URL || "https://api.podio.com"
        setApiUrl(envApiUrl)
      }
    } catch (e) {
      console.error("Error al cargar API URL:", e)
      setApiUrl(process.env.NEXT_PUBLIC_PODIO_API_URL || "https://api.podio.com")
    }

    setTestMode(
      process.env.NEXT_PUBLIC_PODIO_TEST_MODE === "true" ||
      (typeof window !== "undefined" && localStorage.getItem("podio_test_mode") === "true")
    );
    
    // Cargar límites de rate guardados
    try {
      const hourLimit = localStorage.getItem('podio_rate_limit_hour')
      const dayLimit = localStorage.getItem('podio_rate_limit_day')
      if (hourLimit) setRateLimitHour(hourLimit)
      if (dayLimit) setRateLimitDay(dayLimit)
    } catch (e) {
      console.error("Error al cargar límites de rate:", e)
    }
    
    // Cargar configuración del probador guardada
    try {
      const savedTesterConfig = localStorage.getItem('podio_api_tester_config')
      if (savedTesterConfig) {
        const config = JSON.parse(savedTesterConfig)
        if (config.testClientId) setTestClientId(config.testClientId)
        if (config.testClientSecret) setTestClientSecret(config.testClientSecret)
        if (config.testMaxRequests) setTestMaxRequests(config.testMaxRequests)
        if (config.testTargetTimeMinutes) setTestTargetTimeMinutes(config.testTargetTimeMinutes)
        if (config.testApiKeyName) setTestApiKeyName(config.testApiKeyName)
      }
    } catch (e) {
      console.error("Error al cargar configuración del probador:", e)
    }
    
    // Cargar API keys guardadas
    try {
      const savedApiKeys = localStorage.getItem('podio_api_keys_list')
      if (savedApiKeys) {
        const keys = JSON.parse(savedApiKeys)
        setApiKeys(keys)
      }
    } catch (e) {
      console.error("Error al cargar API keys:", e)
    }
  }, [router])
  
  // Guardar API keys en localStorage
  const saveApiKeys = (keys: ApiKeyRecord[]) => {
    try {
      localStorage.setItem('podio_api_keys_list', JSON.stringify(keys))
      setApiKeys(keys)
    } catch (e) {
      console.error("Error guardando API keys:", e)
    }
  }
  
  // Agregar nueva API key
  const addApiKey = () => {
    if (!testApiKeyName || !testClientId || !testClientSecret) {
      alert("⚠️ Por favor completa el nombre, Client ID y Client Secret")
      return
    }
    
    const newKey: ApiKeyRecord = {
      id: Date.now().toString(),
      name: testApiKeyName,
      clientId: testClientId,
      clientSecret: testClientSecret
    }
    
    const updatedKeys = [...apiKeys, newKey]
    saveApiKeys(updatedKeys)
    setSelectedApiKeyId(newKey.id)
    alert(`✅ API key "${testApiKeyName}" agregada`)
  }
  
  // Seleccionar API key
  const selectApiKey = (keyId: string) => {
    const key = apiKeys.find(k => k.id === keyId)
    if (key) {
      setSelectedApiKeyId(keyId)
      setTestClientId(key.clientId)
      setTestClientSecret(key.clientSecret)
      setTestApiKeyName(key.name)
    }
  }
  
  // Eliminar API key
  const deleteApiKey = (keyId: string) => {
    if (window.confirm("¿Estás seguro de eliminar esta API key?")) {
      const updatedKeys = apiKeys.filter(k => k.id !== keyId)
      saveApiKeys(updatedKeys)
      if (selectedApiKeyId === keyId) {
        setSelectedApiKeyId(null)
        setTestClientId("")
        setTestClientSecret("")
        setTestApiKeyName("")
      }
    }
  }
  
  // Calcular delay automático cuando cambian las configuraciones
  useEffect(() => {
    const maxRequests = parseInt(testMaxRequests) || 0
    const targetMinutes = parseFloat(testTargetTimeMinutes) || 0
    
    if (maxRequests > 0 && targetMinutes > 0) {
      const delayMs = (targetMinutes * 60 * 1000) / maxRequests
      setCalculatedDelay(Math.round(delayMs))
    } else {
      setCalculatedDelay(null)
    }
  }, [testMaxRequests, testTargetTimeMinutes])

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
    
    // Guardar límites de rate personalizados
    localStorage.setItem('podio_rate_limit_hour', rateLimitHour)
    localStorage.setItem('podio_rate_limit_day', rateLimitDay)

    // Guardar API URL
    if (apiUrl && apiUrl.trim() !== "") {
      localStorage.setItem("podio_api_url", apiUrl.trim())
    } else {
      localStorage.removeItem("podio_api_url")
    }

    alert("Configuración guardada correctamente ✅\n\n⚠️ IMPORTANTE: Reinicia la aplicación para que los nuevos límites de rate y la API URL surtan efecto.")
  }
  
  // Función para guardar y probar la configuración de API
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [connectionTestResult, setConnectionTestResult] = useState<{
    success: boolean
    message: string
  } | null>(null)
  
  const handleSaveAndTestApiConfig = async () => {
    if (!clientId || !clientSecret) {
      alert("⚠️ Por favor completa Client ID y Client Secret antes de guardar")
      return
    }
    
    // Guardar credenciales de API en localStorage
    localStorage.setItem(
      "podio_api_credentials",
      JSON.stringify({
        clientId,
        clientSecret,
        backupAppId,
      }),
    )
    
    // Guardar límites de rate personalizados
    localStorage.setItem('podio_rate_limit_hour', rateLimitHour)
    localStorage.setItem('podio_rate_limit_day', rateLimitDay)
    
    // Probar la conexión
    setIsTestingConnection(true)
    setConnectionTestResult(null)
    
    try {
      // Obtener credenciales de usuario
      const credentials = sessionStorage.getItem("podio_credentials")
      if (!credentials) {
        throw new Error("No hay credenciales de usuario. Por favor inicia sesión primero.")
      }
      
      const { username, password } = JSON.parse(credentials)
      
      // Intentar autenticarse con las nuevas credenciales de API
      const authResponse = await fetch("https://podio.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: clientId,
          client_secret: clientSecret,
          username: username,
          password: password
        })
      })
      
      if (!authResponse.ok) {
        const errorText = await authResponse.text()
        throw new Error(`Error de autenticación: ${authResponse.status} - ${errorText}`)
      }
      
      const authData = await authResponse.json()
      
      // Hacer una petición de prueba a la API
      const testResponse = await fetch("https://api.podio.com/user/status", {
        headers: { Authorization: `OAuth2 ${authData.access_token}` }
      })
      
      if (!testResponse.ok) {
        throw new Error(`Error al probar la conexión: ${testResponse.status}`)
      }
      
      const userData = await testResponse.json()
      
      setConnectionTestResult({
        success: true,
        message: `✅ Conexión exitosa!\n\nUsuario: ${userData.user?.name || username}\n\n🔑 Todas las peticiones a Podio (escaneo, respaldo, descarga de archivos, descarga de Excel, etc.) se realizarán ahora con esta API key:\nClient ID: ${clientId.substring(0, 20)}...`
      })
      
    } catch (error) {
      setConnectionTestResult({
        success: false,
        message: `❌ Error al probar la conexión:\n\n${error instanceof Error ? error.message : String(error)}\n\n⚠️ Las credenciales se guardaron, pero la conexión falló. Por favor verifica los datos.`
      })
    } finally {
      setIsTestingConnection(false)
    }
  }

  const handleSelectFolder = async () => {
    if (isElectron) {
      try {
        const result = await window.electron.fileSystem.selectDirectory()
        if (!result.canceled && result.filePath) {
          setFolderPath(result.filePath)
        }
      } catch (error) {
        console.error("Error al seleccionar carpeta:", error)
      }
    } else {
      alert("La selección de carpetas solo está disponible en la versión de escritorio")
    }
  }
  
  /**
   * PROBADOR DE LÍMITES DE API
   * Hace peticiones rápidas a Podio hasta recibir un error 429
   * Mide la frecuencia de peticiones y calcula el límite real
   * Usa configuración del probador (independiente de la configuración principal)
   */
  const handleTestRateLimits = async () => {
    // Validar configuración del probador
    if (!testClientId || !testClientSecret) {
      alert("⚠️ Por favor configura Client ID y Client Secret del probador primero")
      return
    }
    
    const maxRequests = parseInt(testMaxRequests) || 0
    const targetMinutes = parseFloat(testTargetTimeMinutes) || 0
    
    if (maxRequests <= 0) {
      alert("⚠️ El número de peticiones debe ser mayor a 0")
      return
    }
    
    if (targetMinutes <= 0) {
      alert("⚠️ El tiempo objetivo debe ser mayor a 0 minutos")
      return
    }
    
    if (!calculatedDelay || calculatedDelay < 50) {
      const confirm = window.confirm(
        `⚠️ El delay calculado es muy bajo (${calculatedDelay}ms). Esto puede saturar la API.\n\n` +
        `¿Deseas continuar de todas formas?`
      )
      if (!confirm) return
    }
    
    if (calculatedDelay && calculatedDelay > 5000) {
      alert(`⚠️ El delay calculado es muy alto (${calculatedDelay}ms). La prueba tomará mucho tiempo.\n\nConsidera aumentar el número de peticiones o reducir el tiempo objetivo.`)
      return
    }
    
    const credentials = sessionStorage.getItem("podio_credentials")
    if (!credentials) {
      alert("⚠️ Necesitas autenticarte primero. Ve al dashboard e inicia sesión.")
      return
    }
    
    const { username, password } = JSON.parse(credentials)
    
    setIsTesting(true)
    setTestResults(null)
    setTestProgress("🔐 Autenticando...")
    
    try {
      // 1. Autenticar con credenciales de prueba (del probador, no de la configuración principal)
      setTestProgress("🔐 Autenticando con Podio usando credenciales del probador...")
      const authResponse = await fetch("https://podio.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: testClientId,
          client_secret: testClientSecret,
          username: username,
          password: password
        })
      })
      
      if (!authResponse.ok) {
        const errorText = await authResponse.text()
        throw new Error(`Autenticación fallida: ${authResponse.status} - ${errorText}`)
      }
      
      const authData = await authResponse.json()
      setTestProgress(`✅ Autenticado. Iniciando prueba de límites (${maxRequests} peticiones en ${targetMinutes} minutos)...`)
      
      // 2. Hacer peticiones con delay calculado hasta recibir 429 o completar todas
      let successful = 0
      let firstRateLimitAt: number | string = "No alcanzado"
      const startTime = Date.now()
      const delayMs = calculatedDelay || 100 // Usar delay calculado o 100ms por defecto
      const targetTimeMs = targetMinutes * 60 * 1000
      
      setTestProgress(`🚀 Realizando peticiones de prueba (0/${maxRequests})...\nDelay: ${delayMs}ms entre peticiones`)
      
      for (let i = 0; i < maxRequests; i++) {
        const requestStart = Date.now()
        
        try {
          const response = await fetch("https://api.podio.com/org", {
            headers: { Authorization: `OAuth2 ${authData.access_token}` }
          })
          
          if (response.status === 429 || response.status === 420) {
            firstRateLimitAt = i + 1
            setTestProgress(`⚠️ Rate limit alcanzado en petición #${i + 1}`)
            break
          }
          
          if (response.ok) {
            successful++
            
            // Actualizar progreso cada 5% o cada 10 peticiones (lo que sea menor)
            const progressInterval = Math.max(10, Math.floor(maxRequests * 0.05))
            if ((i + 1) % progressInterval === 0 || i === maxRequests - 1) {
              const elapsed = Math.round((Date.now() - startTime) / 1000)
              const rps = elapsed > 0 ? (successful / elapsed).toFixed(2) : "0.00"
              const percent = Math.round(((i + 1) / maxRequests) * 100)
              setTestProgress(`✅ ${i + 1}/${maxRequests} peticiones (${percent}%) | ${successful} exitosas | ${elapsed}s | ${rps} req/s`)
            }
          }
          
          // Usar delay calculado
          const requestDuration = Date.now() - requestStart
          if (requestDuration < delayMs) {
            await new Promise(r => setTimeout(r, delayMs - requestDuration))
          }
        } catch (error) {
          console.error(`Error en petición ${i + 1}:`, error)
          // Continuar con la siguiente petición
        }
      }
      
      const elapsedSeconds = (Date.now() - startTime) / 1000
      const elapsedMinutes = elapsedSeconds / 60
      const requestsPerSecond = successful / elapsedSeconds
      const completedInTime = elapsedMinutes <= targetMinutes
      
      // Calcular límite estimado por hora
      // Si alcanzó el límite, usar ese número
      // Si no, extrapolar basándose en la velocidad
      let estimatedPerHour: number
      if (typeof firstRateLimitAt === "number") {
        estimatedPerHour = firstRateLimitAt - 1 // El límite es 1 menos que donde falló
      } else {
        estimatedPerHour = Math.floor(requestsPerSecond * 3600)
      }
      
      // Generar recomendación
      let recommendation: string
      if (typeof firstRateLimitAt === "number") {
        recommendation = `⚠️ Rate limit alcanzado en petición #${firstRateLimitAt}. Límite estimado: ${estimatedPerHour} req/hora.`
      } else if (estimatedPerHour < 1000) {
        recommendation = `⚠️ Límite muy bajo detectado. Tu cuenta tiene restricciones severas. Configura ${estimatedPerHour} req/hora.`
      } else if (estimatedPerHour < 3000) {
        recommendation = `⚠️ Límite bajo detectado. Configura ${estimatedPerHour} req/hora para evitar bloqueos.`
      } else if (estimatedPerHour < 5000) {
        recommendation = `✅ Límite moderado. Configura ${estimatedPerHour} req/hora para seguridad.`
      } else {
        recommendation = `✅ Límite estándar o superior de Podio. Configura ${estimatedPerHour} req/hora.`
      }
      
      if (!completedInTime) {
        recommendation += `\n\n⏱️ La prueba tomó ${elapsedMinutes.toFixed(1)} minutos (objetivo: ${targetMinutes} minutos). Considera aumentar el delay o reducir peticiones.`
      }
      
      setTestResults({
        successful,
        firstRateLimitAt,
        estimatedLimit: estimatedPerHour,
        recommendation,
        elapsedSeconds: Math.round(elapsedSeconds),
        requestsPerSecond: parseFloat(requestsPerSecond.toFixed(2)),
        targetTimeMinutes: targetMinutes,
        completedInTime,
        actualSpeed: parseFloat((successful / elapsedMinutes).toFixed(2))
      })
      
      setTestProgress("✅ Prueba completada")
      
      // Guardar resultado en la API key si está seleccionada
      if (selectedApiKeyId) {
        const updatedKeys = apiKeys.map(key => {
          if (key.id === selectedApiKeyId) {
            return {
              ...key,
              lastTestDate: Date.now(),
              lastTestResult: {
                estimatedLimit: estimatedPerHour,
                successful,
                elapsedSeconds: Math.round(elapsedSeconds)
              }
            }
          }
          return key
        })
        saveApiKeys(updatedKeys)
      }
      
      // Guardar configuración del probador
      try {
        localStorage.setItem('podio_api_tester_config', JSON.stringify({
          testClientId,
          testClientSecret,
          testMaxRequests,
          testTargetTimeMinutes,
          testApiKeyName
        }))
      } catch (e) {
        console.error("Error guardando configuración del probador:", e)
      }
    } catch (error) {
      alert(`❌ Error durante la prueba: ${error instanceof Error ? error.message : String(error)}`)
      setTestProgress("❌ Error en la prueba")
    } finally {
      setIsTesting(false)
    }
  }
  
  /**
   * Aplica los límites detectados por el probador
   */
  const applyTestedLimits = () => {
    if (testResults) {
      setRateLimitHour(testResults.estimatedLimit.toString())
      // Mantener el límite diario proporcional (12x el límite horario es aproximadamente correcto)
      setRateLimitDay((testResults.estimatedLimit * 12).toString())
      alert(`✅ Límites aplicados:\n\n- Por hora: ${testResults.estimatedLimit}\n- Por día: ${testResults.estimatedLimit * 12}\n\n⚠️ No olvides guardar la configuración.`)
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
          <div>
            <Link href="/dashboard-electron">
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
            <TabsTrigger value="api-tester">Probador de API</TabsTrigger>
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
                    {isElectron && (
                      <Button variant="outline" type="button" onClick={handleSelectFolder}>
                        <FolderOpen className="h-4 w-4 mr-2" />
                        Explorar
                      </Button>
                    )}
                    <Button variant="outline" type="button" onClick={() => setShowPathInfo(!showPathInfo)}>
                      <Info className="h-4 w-4" />
                    </Button>
                  </div>

                  {showPathInfo && (
                    <Alert className="mt-2">
                      <AlertDescription>
                        {isElectron ? (
                          <>
                            Selecciona la carpeta donde deseas guardar los respaldos. La estructura será:
                            Organización/Espacio de Trabajo/Aplicación/[items.xlsx y carpeta files/]
                          </>
                        ) : (
                          <>
                            Por limitaciones del navegador, no es posible seleccionar una carpeta del sistema. Los
                            archivos se guardarán en la carpeta <strong>{folderPath}</strong> dentro del proyecto.
                          </>
                        )}
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

          {/* NUEVA TAB: PROBADOR DE API */}
          <TabsContent value="api-tester">
            <Card>
              <CardHeader>
                <CardTitle>🧪 Probador de Límites API</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Realiza peticiones de prueba para descubrir los límites reales de tu cuenta de Podio
                </p>
                
                <Alert className="bg-blue-50 border-blue-200">
                  <AlertDescription className="text-sm">
                    <p className="font-medium text-blue-900 mb-2">📊 ¿Cómo funciona?</p>
                    <ul className="list-disc ml-4 text-blue-800 space-y-1">
                      <li>Configura las API keys que quieres probar (independiente de la configuración principal)</li>
                      <li>Define cuántas peticiones hacer y en cuánto tiempo</li>
                      <li>El sistema calcula automáticamente el delay necesario</li>
                      <li>Mide la frecuencia: requests por segundo</li>
                      <li>Detecta cuándo Podio responde con error 429 (rate limit)</li>
                      <li>Calcula el límite real y sugiere configuración óptima</li>
                    </ul>
                    <p className="mt-2 text-xs text-blue-700">
                      ⚠️ Usa esto con precaución: consumirá parte de tu cuota de API
                    </p>
                  </AlertDescription>
                </Alert>
                
                {/* Gestión de API Keys */}
                <div className="space-y-3 p-4 bg-purple-50 rounded border border-purple-200">
                  <div className="flex items-center justify-between">
                    <h4 className="font-semibold text-sm">🔑 Gestión de API Keys</h4>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowApiKeyManager(!showApiKeyManager)}
                    >
                      {showApiKeyManager ? "Ocultar" : "Gestionar"}
                    </Button>
                  </div>
                  
                  {showApiKeyManager && (
                    <div className="space-y-3">
                      {/* Lista de API keys guardadas */}
                      {apiKeys.length > 0 && (
                        <div className="space-y-2">
                          <Label className="text-xs">API Keys guardadas:</Label>
                          <div className="space-y-1 max-h-40 overflow-y-auto">
                            {apiKeys.map(key => (
                              <div
                                key={key.id}
                                className={`p-2 rounded border cursor-pointer transition-colors ${
                                  selectedApiKeyId === key.id
                                    ? "bg-blue-100 border-blue-300"
                                    : "bg-white border-gray-200 hover:bg-gray-50"
                                }`}
                                onClick={() => selectApiKey(key.id)}
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex-1">
                                    <p className="font-medium text-sm">{key.name}</p>
                                    <p className="text-xs text-gray-500">
                                      {key.clientId.substring(0, 20)}...
                                    </p>
                                    {key.lastTestResult && (
                                      <p className="text-xs text-green-600 mt-1">
                                        Límite: {key.lastTestResult.estimatedLimit.toLocaleString()}/hora
                                        {key.lastTestDate && (
                                          <span className="text-gray-500 ml-2">
                                            ({new Date(key.lastTestDate).toLocaleDateString()})
                                          </span>
                                        )}
                                      </p>
                                    )}
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      deleteApiKey(key.id)
                                    }}
                                    className="text-red-600 hover:text-red-700"
                                  >
                                    ✕
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {/* Agregar nueva API key */}
                      <div className="space-y-2 pt-2 border-t">
                        <Label className="text-xs">Agregar nueva API key:</Label>
                        <Input
                          type="text"
                          value={testApiKeyName}
                          onChange={(e) => setTestApiKeyName(e.target.value)}
                          placeholder="Nombre para identificar esta API key (ej: 'API Key Producción')"
                          className="text-sm"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={addApiKey}
                          disabled={!testApiKeyName || !testClientId || !testClientSecret}
                          className="w-full"
                        >
                          ➕ Agregar API Key
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* Configuración del Probador */}
                <div className="space-y-4 p-4 bg-gray-50 rounded border">
                  <h4 className="font-semibold text-sm">⚙️ Configuración del Probador</h4>
                  
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="testClientId">Client ID para probar</Label>
                      <Input
                        id="testClientId"
                        type="text"
                        value={testClientId}
                        onChange={(e) => setTestClientId(e.target.value)}
                        placeholder="Ingresa el Client ID a probar"
                      />
                      <p className="text-xs text-muted-foreground">
                        API key independiente de la configuración principal
                      </p>
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="testClientSecret">Client Secret para probar</Label>
                      <Input
                        id="testClientSecret"
                        type="password"
                        value={testClientSecret}
                        onChange={(e) => setTestClientSecret(e.target.value)}
                        placeholder="Ingresa el Client Secret a probar"
                      />
                      <p className="text-xs text-muted-foreground">
                        API key independiente de la configuración principal
                      </p>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label htmlFor="testMaxRequests">Número de peticiones</Label>
                        <Input
                          id="testMaxRequests"
                          type="number"
                          min="1"
                          value={testMaxRequests}
                          onChange={(e) => setTestMaxRequests(e.target.value)}
                          placeholder="100"
                        />
                        <p className="text-xs text-muted-foreground">
                          Ej: 5000, 60000
                        </p>
                      </div>
                      
                      <div className="space-y-2">
                        <Label htmlFor="testTargetTimeMinutes">Tiempo objetivo (minutos)</Label>
                        <Input
                          id="testTargetTimeMinutes"
                          type="number"
                          min="0.1"
                          step="0.1"
                          value={testTargetTimeMinutes}
                          onChange={(e) => setTestTargetTimeMinutes(e.target.value)}
                          placeholder="30"
                        />
                        <p className="text-xs text-muted-foreground">
                          Ej: 30, 60
                        </p>
                      </div>
                    </div>
                    
                    {calculatedDelay !== null && (
                      <div className="p-3 bg-blue-50 rounded border border-blue-200">
                        <p className="text-sm font-medium text-blue-900">
                          ⏱️ Delay calculado: <span className="font-bold">{calculatedDelay}ms</span> entre peticiones
                        </p>
                        <p className="text-xs text-blue-700 mt-1">
                          Tiempo estimado: {((parseInt(testMaxRequests) || 0) * calculatedDelay / 1000 / 60).toFixed(1)} minutos
                        </p>
                        {calculatedDelay < 50 && (
                          <p className="text-xs text-orange-700 mt-1">
                            ⚠️ Delay muy bajo. Puede saturar la API.
                          </p>
                        )}
                        {calculatedDelay > 5000 && (
                          <p className="text-xs text-orange-700 mt-1">
                            ⚠️ Delay muy alto. La prueba tomará mucho tiempo.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                
                <div className="space-y-2">
                  <Button 
                    onClick={handleTestRateLimits}
                    disabled={isTesting || !testClientId || !testClientSecret || !testMaxRequests || !testTargetTimeMinutes}
                    className="w-full"
                  >
                    {isTesting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Probando...
                      </>
                    ) : (
                      "🚀 Probar Límites de API"
                    )}
                  </Button>
                  
                  {/* Progreso del test */}
                  {testProgress && (
                    <div className="p-3 bg-gray-100 rounded text-sm font-mono">
                      {testProgress}
                    </div>
                  )}
                  
                  {/* Resultados del test */}
                  {testResults && (
                    <div className="p-4 bg-green-50 rounded border border-green-200 space-y-3">
                      <p className="font-bold text-green-900 text-base">✅ Resultados de la Prueba:</p>
                      
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <span className="text-gray-600">Peticiones exitosas:</span>
                          <p className="font-bold text-green-700">{testResults.successful}</p>
                        </div>
                        
                        <div>
                          <span className="text-gray-600">Rate limit en:</span>
                          <p className="font-bold text-orange-700">
                            {typeof testResults.firstRateLimitAt === "number" 
                              ? `Petición #${testResults.firstRateLimitAt}` 
                              : testResults.firstRateLimitAt}
                          </p>
                        </div>
                        
                        <div>
                          <span className="text-gray-600">Tiempo transcurrido:</span>
                          <p className="font-bold text-blue-700">
                            {testResults.elapsedSeconds} segundos
                            {testResults.targetTimeMinutes && (
                              <span className="text-xs block">
                                ({testResults.completedInTime ? '✅' : '⚠️'} Objetivo: {testResults.targetTimeMinutes} min)
                              </span>
                            )}
                          </p>
                        </div>
                        
                        <div>
                          <span className="text-gray-600">Velocidad promedio:</span>
                          <p className="font-bold text-blue-700">
                            {testResults.requestsPerSecond} req/s
                            {testResults.actualSpeed && (
                              <span className="text-xs block">
                                ({testResults.actualSpeed} req/min)
                              </span>
                            )}
                          </p>
                        </div>
                        
                        <div className="col-span-2">
                          <span className="text-gray-600">Límite estimado/hora:</span>
                          <p className="font-bold text-purple-700 text-lg">{testResults.estimatedLimit.toLocaleString()} peticiones</p>
                        </div>
                      </div>
                      
                      <div className="pt-2 border-t border-green-300">
                        <p className="text-sm font-medium text-green-900 mb-2">💡 Recomendación:</p>
                        <p className="text-sm text-green-800">{testResults.recommendation}</p>
                      </div>
                      
                      <Button
                        size="sm"
                        className="w-full mt-2"
                        onClick={applyTestedLimits}
                      >
                        ✨ Aplicar Límites Detectados
                      </Button>
                    </div>
                  )}
                  
                  {/* Tabla comparativa de API Keys */}
                  {apiKeys.length > 0 && (
                    <div className="mt-4 p-4 bg-white rounded border">
                      <h4 className="font-semibold text-sm mb-3">📊 Comparación de API Keys</h4>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left p-2">Nombre</th>
                              <th className="text-left p-2">Client ID</th>
                              <th className="text-right p-2">Límite/hora</th>
                              <th className="text-right p-2">Última prueba</th>
                              <th className="text-center p-2">Acción</th>
                            </tr>
                          </thead>
                          <tbody>
                            {apiKeys.map(key => (
                              <tr key={key.id} className="border-b hover:bg-gray-50">
                                <td className="p-2 font-medium">{key.name}</td>
                                <td className="p-2 text-gray-600 font-mono text-xs">
                                  {key.clientId.substring(0, 15)}...
                                </td>
                                <td className="p-2 text-right">
                                  {key.lastTestResult ? (
                                    <span className={`font-bold ${
                                      key.lastTestResult.estimatedLimit >= 5000 
                                        ? "text-green-600" 
                                        : key.lastTestResult.estimatedLimit >= 1000
                                        ? "text-orange-600"
                                        : "text-red-600"
                                    }`}>
                                      {key.lastTestResult.estimatedLimit.toLocaleString()}
                                    </span>
                                  ) : (
                                    <span className="text-gray-400">No probada</span>
                                  )}
                                </td>
                                <td className="p-2 text-right text-xs text-gray-500">
                                  {key.lastTestDate 
                                    ? new Date(key.lastTestDate).toLocaleDateString()
                                    : "-"
                                  }
                                </td>
                                <td className="p-2 text-center">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => selectApiKey(key.id)}
                                    className="text-xs"
                                  >
                                    Usar
                                  </Button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      
                      {/* Función de búsqueda por límite */}
                      <div className="mt-3 p-2 bg-blue-50 rounded">
                        <p className="text-xs font-medium text-blue-900 mb-2">
                          🔍 Buscar API key por límite:
                        </p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const keysWith5000 = apiKeys.filter(k => 
                                k.lastTestResult && k.lastTestResult.estimatedLimit >= 5000
                              )
                              if (keysWith5000.length > 0) {
                                alert(`API keys con límite ≥ 5000:\n\n${keysWith5000.map(k => `- ${k.name}: ${k.lastTestResult?.estimatedLimit.toLocaleString()}/hora`).join('\n')}`)
                              } else {
                                alert("No se encontraron API keys con límite ≥ 5000")
                              }
                            }}
                            className="text-xs"
                          >
                            ≥ 5000/hora
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              const keysWith1000 = apiKeys.filter(k => 
                                k.lastTestResult && k.lastTestResult.estimatedLimit >= 1000 && k.lastTestResult.estimatedLimit < 5000
                              )
                              if (keysWith1000.length > 0) {
                                alert(`API keys con límite 1000-5000:\n\n${keysWith1000.map(k => `- ${k.name}: ${k.lastTestResult?.estimatedLimit.toLocaleString()}/hora`).join('\n')}`)
                              } else {
                                alert("No se encontraron API keys con límite entre 1000-5000")
                              }
                            }}
                            className="text-xs"
                          >
                            1000-5000/hora
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
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
                <div className="space-y-2">
                  <Label htmlFor="apiUrl">URL de la API de Podio</Label>
                  <Input
                    id="apiUrl"
                    type="text"
                    value={apiUrl}
                    onChange={(e) => setApiUrl(e.target.value)}
                    placeholder="https://api.podio.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    Valor actual: {apiUrl || "https://api.podio.com (por defecto)"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Si no se configura, se usará la URL por defecto de Podio o la variable de entorno NEXT_PUBLIC_PODIO_API_URL
                  </p>
                </div>
                
                {/* SECCIÓN: LÍMITES DE RATE CONFIGURABLES */}
                <div className="space-y-4 border-t pt-4">
                  <h3 className="text-lg font-semibold">⚙️ Límites de Rate Personalizados</h3>
                  <p className="text-sm text-muted-foreground">
                    Configura límites personalizados si tu cuenta tiene restricciones diferentes al estándar de Podio (5000/hora, 60000/día)
                  </p>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="rateLimitHour">Peticiones por Hora</Label>
                      <Input
                        id="rateLimitHour"
                        type="number"
                        value={rateLimitHour}
                        onChange={(e) => setRateLimitHour(e.target.value)}
                        placeholder="5000"
                      />
                      <p className="text-xs text-muted-foreground">Por defecto: 5000</p>
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="rateLimitDay">Peticiones por Día</Label>
                      <Input
                        id="rateLimitDay"
                        type="number"
                        value={rateLimitDay}
                        onChange={(e) => setRateLimitDay(e.target.value)}
                        placeholder="60000"
                      />
                      <p className="text-xs text-muted-foreground">Por defecto: 60000</p>
                    </div>
                  </div>
                </div>
                
                {/* Botón de guardar y probar configuración de API */}
                <div className="pt-4 border-t">
                  <Alert className="bg-blue-50 border-blue-200 mb-4">
                    <AlertDescription className="text-sm">
                      <p className="font-medium text-blue-900 mb-2">ℹ️ Información importante</p>
                      <p className="text-blue-800">
                        Al guardar esta configuración, <strong>todas las peticiones a Podio</strong> (escaneo, respaldo, descarga de archivos, descarga de Excel, etc.) se realizarán con esta API key (Client ID y Client Secret).
                      </p>
                    </AlertDescription>
                  </Alert>
                  
                  <Button 
                    onClick={handleSaveAndTestApiConfig} 
                    className="w-full"
                    disabled={isTestingConnection || !clientId || !clientSecret}
                  >
                    {isTestingConnection ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Probando conexión...
                      </>
                    ) : (
                      <>
                        <Save className="mr-2 h-4 w-4" />
                        Guardar y Probar Configuración de API
                      </>
                    )}
                  </Button>
                  
                  {/* Resultado de la prueba de conexión */}
                  {connectionTestResult && (
                    <div className={`mt-4 p-4 rounded border ${
                      connectionTestResult.success 
                        ? "bg-green-50 border-green-200" 
                        : "bg-red-50 border-red-200"
                    }`}>
                      <p className={`font-bold text-base mb-2 ${
                        connectionTestResult.success ? "text-green-900" : "text-red-900"
                      }`}>
                        {connectionTestResult.success ? "✅" : "❌"} {connectionTestResult.success ? "Conexión Exitosa" : "Error de Conexión"}
                      </p>
                      <p className={`text-sm whitespace-pre-line ${
                        connectionTestResult.success ? "text-green-800" : "text-red-800"
                      }`}>
                        {connectionTestResult.message}
                      </p>
                    </div>
                  )}
                  
                  <p className="text-xs text-muted-foreground mt-2">
                    ⚠️ IMPORTANTE: Reinicia la aplicación después de guardar para que los cambios surtan efecto.
                  </p>
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
