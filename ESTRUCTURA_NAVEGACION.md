# 📐 Estructura de Navegación

## 🎯 Rutas de la Aplicación

La aplicación tiene dos versiones: **Web** y **Electron**, cada una con sus propias rutas para evitar conflictos de navegación.

---

## 🌐 **Versión Web** (Navegador)

Cuando inicias sesión desde un **navegador web**:

```
/ (Login)
  ↓
/dashboard
  ↔ /configuracion
```

### Archivos:
- **Login**: `app/page.tsx`
- **Dashboard Web**: `app/dashboard/page.tsx`
- **Configuración Web**: `app/configuracion/page.tsx`

---

## 💻 **Versión Electron** (Escritorio)

Cuando inicias sesión desde **Electron**:

```
/ (Login)
  ↓
/dashboard-electron
  ↔ /configuracion-electron
```

### Archivos:
- **Login**: `app/page.tsx` (mismo para ambos)
- **Dashboard Electron**: `app/dashboard-electron/page.tsx`
- **Configuración Electron**: `app/configuracion-electron/page.tsx`

---

## ⚠️ **Problema Corregido**

### **Antes:**

Cuando estabas en Electron y navegabas a Configuración, el botón "Volver" te llevaba a `/dashboard` (versión web), mostrando una interfaz diferente.

### **Después:**

Ahora la navegación es consistente:
- ✅ **Dashboard Electron** → **Configuración Electron** → **Dashboard Electron**
- ✅ **Dashboard Web** → **Configuración Web** → **Dashboard Web**

---

## 🔍 **Cómo Funciona la Detección**

En `app/page.tsx` (Login), después de autenticarte:

```typescript
if (typeof window !== "undefined" && window.electron) {
  router.push("/dashboard-electron") // ✅ Electron
} else {
  router.push("/dashboard")          // ✅ Web
}
```

---

## 🎨 **Diferencias Visuales**

| Aspecto | Versión Web | Versión Electron |
|---------|-------------|------------------|
| **Título principal** | "Sistema de Respaldo Podio" | "Herramienta de respaldo de Podio" |
| **Alertas de API** | ✅ Muestra alertas de límites | ❌ No las muestra |
| **Descarga de archivos** | ⚠️ Simulada (limitada) | ✅ Real (con selector de carpeta) |
| **Estructura de carpetas** | ❌ No se crea físicamente | ✅ Se crea físicamente |

---

## 📋 **Archivos que NO se usan**

Estos archivos existen pero **NO generan rutas** en Next.js:
- `app/dashboard/page-electron.tsx` ❌
- `app/configuracion/page-electron.tsx` ❌

**Motivo**: Next.js solo reconoce `page.tsx` como ruta válida.

---

## ✅ **Verificación**

Para asegurarte de que estás en la versión correcta:

1. **Dashboard Electron** debe mostrar:
   - Cards simples con números grandes
   - Botón "Escanear" y "Iniciar Respaldo"
   - Tabla de últimos 10 respaldos

2. **Dashboard Web** debe mostrar:
   - Alertas amarillas sobre límites de API
   - Advertencia sobre restricciones del navegador
   - Estructura más detallada con logs visibles

---

**🎉 ¡Problema resuelto!** Ahora la navegación es consistente y no cambia de interfaz inesperadamente.

