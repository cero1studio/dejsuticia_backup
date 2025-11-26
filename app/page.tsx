"use client"

import type React from "react"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PodioBackupService } from "@/lib/podio-service"
import { getPodioCredentials } from "@/lib/podio-credentials"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertCircle, Eye, EyeOff, Clock } from "lucide-react"

export default function Login() {
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [rateLimitInfo, setRateLimitInfo] = useState<{ active: boolean; remainingSeconds: number; type: string } | null>(null)

  // Usar useRef para crear el servicio solo una vez
  const podioServiceRef = useRef<PodioBackupService | null>(null)
  
  // Verificar rate limit al cargar y cada 5 segundos (no cada segundo para evitar spam)
  useEffect(() => {
    // Crear servicio solo una vez
    if (!podioServiceRef.current) {
      podioServiceRef.current = new PodioBackupService()
    }
    
    const checkRateLimit = async () => {
      if (typeof window !== 'undefined' && window.electron && window.electron.db && podioServiceRef.current) {
        try {
          // NOTA: La limpieza de rate limits expirados se hace automáticamente
          // en getRateLimitStatusFromDb() en el backend, así que no necesitamos
          // llamarla aquí. Solo verificamos el estado.
          const info = await podioServiceRef.current.getRateLimitInfoFromDb()
          setRateLimitInfo(info)
        } catch (error) {
          // Silenciar errores - no es crítico si falla la verificación
        }
      }
    }

    // Verificar inmediatamente
    checkRateLimit()

    // Verificar cada 5 segundos (no cada segundo para reducir carga)
    const interval = setInterval(checkRateLimit, 5000)

    return () => clearInterval(interval)
  }, [])

  const formatTimeRemaining = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    
    if (hours > 0) {
      return `${hours}h ${minutes}m ${secs}s`
    } else if (minutes > 0) {
      return `${minutes}m ${secs}s`
    } else {
      return `${secs}s`
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError("")

    try {
      // CRÍTICO: Limpiar peticiones de autenticación antes de intentar autenticar
      // NOTA: La limpieza de rate limits expirados se hace automáticamente en getRateLimitStatusFromDb()
      if (typeof window !== 'undefined' && window.electron && window.electron.db) {
        try {
          // Limpiar todas las peticiones de autenticación de la BD
          try {
            if (window.electron.db.clearAuthenticationRequests) {
              const clearResult = await window.electron.db.clearAuthenticationRequests()
              if (clearResult.success && clearResult.cleared > 0) {
                console.log(`🔄 Limpiadas ${clearResult.cleared} peticiones de autenticación de la BD`)
              }
            }
          } catch (authError) {
            // Silenciar error - no es crítico
          }
          
          // Limpiar estados de rate limit (por si acaso quedó alguno)
          try {
            await window.electron.db.clearRateLimitStatus('general')
            await window.electron.db.clearRateLimitStatus('rateLimited')
          } catch (clearError) {
            // Silenciar error - no es crítico
          }
        } catch (clearError) {
          // Continuar de todas formas - no bloquear el login
        }
      }
      
      // Obtener credenciales desde la función utilitaria centralizada
      const credentials = getPodioCredentials()
      
      // Validar que las credenciales no estén vacías
      if (!credentials.clientId || !credentials.clientSecret) {
        setError("Error: No se han configurado las credenciales de API. Por favor configúralas en la página de configuración.")
        setIsLoading(false)
        return
      }

      console.log('🔑 Intentando autenticar con:', {
        clientId: credentials.clientId.substring(0, 10) + '...',
        hasClientSecret: !!credentials.clientSecret,
        backupAppId: credentials.backupAppId
      })

      // Usar el servicio del ref si existe, o crear uno nuevo solo para autenticación
      const podioService = podioServiceRef.current || new PodioBackupService()
      const success = await podioService.authenticate(
        credentials.clientId,
        credentials.clientSecret,
        username,
        password,
      )

      if (success) {
        // Almacenar solo las credenciales de usuario en sessionStorage
        sessionStorage.setItem(
          "podio_credentials",
          JSON.stringify({
            username,
            password,
          }),
        )

        // Redirigir al dashboard correcto según el entorno
        if (typeof window !== "undefined" && window.electron) {
          router.push("/dashboard-electron")
        } else {
          router.push("/dashboard")
        }
      } else {
        setError("Error de autenticación. Por favor verifica tus credenciales.")
      }
    } catch (err) {
      setError("Error de autenticación: " + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 items-center text-center">
          <div className="w-64 mx-auto mb-4">
            {/* Logo removido */}
          </div>
          <CardTitle className="text-2xl font-bold">Sistema de Respaldo Podio</CardTitle>
          <CardDescription>Ingresa tus credenciales de Podio para comenzar</CardDescription>
        </CardHeader>
        <form onSubmit={handleLogin}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Usuario</Label>
              <Input
                id="username"
                type="email"
                placeholder="Correo electrónico"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Contraseña</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="Contraseña de Podio"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700 focus:outline-none"
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              </div>
            </div>
            {rateLimitInfo && rateLimitInfo.active && rateLimitInfo.remainingSeconds > 0 && (
              <Alert variant="destructive" className="border-orange-500 bg-orange-50">
                <Clock className="h-4 w-4" />
                <AlertDescription className="font-semibold">
                  ⏰ Rate limit del servidor de Podio activo
                  <br />
                  <span className="text-sm font-normal">
                    Tiempo restante: <strong>{formatTimeRemaining(rateLimitInfo.remainingSeconds)}</strong>
                  </span>
                  <br />
                  <span className="text-xs text-gray-600 mt-1 block">
                    Debes esperar este tiempo antes de poder iniciar sesión. Este es un límite del servidor de Podio, no de la aplicación.
                  </span>
                </AlertDescription>
              </Alert>
            )}
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </CardContent>
          <CardFooter>
            <Button 
              className="w-full" 
              type="submit" 
              disabled={isLoading || (rateLimitInfo?.active && rateLimitInfo.remainingSeconds > 0)}
            >
              {isLoading 
                ? "Iniciando sesión..." 
                : (rateLimitInfo?.active && rateLimitInfo.remainingSeconds > 0)
                  ? `Espera ${formatTimeRemaining(rateLimitInfo.remainingSeconds)}`
                  : "Iniciar Sesión"
              }
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
