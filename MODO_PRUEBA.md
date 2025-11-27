# 🧪 Modo de Prueba - Podio Backup

## 📋 ¿Qué es el Modo de Prueba?

El **Modo de Prueba** te permite probar todo el flujo de backup (escaneo, creación de carpetas, descarga de archivos, generación de Excel) pero procesando solo un **porcentaje limitado** de tus datos.

Esto es perfecto para:
- ✅ Probar que todo funciona correctamente
- ✅ Evitar saturar la API de Podio durante pruebas
- ✅ Reducir el tiempo de testing
- ✅ Verificar la estructura de carpetas y archivos
- ✅ No afectar tu límite de requests de Podio

---

## ⚙️ Configuración Actual

Por defecto, el modo de prueba procesa:

| Nivel | Porcentaje | Máximo Absoluto |
|-------|------------|-----------------|
| **Workspaces** | 10% | Máx 2 workspaces |
| **Aplicaciones** | 10% | Máx 2 aplicaciones |
| **Items** | 10% | Máx 5 items |
| **Archivos** | 10% | Máx 10 archivos |

Esto significa que si tienes:
- 20 workspaces → procesa 2
- 50 aplicaciones → procesa 5 (pero máx 2 por workspace)
- 100 items → procesa 10 (pero máx 5 por app)
- 200 archivos → procesa 10 (límite absoluto)

---

## 🚀 Cómo Activar el Modo de Prueba

### Desde la Interfaz (Recomendado) ✨

1. **Abre la aplicación** y navega a **Configuración**
2. Ve a la pestaña **"Configuración de API"**
3. Encontrarás el switch **"🧪 Modo de Prueba"**
4. **Actívalo** y verás inmediatamente los detalles de los límites

![Modo de Prueba en la UI]

¡Así de fácil! No necesitas tocar código ni archivos de configuración.

---

## 🔄 Cómo Desactivar el Modo de Prueba

Simplemente regresa a **Configuración → Configuración de API** y **desactiva el switch**.

El cambio es instantáneo y se aplica al siguiente escaneo o backup que realices.

---

## 🎨 Personalizar los Límites

Puedes ajustar los límites editando el archivo `lib/podio-service.ts`:

```typescript
const TEST_MODE_CONFIG = {
  enabled: false,
  // Porcentajes de datos a procesar (0-100)
  workspacesPercent: 10,      // ← Cambia esto
  applicationsPercent: 10,    // ← Cambia esto
  itemsPercent: 10,           // ← Cambia esto
  filesPercent: 10,           // ← Cambia esto
  // Límites absolutos como fallback
  maxWorkspaces: 2,           // ← Cambia esto
  maxApps: 2,                 // ← Cambia esto
  maxItems: 5,                // ← Cambia esto
  maxFiles: 10                // ← Cambia esto
};
```

---

## 📊 Ejemplo de Uso

### Paso 1: Activar Modo de Prueba

```bash
echo "NEXT_PUBLIC_PODIO_TEST_MODE=true" > .env.local
```

### Paso 2: Ejecutar la Aplicación

```bash
npm run electron-dev
```

### Paso 3: Ver los Logs

Cuando escanees o hagas backup, verás:

```
🧪 ========== MODO DE PRUEBA ACTIVO ==========
🧪 Workspaces: 10% (máx 2)
🧪 Aplicaciones: 10% (máx 2)
🧪 Items: 10% (máx 5)
🧪 Archivos: 10% (máx 10)
🧪 ==========================================
...
🧪 MODO PRUEBA: Procesando 2 de 15 espacios (10%)
🧪 MODO PRUEBA: Procesando 2 de 20 apps en Workspace X (10%)
🧪 MODO PRUEBA: Procesando 5 de 50 items en App Y (10%)
🧪 MODO PRUEBA: Límite de archivos alcanzado (10 archivos)
```

### Paso 4: Verificar Resultados

Revisa que:
- ✅ Se crearon las carpetas correctamente
- ✅ Se descargaron algunos archivos de prueba
- ✅ Se generaron los archivos Excel
- ✅ Los logs muestran el progreso correctamente

### Paso 5: Desactivar y Hacer Backup Completo

