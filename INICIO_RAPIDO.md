# 🚀 Inicio Rápido - Podio Backup Electron

## ⚡ 3 Pasos para Empezar

### 1️⃣ Instalar Dependencias
```bash
npm install
```

### 2️⃣ Ejecutar Electron
```bash
npm run electron-dev
```

### 3️⃣ Usar la Aplicación
1. ✅ La aplicación se abrirá automáticamente
2. ✅ Configura tus credenciales de Podio
3. ✅ Selecciona la carpeta de respaldo cuando se te solicite
4. ✅ Inicia el escaneo o respaldo

---

## 🎯 Lo Que Hace la Aplicación

### ✅ Escaneo
1. Se conecta a Podio con tus credenciales
2. Escanea organizaciones, workspaces, apps, items y archivos
3. Calcula el tamaño total del respaldo
4. Muestra estadísticas detalladas

### ✅ Respaldo Completo
1. Descarga todos los archivos de Podio
2. Crea estructura organizada de carpetas
3. Verifica cada archivo descargado
4. Genera archivos Excel con los datos
5. Respeta los límites de API de Podio

---

## 📊 Límites Configurados

- **API General**: 1,000 requests/hora
- **API Rate-Limited**: 250 requests/hora
- **Batch de Descarga**: 200 archivos por lote
- **Procesamiento Paralelo**: Controlado y optimizado

---

## 🔧 Solución Rápida de Problemas

### ❌ Error: "Cannot find module..."
```bash
npm install
```

### ❌ Error: "EACCES: permission denied"
- Selecciona otra carpeta con permisos de escritura
- Prueba con Documentos, Escritorio o Downloads

### ❌ Error: "401 Unauthorized"
- Vuelve a autenticarte en Podio
- Verifica que tu Client ID y Secret sean correctos

### ❌ La ventana no se abre
```bash
# Intenta ejecutar paso por paso:
# Terminal 1:
npm run dev

# Terminal 2 (después de que Next.js esté listo):
npm run electron
```

---

## 📁 Estructura de Respaldo Creada

```
[Tu Carpeta Seleccionada]/
└── [Organización]/
    └── [Workspace]/
        └── [Aplicación]/
            ├── files/              ← Archivos descargados aquí
            │   ├── documento1.pdf
            │   ├── imagen1.jpg
            │   └── ...
            └── excel/              ← Archivos Excel aquí
                └── [App]_items.xlsx
```

---

## 🎉 ¡Eso es Todo!

Con estos 3 pasos ya puedes:
- ✅ Escanear tu Podio completo
- ✅ Descargar respaldos automáticos
- ✅ Ver logs en tiempo real
- ✅ Verificar archivos descargados

---

## 📖 Más Información

- **Guía Completa**: Ver `ELECTRON_README.md`
- **Cambios Técnicos**: Ver `CAMBIOS_ELECTRON.md`

---

## 💡 Consejos

### Primera Ejecución - Modo de Prueba

**⚠️ IMPORTANTE**: En la primera ejecución, activa el **Modo de Prueba**:

```bash
# Ejecutar la aplicación
npm run electron-dev
```

1. ✅ Una vez abierta, ve a **Configuración → Configuración de API**
2. ✅ Activa el switch **"🧪 Modo de Prueba"**
3. ✅ Verás una alerta amarilla con los límites configurados
4. ✅ Ahora puedes hacer un escaneo o backup de prueba

El modo de prueba procesará solo el **10%** de tus datos:
- ✅ Prueba todo el flujo completo
- ✅ Crea carpetas, descarga archivos, genera Excel
- ✅ No satura la API de Podio
- ✅ Termina en minutos en lugar de horas

**Ver documentación completa**: `MODO_PRUEBA.md`

### Después de Probar

Una vez verificado que todo funciona:

1. ✅ Regresa a **Configuración → Configuración de API**
2. ✅ Desactiva el switch **"🧪 Modo de Prueba"**
3. ✅ Ejecuta el backup completo

### Flujo Recomendado

1. **Primera vez**: Escanear en modo de prueba
2. **Segunda vez**: Backup completo en modo de prueba  
3. **Tercera vez**: Backup completo en modo normal

Esto te dará una idea del tiempo que tomará el respaldo. 🕒

---

## 🆘 Necesitas Ayuda?

Revisa los logs en:
- **Terminal**: Logs de Electron/Node.js
- **DevTools** (F12): Logs de Next.js/React

Los errores aparecen en color rojo con el símbolo ❌

---

**¡Listo para empezar!** 🚀

```bash
npm run electron-dev
```

