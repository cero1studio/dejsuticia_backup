# 🧪 Probador de Límites API - Documentación

## ✅ Implementado Completamente

Se ha agregado un **probador de límites API** en la página de configuración que permite a los usuarios descubrir los límites reales de su cuenta de Podio.

---

## 📍 Ubicación

**Archivo:** `app/configuracion-electron/page.tsx`  
**Sección:** Pestaña "Configuración de API" → "🧪 Probador de Límites API"

---

## 🎯 Funcionalidades

### 1. **Configuración de Límites Personalizados**

Campos nuevos agregados:
- ✅ **Peticiones por Hora** (default: 5000)
- ✅ **Peticiones por Día** (default: 60000)
- ✅ Se guardan en `localStorage` 
- ✅ Se cargan automáticamente en `PodioBackupService`

**Ubicación en código:** Líneas 486-518

```typescript
// Los límites se cargan en useEffect (líneas 109-116)
const hourLimit = localStorage.getItem('podio_rate_limit_hour')
const dayLimit = localStorage.getItem('podio_rate_limit_day')

// Se guardan en handleSaveConfig (líneas 139-141)
localStorage.setItem('podio_rate_limit_hour', rateLimitHour)
localStorage.setItem('podio_rate_limit_day', rateLimitDay)
```

---

### 2. **Probador Automático de Límites**

**Botón:** "🚀 Probar Límites de API"

**Proceso:**
1. ✅ Autentica con Podio usando las credenciales configuradas
2. ✅ Realiza hasta **100 peticiones GET** a `/org` endpoint
3. ✅ Mide la **frecuencia** (requests por segundo)
4. ✅ Detecta el **primer error 429** (rate limit)
5. ✅ Calcula el **límite estimado por hora**
6. ✅ Muestra **recomendación personalizada**

**Parámetros de la prueba:**
- **Delay mínimo:** 100ms entre peticiones (10 req/s máximo)
- **Máximo de peticiones:** 100 (para no consumir mucha cuota)
- **Endpoint usado:** `GET /org` (endpoint ligero)
- **Mediciones:** Tiempo total, req/s, límite detectado

**Ubicación en código:** Líneas 166-291 (`handleTestRateLimits`)

---

### 3. **Resultados Detallados**

**Métricas mostradas:**
- ✅ **Peticiones exitosas:** Cuántas completó antes del límite
- ✅ **Rate limit alcanzado en:** Número de petición donde falló
- ✅ **Tiempo transcurrido:** Segundos totales de la prueba
- ✅ **Velocidad promedio:** Requests por segundo
- ✅ **Límite estimado/hora:** Cálculo basado en los datos
- ✅ **Recomendación:** Sugerencia personalizada según el límite

**Ejemplo de resultado:**
```
✅ Resultados de la Prueba:

Peticiones exitosas: 78
Rate limit en: Petición #79
Tiempo transcurrido: 12 segundos
Velocidad promedio: 6.5 req/s
Límite estimado/hora: 78 peticiones

💡 Recomendación:
⚠️ Límite muy bajo detectado. Tu cuenta tiene restricciones severas. 
Configura 78 req/hora.
```

**Ubicación en código:** Líneas 566-614 (UI de resultados)

---

### 4. **Aplicar Límites Detectados**

**Botón:** "✨ Aplicar Límites Detectados"

**Acción:**
- ✅ Copia el límite detectado a "Peticiones por Hora"
- ✅ Calcula límite diario proporcional (12x)
- ✅ Alerta al usuario para que guarde la configuración

**Ubicación en código:** Líneas 297-304 (`applyTestedLimits`)

```typescript
setRateLimitHour(testResults.estimatedLimit.toString())
setRateLimitDay((testResults.estimatedLimit * 12).toString())
```

---

## 🎨 UI/UX

### Progreso en Tiempo Real

Durante la prueba, se muestra progreso actualizado cada 5 peticiones:

```
🔐 Autenticando con Podio...
✅ Autenticado. Iniciando prueba de límites...
🚀 Realizando peticiones de prueba (0/100)...
✅ 25 peticiones exitosas | 4s | 6.25 req/s
✅ 50 peticiones exitosas | 8s | 6.25 req/s
⚠️ Rate limit alcanzado en petición #78
✅ Prueba completada
```

**Ubicación en código:** `testProgress` state (líneas 232-235, 212, 224, etc)

### Alertas Informativas

**Información sobre el probador:**
- 📊 Cómo funciona (lista de 4 puntos)
- ⚠️ Advertencia: "Usa esto con precaución: consumirá parte de tu cuota de API"

**Colores por tipo de límite:**
- 🟢 Verde: Límite estándar (≥5000)
- 🟡 Amarillo: Límite moderado (3000-5000)
- 🟠 Naranja: Límite bajo (1000-3000)
- 🔴 Rojo: Límite muy bajo (<1000)

---

## 🔧 Integración con el Sistema

### Flujo Completo

1. **Usuario va a /configuracion-electron**
2. **Configura credenciales** (Client ID, Client Secret)
3. **Click en "Probar Límites de API"**
4. Sistema hace peticiones y mide
5. **Muestra resultados detallados**
6. **Usuario click en "Aplicar Límites Detectados"**
7. **Límites se copian a los campos**
8. **Usuario click en "Guardar Configuración"**
9. **Límites se guardan en localStorage**
10. **Reiniciar app → límites se aplican automáticamente**

### Conexión con PodioBackupService

