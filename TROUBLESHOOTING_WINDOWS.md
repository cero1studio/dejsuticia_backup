# Solución de problemas: Ejecutable no abre en Windows

## Problemas comunes y soluciones

### 1. El ejecutable no se abre o se cierra inmediatamente

**Causa más probable**: `better-sqlite3` no está compilado para Windows x64.

**Solución paso a paso**:

1. **Mover `better-sqlite3` a dependencies**:
   - Verifica que esté en `dependencies` y no en `devDependencies` en `package.json`

2. **Limpiar y reinstalar**:
   ```bash
   rm -rf node_modules package-lock.json dist
   npm install
   ```

3. **Reconstruir dependencias nativas para Windows x64**:
   ```bash
   npx electron-builder install-app-deps --platform=win32 --arch=x64
   ```

4. **Reconstruir el ejecutable**:
   ```bash
   npm run build:win:portable
   ```

### 2. Verificar que se está construyendo para x64

Durante el build, deberías ver:
```
• packaging       platform=win32 arch=x64 electron=37.8.0
```

Si ves `arch=arm64`, está construyendo para ARM64 (Windows ARM) en lugar de x64 (Windows Intel/AMD).

### 3. El ejecutable abre pero se cierra inmediatamente

Esto generalmente indica un error en el código. Para ver los logs:

1. Abre una terminal en Windows
2. Ejecuta el .exe desde la terminal:
   ```cmd
   "C:\ruta\al\ejecutable\Podio Backup-0.1.0-x64.exe"
   ```
3. Los errores aparecerán en la terminal

### 4. Error: "The module 'better_sqlite3.node' was compiled against..."

**Solución**: 
```bash
npm install --legacy-peer-deps
npx electron-builder install-app-deps
npm run build:win:portable
```

### 5. Verificar el contenido del ejecutable

El ejecutable debe incluir:
- `resources/app.asar` (aplicación empaquetada)
- `resources/app.asar.unpacked/better-sqlite3/` (módulos nativos)

Para verificar:
1. Extrae el .exe (es un zip)
2. Verifica que exista `better-sqlite3` en `resources/app.asar.unpacked/`

## Comando completo de reconstrucción

Si nada funciona, prueba este proceso completo:

```bash
# 1. Limpiar todo
rm -rf node_modules package-lock.json dist .next

# 2. Reinstalar dependencias
npm install --legacy-peer-deps

# 3. Construir el ejecutable (electron-builder descargará automáticamente los binarios correctos)
npm run build:win:portable
```

**Nota importante**: No intentes hacer cross-compile manual de `better-sqlite3`. electron-builder descargará automáticamente los binarios precompilados para Windows x64 durante el build. El error de "cross-compiling" es normal cuando intentas hacerlo manualmente, pero electron-builder lo maneja automáticamente.

## Verificar que el ejecutable funciona

Después de construir:

1. **Verifica el tamaño**: Debe ser ~130-150 MB
2. **Verifica la arquitectura**: El nombre del archivo debe ser `-x64.exe`
3. **Prueba en Windows**: 
   - Doble clic debe abrir la aplicación
   - Si no abre, ejecuta desde terminal para ver errores

