# Solución: Ejecutable no abre en Windows

## Problema Identificado

El ejecutable generado desde macOS no abre en Windows porque:

1. **better-sqlite3 no está compilado para Windows x64**: El módulo nativo `better-sqlite3` requiere binarios específicos para cada plataforma. Desde macOS (especialmente Apple Silicon), electron-builder intenta hacer cross-compile, lo cual no es soportado por `node-gyp`.

2. **El build muestra `arch=arm64`**: Aunque especificamos `--x64`, el build anterior mostraba `arch=arm64`, generando un ejecutable incompatible con la mayoría de máquinas Windows.

## Soluciones (en orden de recomendación)

### Solución 1: Construir desde Windows (RECOMENDADO)

La forma más confiable de generar un ejecutable funcional para Windows es construir desde una máquina Windows:

1. Clonar el repositorio en Windows
2. Instalar dependencias:
   ```bash
   npm install --legacy-peer-deps
   ```
3. Construir el ejecutable:
   ```bash
   npm run build:win:portable
   ```

### Solución 2: Usar GitHub Actions / CI/CD

Configurar un workflow de GitHub Actions que construya el ejecutable automáticamente en Windows:

```yaml
# .github/workflows/build-windows.yml
name: Build Windows Executable
on:
  push:
    tags:
      - 'v*'
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install --legacy-peer-deps
      - run: npm run build:win:portable
      - uses: actions/upload-artifact@v3
        with:
          name: windows-exe
          path: dist/*.exe
```

### Solución 3: Usar Docker con imagen Windows

Si tienes Docker Desktop:

```bash
# Desde macOS
docker run -it --rm -v "$(pwd):/app" -w /app mcr.microsoft.com/windows/servercore:ltsc2022 powershell
```

Luego dentro del contenedor:
```powershell
npm install --legacy-peer-deps
npm run build:win:portable
```

### Solución 4: Verificar y usar binarios precompilados

better-sqlite3 tiene binarios precompilados disponibles. Asegúrate de que el ejecutable los incluya:

1. Después del build, extrae el .exe (es un zip)
2. Verifica que exista: `resources/app.asar.unpacked/better-sqlite3/build/Release/better_sqlite3.node`
3. Debe ser para Windows x64, no ARM64

## Verificación del Ejecutable

Para verificar por qué no abre:

1. **Ejecutar desde terminal en Windows**:
   ```cmd
   "C:\ruta\al\ejecutable\Podio Backup-0.1.0-x64.exe"
   ```
   Esto mostrará los errores en la terminal.

2. **Verificar la arquitectura**:
   - El nombre debe ser `-x64.exe`
   - El tamaño debe ser ~130-150 MB

3. **Errores comunes**:
   - `The module 'better_sqlite3.node' was compiled against a different Node.js version`
     - **Solución**: El módulo no coincide con la versión de Electron. Reconstruir en Windows.
   - `Cannot find module 'better-sqlite3'`
     - **Solución**: El módulo no se incluyó en el build. Verificar `package.json` que esté en `dependencies`.

## Configuración Actual Corregida

He realizado estos cambios:

1. ✅ Movido `better-sqlite3` de `devDependencies` a `dependencies`
2. ✅ Configurado `asarUnpack` para incluir better-sqlite3
3. ✅ Agregado `--x64` flag a los scripts de build

**Pero aún necesitarás construir desde Windows o usar CI/CD** porque cross-compiling de módulos nativos no es soportado.

## Próximos Pasos

1. **Opción rápida**: Construir el ejecutable desde una máquina Windows
2. **Opción permanente**: Configurar GitHub Actions para builds automáticos
3. **Opción de prueba**: Usar el ejecutable actual y ver el error específico ejecutándolo desde terminal en Windows

## Comandos para Windows

Si tienes acceso a Windows:

```powershell
# Clonar y preparar
git clone <tu-repo>
cd podio-backup2

# Instalar
npm install --legacy-peer-deps

# Construir
npm run build:win:portable

# El ejecutable estará en dist/
```

