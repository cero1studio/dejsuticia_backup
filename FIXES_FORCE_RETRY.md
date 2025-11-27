# Fixes: Force Retry Behavior

## Problema Reportado
El usuario reportó que después de presionar el botón "Forzar Reintento", el sistema seguía contando el rate limit en lugar de intentar hacer peticiones inmediatamente.

## Causa Raíz
1. **Rate limits no se limpiaban al iniciar escaneo**: El método `scanBackup` no tenía código para limpiar los rate limits de la BD y memoria al iniciar, por lo que si había un rate limit guardado de una sesión anterior, se leía inmediatamente y bloqueaba el escaneo.

2. **Intervalo del UI seguía leyendo el rate limit**: Aunque el botón "Forzar Reintento" llamaba a `forceRetryAfterRateLimit()` para limpiar el rate limit, había un `setInterval` que corría cada segundo y volvía a leer el estado del rate limit desde el servicio.

## Solución Implementada

### 1. Limpiar Rate Limits al Iniciar Escaneo
Se agregó código en `lib/podio-service.ts` → `scanBackup()` para limpiar rate limits al inicio:

```typescript
// ========================================================================
// LIMPIAR RATE LIMITS AL INICIAR ESCANEO (USUARIO DECIDIÓ CONTINUAR)
// ========================================================================
if (typeof window !== 'undefined' && window.electron && window.electron.db) {
  try {
    await window.electron.db.clearRateLimitStatus('general')
    await window.electron.db.clearRateLimitStatus('rateLimited')
    this.activeRateLimit = null // Limpiar también el rate limit en memoria
    this.addLog("info", "🔄 Rate limits limpiados al iniciar escaneo...")
  } catch (error) {
    this.addLog("warning", `No se pudieron limpiar rate limits: ${error instanceof Error ? error.message : String(error)}`)
  }
}
```

### 2. Limpiar Rate Limits en el UI al Iniciar Escaneo
Se agregó código en `app/dashboard-electron/page.tsx` → `scanBackup()` para limpiar estados del UI:

```typescript
// Borrar rate limits al iniciar escaneo (usuario decidió continuar)
if (typeof window !== 'undefined' && window.electron && window.electron.db) {
  try {
    await window.electron.db.clearRateLimitStatus('general')
    await window.electron.db.clearRateLimitStatus('rateLimited')
    setRateLimit({ active: false, remainingSeconds: 0, type: "none" })
    setIsPausedByRateLimit(false)
    console.log('🔄 Rate limits limpiados antes de iniciar escaneo')
  } catch (error) {
    console.warn('No se pudieron limpiar rate limits:', error)
  }
}
```

### 3. Mejorar el Botón "Forzar Reintento"
Se mejoró el handler del botón en `app/dashboard-electron/page.tsx` para:
- Limpiar estados del UI inmediatamente (detiene el contador)
- Agregar logs claros en consola
- Actualizar el mensaje de estado

```typescript
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
```

## Comportamiento Esperado Ahora

### Al Iniciar Escaneo o Descarga
1. ✅ Se limpian rate limits de BD (tabla `rate_limit_status`)
2. ✅ Se limpia `activeRateLimit` en memoria del servicio
3. ✅ Se limpian estados del UI (`rateLimit`, `isPausedByRateLimit`)
4. ✅ El escaneo/descarga comienza inmediatamente
5. ✅ Solo se aplica rate limit si el servidor responde con 429/420

### Al Presionar "Forzar Reintento"
1. ✅ Se llama a `podioService.forceRetryAfterRateLimit()`
2. ✅ Se limpia `activeRateLimit = null` en el servicio
3. ✅ Se limpia rate limit de BD
4. ✅ Se limpian estados del UI inmediatamente
5. ✅ El contador se detiene
6. ✅ El intervalo (que corre cada 1 segundo) lee `active: false` del servicio
7. ✅ El proceso continúa automáticamente haciendo peticiones
8. ✅ Solo se vuelve a aplicar rate limit si Podio responde 429/420

### Intervalo de Monitoreo (cada 1 segundo)
```typescript
rateLimitIntervalRef.current = setInterval(() => {
  const info = podioService.getRateLimitInfo()
  setRateLimit(info)
  if (info.active && !isPausedByRateLimit) setIsPausedByRateLimit(true)
  if (!info.active && isPausedByRateLimit) setIsPausedByRateLimit(false)
}, 1000)
```

- Después de forzar reintento, `getRateLimitInfo()` devuelve `active: false`
- El UI actualiza el estado inmediatamente
- Solo vuelve a mostrar rate limit si hay uno nuevo desde el servidor

## Testing
Para probar:

1. **Iniciar escaneo con rate limit guardado en BD**:
   - Esperar: El escaneo debe limpiar el rate limit y comenzar inmediatamente
   - Log esperado: "🔄 Rate limits limpiados al iniciar escaneo..."

2. **Presionar "Forzar Reintento" cuando hay rate limit activo**:
   - Esperar: El contador debe detenerse inmediatamente
   - Esperar: El mensaje debe cambiar a "🔄 Reintento forzado - Continuando..."
   - Esperar: El proceso debe continuar haciendo peticiones
   - Log esperado: "✅ Rate limit limpiado en memoria y BD"

3. **Verificar que rate limit se vuelve a aplicar si el servidor responde 429/420**:
   - Si Podio realmente está en rate limit, debe aparecer de nuevo
   - Esto es el comportamiento correcto (no es un bug)

## Archivos Modificados
1. `lib/podio-service.ts` - `scanBackup()` method
2. `app/dashboard-electron/page.tsx` - `scanBackup()` function y botón "Forzar Reintento"