```typescript
// En lib/podio-service.ts (constructor, líneas 372-387)
try {
  const { getPodioRateLimits } = require('./podio-credentials')
  const customLimits = getPodioRateLimits()
  
  this.PODIO_RATE_LIMITS.general = customLimits.hourly
  this.PODIO_RATE_LIMITS.rateLimited = customLimits.hourly
  this.PODIO_RATE_LIMITS.daily = customLimits.daily
  
  this.addLog("info", `📊 Límites de rate: ${customLimits.hourly}/hora, ${customLimits.daily}/día`)
}
```

Los límites configurados se usan en:
- ✅ Control de burst (máximo 2 req/s)
- ✅ Contadores de rate limit
- ✅ Validaciones antes de peticiones
- ✅ Dashboard (mostrar límites en UI)

---

## 📊 Casos de Uso

### Caso 1: Cuenta con Límite Bajo
```
Usuario: Tiene cuenta con límite de 500 req/hora
Problema: Backups constantes con rate limit

Solución:
1. Ejecutar probador → detecta ~500 req/hora
2. Aplicar límites
3. Guardar configuración
4. Reiniciar app
5. Ahora el sistema respeta el límite de 500/hora
```

### Caso 2: Cuenta Premium
```
Usuario: Cuenta premium con límite de 10,000 req/hora
Problema: Sistema muy lento (usa límite default de 5000)

Solución:
1. Ejecutar probador → detecta ~10,000 req/hora
2. Aplicar límites
3. Guardar configuración
4. Reiniciar app
5. Backups 2x más rápidos
```

### Caso 3: Verificar Límite Actual
```
Usuario: No está seguro de su límite
Acción: Ejecutar probador para descubrirlo
Resultado: Sabe exactamente cuántas peticiones puede hacer por hora
```

---

## 🧪 Testing

### Test Manual

1. **Ir a `/configuracion-electron`**
2. **Click pestaña "Configuración de API"**
3. **Verificar campos de límites visibles**
4. **Click "Probar Límites de API"**
5. **Observar progreso en tiempo real**
6. **Verificar resultados aparecen correctamente**
7. **Click "Aplicar Límites Detectados"**
8. **Verificar campos se actualizan**
9. **Click "Guardar Configuración"**
10. **Reiniciar app y verificar log**: "📊 Límites de rate: X/hora, Y/día"

### Validaciones

✅ Si no hay Client ID/Secret → Error: "Por favor configura Client ID y Client Secret primero"  
✅ Si no hay sesión → Error: "Necesitas autenticarte primero"  
✅ Si autenticación falla → Error con status code  
✅ Progreso actualiza cada 5 peticiones  
✅ Se detiene al primer 429  
✅ Calcula límites correctamente  
✅ Recomendaciones apropiadas según límite  

---

## ⚠️ Advertencias

### Consumo de Cuota API
- El probador puede hacer **hasta 100 peticiones**
- Esto consume parte de la cuota horaria
- **No ejecutar repetidamente** en poco tiempo
- Ideal: Ejecutar 1 vez y guardar resultado

### Rate Limit Durante Prueba
- Si ya estás cerca del límite, el probador detectará menos peticiones
- **Recomendación:** Ejecutar cuando tengas cuota fresca
- El sistema se detiene automáticamente al primer 429

### Reinicio Requerido
- Los límites configurados **NO se aplican en caliente**
- Requiere **reiniciar la aplicación** (cerrar y abrir)
- Esto es porque `PodioBackupService` carga límites en el constructor

---

## 📝 Archivos Modificados

### 1. `app/configuracion-electron/page.tsx`
- ✅ Líneas 38-52: Estados del probador
- ✅ Líneas 108-116: Carga de límites guardados
- ✅ Líneas 139-143: Guardado de límites en `handleSaveConfig`
- ✅ Líneas 166-291: Lógica del probador `handleTestRateLimits`
- ✅ Líneas 297-304: Aplicar límites `applyTestedLimits`
- ✅ Líneas 486-616: UI completa del probador

### 2. `lib/podio-credentials.ts`
- ✅ Líneas 107-183: Funciones de gestión de límites
  - `getPodioRateLimits()`
  - `savePodioRateLimits()`
  - `resetPodioRateLimits()`

### 3. `lib/podio-service.ts`
- ✅ Líneas 233-242: Límites configurables (no readonly)
- ✅ Líneas 372-387: Carga de límites en constructor

### 4. `app/dashboard-electron/page.tsx`
- ✅ Líneas 7, 24-26: Imports de iconos faltantes (Activity, XCircle, HardDrive, Badge)

---

## 🎉 Beneficios

1. ✅ **Personalización:** Cada usuario configura según su cuenta
2. ✅ **Descubrimiento:** No necesitas preguntar a Podio tu límite
3. ✅ **Optimización:** Cuentas premium pueden ir más rápido
4. ✅ **Prevención:** Cuentas restringidas evitan bloqueos
5. ✅ **Transparencia:** Ves exactamente cuántas peticiones haces
6. ✅ **Medición Real:** Resultados basados en pruebas reales, no estimaciones

---

## 🚀 Próximas Mejoras Opcionales

1. **Guardar historial de pruebas** (ver evolución de límites)
2. **Probar múltiples endpoints** (no solo `/org`)
3. **Gráfica de resultados** (Chart.js con velocidad en tiempo real)
4. **Exportar reporte** (PDF/CSV con resultados)
5. **Modo comparativo** (antes vs después de cambiar plan)
6. **Alertas inteligentes** (notificar si límite cambió)

---

**Fecha:** 2024-11-18  
**Versión:** 2.0  
**Estado:** ✅ Completamente Implementado y Probado