```bash
# Eliminar modo de prueba
rm .env.local

# O cambiar a false
echo "NEXT_PUBLIC_PODIO_TEST_MODE=false" > .env.local

# Ejecutar backup completo
npm run electron-dev
```

---

## 💡 Tips y Recomendaciones

### 1. **Siempre prueba primero en modo de prueba**
Antes de hacer un backup completo de producción, haz una prueba para verificar que todo funciona.

### 2. **Ajusta los límites según tus necesidades**
Si tienes muchos datos:
- Usa porcentajes más bajos (5%, 3%)
- O limita por cantidad absoluta

### 3. **Verifica los archivos descargados**
Abre algunos archivos descargados para asegurarte de que no están corruptos.

### 4. **Revisa los logs**
Los logs te mostrarán claramente cuántos elementos se procesaron vs cuántos había disponibles.

### 5. **Prueba el flujo completo**
El modo de prueba ejecuta TODO el flujo:
- Escaneo
- Creación de carpetas
- Descarga de archivos
- Generación de Excel
- Verificación de archivos

---

## 🔍 Cómo Verificar que Está Activo

Cuando ejecutes un escaneo o backup, verás en los logs:

```
🧪 ========== MODO DE PRUEBA ACTIVO ==========
```

Si no ves este mensaje, el modo de prueba NO está activo.

---

## 📈 Comparativa: Normal vs Modo de Prueba

| Aspecto | Modo Normal | Modo de Prueba |
|---------|-------------|----------------|
| **Workspaces** | Todos | 10% (máx 2) |
| **Aplicaciones** | Todas | 10% (máx 2) |
| **Items** | Todos | 10% (máx 5) |
| **Archivos** | Todos | 10% (máx 10) |
| **Tiempo** | Horas | Minutos |
| **API Requests** | Miles | ~100 |
| **Espacio en Disco** | GB | MB |

---

## ⚠️ Importante

- El modo de prueba **NO afecta** el comportamiento en producción
- Puedes activarlo/desactivarlo en cualquier momento
- Los límites se aplican **por nivel** (workspace → app → item → file)
- Los archivos de prueba se guardan en la misma estructura que el backup completo

---

## 🐛 Solución de Problemas

### El modo de prueba no se activa

1. Verifica que `.env.local` existe en la raíz del proyecto
2. Verifica que la variable está bien escrita: `NEXT_PUBLIC_PODIO_TEST_MODE=true`
3. Reinicia la aplicación

### Se procesan más elementos de los esperados

Los límites son por nivel. Por ejemplo:
- Máx 2 workspaces
- Cada workspace tiene máx 2 apps
- = Total 4 apps (2×2)

Esto es correcto y esperado.

### Quiero procesar más/menos datos

Edita `TEST_MODE_CONFIG` en `lib/podio-service.ts` y ajusta los porcentajes o límites absolutos.

---

## 📝 Ejemplo Real

Si tienes:
- 1 organización
- 10 workspaces
- 30 apps por workspace (300 total)
- 100 items por app (30,000 total)
- 5 archivos por item (150,000 total)

Con modo de prueba (10%, máx configurados):
- ✅ Procesará: 1 org → 2 workspaces → 4 apps → 10 items → 10 archivos
- ⏱️ Tiempo: ~2-5 minutos
- 📊 API Requests: ~50-100

Sin modo de prueba:
- ⚠️ Procesará: 1 org → 10 workspaces → 300 apps → 30,000 items → 150,000 archivos
- ⏱️ Tiempo: ~10-20 horas
- 📊 API Requests: ~180,000 (requeriría múltiples ventanas de 1 hora)

---

## ✅ Checklist de Prueba

Antes de hacer el backup completo:

- [ ] Activar modo de prueba
- [ ] Ejecutar escaneo
- [ ] Verificar logs (mensaje "MODO DE PRUEBA ACTIVO")
- [ ] Verificar que se crearon las carpetas
- [ ] Verificar que se descargaron algunos archivos
- [ ] Abrir algunos archivos para verificar que no están corruptos
- [ ] Verificar que se generaron archivos Excel
- [ ] Desactivar modo de prueba
- [ ] Ejecutar backup completo

---

**¡Listo para probar!** 🚀

```bash
# Activar modo de prueba
echo "NEXT_PUBLIC_PODIO_TEST_MODE=true" > .env.local

# Ejecutar
npm run electron-dev
```

