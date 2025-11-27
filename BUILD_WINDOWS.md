# Construir ejecutable .exe para Windows desde macOS

## Requisitos

1. Tener `electron-builder` instalado (ya está en devDependencies)
2. Tener `wine` instalado si quieres crear instaladores NSIS (opcional pero recomendado)
3. **Importante**: `better-sqlite3` debe estar en `dependencies` (no en devDependencies) para que se incluya en el build

## Instalar Wine (opcional pero recomendado)

Wine permite a electron-builder crear instaladores NSIS en macOS:

```bash
# Con Homebrew
brew install --cask wine-stable
```

## Construir el ejecutable para Windows

### Opción 1: Instalador NSIS (recomendado)
Crea un instalador `.exe` con instalador:

```bash
npm run build:win
```

Esto generará un archivo `.exe` instalador en la carpeta `dist/`

### Opción 2: Portable (sin instalador)
Crea un ejecutable portable que no requiere instalación:

```bash
npm run build:win:portable
```

Esto generará un `.exe` portable en la carpeta `dist/`

### Opción 3: Construir para múltiples plataformas
```bash
npm run build:all
```

## Archivos generados

Los archivos se generarán en la carpeta `dist/`:

- **Instalador**: `Podio Backup-x.x.x-x64.exe` (o `-ia32.exe` para 32 bits)
- **Portable**: `Podio Backup-x.x.x-x64-portable.exe`

## Notas importantes

1. **Primera vez**: La primera construcción puede tardar varios minutos porque descarga los binarios de Electron para Windows.

2. **Sin Wine**: Si no tienes Wine instalado, electron-builder puede tener problemas para crear el instalador NSIS. En ese caso, usa la opción portable.

3. **Tamaño**: El ejecutable será bastante grande (~100-200 MB) porque incluye Node.js, Electron y todas las dependencias.

4. **Pruebas**: Siempre prueba el ejecutable en una máquina Windows antes de distribuirlo.

## Solución de problemas

### El ejecutable no abre en Windows

**Problema más común**: `better-sqlite3` no se compiló correctamente para Windows.

**Solución**:
1. Asegúrate de que `better-sqlite3` esté en `dependencies` (no en devDependencies)
2. Reconstruye las dependencias nativas:
   ```bash
   npm install
   npx electron-builder install-app-deps
   ```
3. Limpia y reconstruye:
   ```bash
   rm -rf dist node_modules
   npm install
   npm run build:win:portable
   ```

### Verificar que el ejecutable es x64

El build debe mostrar:
```
• packaging       platform=win32 arch=x64
```

Si muestra `arch=arm64`, el ejecutable no funcionará en Windows normal.

### Error: "Cannot find wine"
Si ves este error y quieres crear instaladores NSIS, instala Wine:

```bash
brew install --cask wine-stable
```

Si no quieres instalar Wine, usa la versión portable:

```bash
npm run build:win:portable
```

### Error: "Out of memory"
Si el build falla por memoria, aumenta el límite de Node.js:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm run build:win
```

### Limpiar builds anteriores
```bash
rm -rf dist .next
```

