# Nota sobre Cross-Compiling para Windows desde macOS

## Problema
Los módulos nativos de Node.js (como `better-sqlite3`) no se pueden compilar directamente desde macOS para Windows debido a limitaciones de `node-gyp`.

## Soluciones

### Opción 1: Compilar en Windows (Recomendado)
1. Transferir el código a una máquina Windows
2. Ejecutar `npm install`
3. Ejecutar `npm run build:win:portable`
4. El ejecutable se generará en `dist/`

### Opción 2: Usar CI/CD (GitHub Actions)
Se puede configurar GitHub Actions para compilar automáticamente en Windows cuando se hace push al repositorio.

### Opción 3: Usar Docker o VM Windows
Ejecutar el build dentro de un contenedor Docker con Windows o una máquina virtual Windows.

## Estado Actual
- ✅ Código corregido para iniciar servidor Next.js en producción
- ✅ La aplicación debería abrirse correctamente en Windows
- ❌ El build falla en macOS porque no puede compilar `better-sqlite3` para Windows

## Para Generar el Ejecutable
**Necesitas ejecutar el build en una máquina Windows** o configurar un servicio de CI/CD que compile en Windows.

