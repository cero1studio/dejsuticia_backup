# Podio Backup - Sistema de Respaldo Automatizado

Sistema de respaldo automatizado de archivos y Excels oficiales de Podio, desarrollado con Next.js y Electron.

## 📋 Requisitos Previos

- **Node.js** 18.x o superior
- **npm** 9.x o superior (o pnpm/yarn)
- **Git** para clonar el repositorio

## 🚀 Instalación en un Nuevo Equipo

### Paso 1: Clonar el Repositorio

```bash
git clone https://github.com/cero1studio/dejsuticia_backup.git
cd dejsuticia_backup
```

### Paso 2: Instalar Dependencias

```bash
npm install
```

**Nota importante:** Este comando descargará todas las dependencias necesarias (incluyendo `node_modules/`) que no están en el repositorio porque son archivos generados.

### Paso 3: Configurar Variables de Entorno (Opcional)

Si necesitas variables de entorno, crea un archivo `.env.local` en la raíz del proyecto:

```env
# Ejemplo de variables de entorno (si las necesitas)
NEXT_PUBLIC_API_URL=https://api.podio.com
```

### Paso 4: Ejecutar en Modo Desarrollo

```bash
npm run electron-dev
```

O por separado:

```bash
# Terminal 1: Servidor Next.js
npm run dev

# Terminal 2: Electron (después de que Next.js esté corriendo)
npm run electron
```

### Paso 5: Construir para Producción

#### Windows (Portable):
```bash
npm run build:win:portable
```

#### Windows (Instalador):
```bash
npm run build:win
```

#### macOS:
```bash
npm run build:mac
```

Los archivos compilados se generarán en la carpeta `dist/`.

## 📁 Estructura del Proyecto

```
├── app/                    # Páginas y rutas de Next.js
│   ├── dashboard-electron/ # Dashboard para Electron
│   └── ...
├── lib/                    # Lógica de negocio
│   ├── podio-service.ts   # Servicio principal de Podio
│   ├── podio-service-electron.ts # Extensión para Electron
│   └── podio-service-scan-*.ts # Módulos de escaneo
├── main/                   # Código del proceso principal de Electron
│   └── db.js              # Base de datos SQLite
├── components/             # Componentes React reutilizables
├── main.js                 # Punto de entrada de Electron
├── preload.js             # Script de preload para Electron
└── package.json           # Dependencias y scripts
```

## 🔧 Scripts Disponibles

- `npm run dev` - Inicia servidor de desarrollo Next.js
- `npm run electron` - Ejecuta Electron
- `npm run electron-dev` - Ejecuta Next.js y Electron en paralelo
- `npm run build` - Construye Next.js y Electron
- `npm run build:win` - Construye para Windows (x64)
- `npm run build:win:portable` - Construye versión portable para Windows
- `npm run build:mac` - Construye para macOS
- `npm run lint` - Ejecuta el linter

## 📦 Archivos que NO están en el Repositorio

Los siguientes archivos se generan automáticamente y **NO** están en el repositorio:

- `node_modules/` - Se genera con `npm install`
- `.next/` - Se genera con `npm run build` o `npm run dev`
- `dist/` - Se genera con `npm run build:win` o similar
- `.env.local` - Variables de entorno (se crea localmente si es necesario)
- `*.log` - Archivos de log
- `public/backups/` - Backups generados (no se suben al repo)

**Esto es normal y correcto.** Estos archivos se regeneran en cada equipo.

## 🗄️ Base de Datos

El proyecto usa SQLite (`better-sqlite3`) para almacenar:
- Historial de escaneos
- Registro de llamadas API
- Estado de rate limits
- Checkpoints de progreso

La base de datos se crea automáticamente en la primera ejecución.

## ⚠️ Solución de Problemas

### Error: "Cannot find module"
```bash
# Eliminar node_modules y reinstalar
rm -rf node_modules package-lock.json
npm install
```

### Error al compilar Electron
```bash
# Reconstruir módulos nativos
npm run postinstall
```

### Error: "better-sqlite3" no funciona
```bash
# Reconstruir better-sqlite3
npm rebuild better-sqlite3
```

## 📝 Notas Importantes

1. **Primera ejecución:** La primera vez que ejecutes el proyecto, puede tardar más porque debe descargar todas las dependencias.

2. **Base de datos:** La base de datos SQLite se crea automáticamente. No necesitas configurarla manualmente.

3. **Variables de entorno:** Si el proyecto requiere credenciales de Podio, estas se manejan a través de la interfaz de la aplicación, no mediante archivos `.env`.

4. **Backups:** Los archivos de respaldo se guardan en la carpeta que elijas durante la ejecución. Esta carpeta NO se sube al repositorio.

## 🆘 Soporte

Para problemas o preguntas, revisa la documentación en:
- `DOCUMENTACION.md`
- `BUILD_WINDOWS.md`
- `TROUBLESHOOTING_WINDOWS.md`

## 📄 Licencia

Proyecto privado de CeroUno SAs.
