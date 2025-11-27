# 🚀 Guía de Ejecución - Podio Backup (Electron)

## 📋 Requisitos Previos

- Node.js 18+ instalado
- npm o pnpm instalado

## 🔧 Instalación

```bash
# Instalar dependencias
npm install
# o
pnpm install
```

## ▶️ Ejecutar la Aplicación

### Opción 1: Desarrollo con Electron (Recomendado)

Este comando inicia Next.js y Electron automáticamente:

```bash
npm run electron-dev
```

Esto hará:
1. Iniciará el servidor de desarrollo de Next.js en `http://localhost:3000`
2. Esperará a que el servidor esté listo
3. Abrirá la aplicación Electron

### Opción 2: Ejecutar Manualmente

Si prefieres más control:

```bash
# Terminal 1: Iniciar Next.js
npm run dev

# Terminal 2: Ejecutar Electron (después de que Next.js esté corriendo)
npm run electron
```

## 🎯 Funcionalidades de Electron

### ✅ Creación de Carpetas
- **Automática**: El sistema crea automáticamente la estructura de carpetas
- **Permisos**: Verifica permisos de escritura antes de iniciar el backup
- **Recursiva**: Crea todas las subcarpetas necesarias

### ✅ Selección de Carpeta de Respaldo
- Al iniciar un respaldo, se abrirá un diálogo para seleccionar la carpeta de destino
- La ruta seleccionada se guarda en localStorage para futuros respaldos
- Puedes cambiar la carpeta en cualquier momento

### ✅ Descarga de Archivos
- **Con autenticación**: Los archivos se descargan con los headers OAuth2 correctos
- **Verificación**: Verifica que los archivos se descargaron correctamente
- **Tamaño**: Comprueba que los archivos no estén vacíos
- **Reintentos**: Sistema de reintentos automático en caso de fallos
- **Batches**: Descarga en lotes respetando los límites de API de Podio

### ✅ Límites de API Respetados
- **General**: 1,000 requests/hora
- **Rate-limited**: 250 requests/hora para descargas
- **Batches de descarga**: 200 archivos por lote (margen de 50)
- **Procesamiento paralelo controlado**:
  - 1 organización a la vez
  - 2 workspaces en paralelo
  - 3 aplicaciones en paralelo
  - 5 items en paralelo

### ✅ Gestión de Permisos
- Verifica permisos de escritura antes de iniciar
- Crea archivos de prueba para validar permisos
- Maneja errores de permisos con mensajes claros

## 📁 Estructura de Carpetas Creada

```
[Carpeta Seleccionada]/
├── [Organización]/
│   ├── [Workspace]/
│   │   ├── [Aplicación]/
│   │   │   ├── files/
│   │   │   │   ├── archivo1.pdf
│   │   │   │   ├── archivo2.jpg
│   │   │   │   └── ...
│   │   │   ├── excel/
│   │   │   │   └── [Aplicación]_items.xlsx
│   │   │   └── ...
```

## 🔍 Verificación de Archivos

El sistema verifica cada archivo descargado:
1. ✅ Existencia del archivo
2. ✅ Tamaño del archivo (debe ser > 0 bytes)
3. ✅ Registro en logs con detalles

## 📊 Logs Detallados

La aplicación muestra logs detallados de:
- ✅ Creación de carpetas
- ✅ Verificación de permisos
- ✅ Descarga de archivos
- ✅ Verificación de archivos
- ✅ Errores y advertencias
- ✅ Progreso del respaldo

## 🛠️ Depuración

### Ver logs de Electron

Los logs de Electron se muestran en la consola del terminal donde ejecutaste `npm run electron-dev`.

### Ver logs de Next.js

Los logs de Next.js se muestran en la consola de DevTools de Electron:
- Presiona `F12` o `Cmd+Option+I` (Mac) / `Ctrl+Shift+I` (Windows/Linux)
- Ve a la pestaña "Console"

### Verificar archivos descargados

1. Revisa la carpeta que seleccionaste para el respaldo
2. Navega a través de la estructura: Organización → Workspace → Aplicación → files
3. Verifica que los archivos tengan contenido (tamaño > 0)

## ⚙️ Configuración Avanzada

### Cambiar límites de batches

Edita `/lib/podio-service.ts`:

```typescript
private readonly BATCH_SIZES = {
  fileDownload: 200,  // Cambiar este valor
  fileInfo: 100
}
```

### Cambiar procesamiento paralelo

Edita `/lib/podio-service.ts`:

```typescript
private readonly PARALLEL_LIMITS = {
  organizations: 1,   // Organizaciones simultáneas
  workspaces: 2,      // Workspaces simultáneos
  applications: 3,    // Aplicaciones simultáneas
  items: 5,           // Items simultáneos
  files: 5            // Archivos simultáneos
}
```

## 🐛 Solución de Problemas

### Error: "No se pudo crear carpeta"
- Verifica que tienes permisos de escritura en la carpeta seleccionada
- Intenta seleccionar otra carpeta (ej: Documentos, Escritorio)

### Error: "Error al descargar archivo"
- Verifica tu conexión a internet
- Verifica que tu token de Podio no haya expirado
- Revisa los logs para más detalles

### Error: "Función no disponible en Electron"
- Asegúrate de estar ejecutando con `npm run electron-dev`
- Verifica que `main.js` y `preload.js` estén correctos

### Los archivos están vacíos (0 bytes)
- Puede ser un error de autenticación
- Verifica que tu token OAuth2 sea válido
- Revisa los logs de Electron para ver el error exacto

## 📦 Compilar para Producción

```bash
# Compilar la aplicación
npm run build

# Esto creará un instalador en la carpeta dist/
```

## 🔐 Seguridad

- Los tokens OAuth2 se almacenan en localStorage
- Las descargas usan HTTPS
- Los headers de autenticación se pasan de forma segura
- La aplicación usa `contextIsolation: true` para mayor seguridad

## 📝 Notas Importantes

1. **Primera ejecución**: En la primera ejecución, deberás autenticarte con Podio
2. **Selección de carpeta**: Se te pedirá seleccionar una carpeta para los respaldos
3. **Tiempo de ejecución**: Los respaldos grandes pueden tomar varias horas
4. **Límites de API**: El sistema respeta automáticamente los límites de Podio
5. **Pausas automáticas**: Si se alcanzan los límites, esperará automáticamente

## ✅ Checklist Pre-Ejecución

Antes de ejecutar el respaldo, verifica:

- [ ] Conexión a internet estable
- [ ] Token de Podio válido
- [ ] Espacio suficiente en disco
- [ ] Permisos de escritura en la carpeta de destino
- [ ] Node.js y dependencias instaladas

## 🎉 ¡Listo!

Ahora puedes ejecutar:

```bash
npm run electron-dev
```

Y comenzar a hacer respaldos de Podio con todas las funcionalidades optimizadas para Electron. 🚀

