# Instrucciones para Compilar en Windows

## ✅ Ventajas de Compilar en Windows

1. **Sin problemas de cross-compiling**: Los módulos nativos se compilan correctamente
2. **Más rápido**: No hay necesidad de configuraciones especiales
3. **Más confiable**: Genera el ejecutable nativo sin errores
4. **Más simple**: Solo ejecutar comandos estándar

## 📋 Requisitos Previos en Windows

1. **Node.js** (versión 18 o superior)
   - Descargar desde: https://nodejs.org/
   - Verificar instalación: `node --version` y `npm --version`

2. **Git** (opcional, si clonas desde repositorio)
   - Descargar desde: https://git-scm.com/download/win

## 🚀 Pasos para Compilar

### 1. Preparar el Proyecto

```bash
# Si clonas desde repositorio:
git clone <tu-repositorio>
cd podio-backup2

# O si transfieres los archivos:
# Copia toda la carpeta del proyecto a Windows
cd podio-backup2
```

### 2. Instalar Dependencias

```bash
npm install
```

**Nota**: Esto puede tardar varios minutos la primera vez, especialmente para compilar `better-sqlite3`.

### 3. Compilar el Ejecutable

```bash
# Para generar el ejecutable portable (recomendado):
npm run build:win:portable

# O para generar el instalador NSIS:
npm run build:win
```

### 4. Encontrar el Ejecutable

Una vez completado, el ejecutable estará en:
```
dist/Podio Backup-0.1.0-x64.exe
```

## ⚠️ Problemas Comunes y Soluciones

### Error: "node-gyp no encontrado"
```bash
npm install --global windows-build-tools
# O instalar Visual Studio Build Tools
```

### Error: "Python no encontrado"
- Instalar Python 3.x desde https://www.python.org/
- O instalar Visual Studio Build Tools que incluye Python

### Error de permisos
- Ejecutar PowerShell o CMD como Administrador
- O desactivar temporalmente el antivirus

### El build tarda mucho
- Es normal, especialmente la primera vez
- Puede tardar 10-30 minutos dependiendo del hardware

## ✅ Verificación

Una vez generado el `.exe`:
1. Debe estar en `dist/Podio Backup-0.1.0-x64.exe`
2. Tamaño aproximado: 130-150 MB
3. Puedes probarlo haciendo doble clic
4. Debería abrir la aplicación correctamente

## 📝 Notas Importantes

- El ejecutable es **portable**, no requiere instalación
- Puedes copiarlo a cualquier Windows y ejecutarlo directamente
- No requiere permisos de administrador para ejecutarlo
- La base de datos se crea automáticamente en el directorio del usuario

