// Registrar ts-node para poder cargar archivos TypeScript
if (process.env.NODE_ENV !== 'production') {
  try {
    require('ts-node/register');
  } catch (e) {
    console.warn('ts-node no disponible, intentando cargar archivo compilado...');
  }
}

const { app, BrowserWindow, ipcMain, dialog } = require("electron")
const path = require("path")
const isDev = require("electron-is-dev")
const fs = require("fs")
const os = require("os")
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Obtener ruta de carpeta de logs
function getLogsDirectory() {
  const userDataPath = app.getPath('userData')
  const logsDir = path.join(userDataPath, 'logs')
  
  // Crear carpeta de logs si no existe
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
  }
  
  return logsDir
}

// Obtener ruta del archivo de log del día actual
function getLogFilePath() {
  const logsDir = getLogsDirectory()
  const today = new Date()
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return path.join(logsDir, `podio-backup-${dateStr}.log`)
}

// Escribir log a archivo
function writeLogToFile(level, message) {
  try {
    const logFilePath = getLogFilePath()
    const timestamp = new Date().toISOString()
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`
    
    // Escribir de forma asíncrona para no bloquear
    fs.appendFileSync(logFilePath, logLine, 'utf8')
  } catch (error) {
    // Si falla escribir al log, solo mostrar en consola (no queremos crear un loop de errores)
    console.error('Error escribiendo log a archivo:', error.message)
  }
}

// Cargar módulo de base de datos (JavaScript)
let db;
try {
  // Intentar cargar primero db.js (JavaScript)
  db = require('./main/db.js');
  console.log('✅ Módulo db.js cargado correctamente');
  // Verificar que las funciones nuevas estén disponibles
  if (typeof db.getScanByPodioItemId === 'function') {
    console.log('✅ db.getScanByPodioItemId está disponible');
  } else {
    console.warn('⚠️ db.getScanByPodioItemId NO está disponible');
  }
  if (typeof db.getScanAppsByScanId === 'function') {
    console.log('✅ db.getScanAppsByScanId está disponible');
  } else {
    console.warn('⚠️ db.getScanAppsByScanId NO está disponible');
  }
  if (typeof db.getScanFilesByScanId === 'function') {
    console.log('✅ db.getScanFilesByScanId está disponible');
  } else {
    console.warn('⚠️ db.getScanFilesByScanId NO está disponible');
  }
} catch (e1) {
  // Si falla, intentar cargar db (sin extensión, puede ser TypeScript con ts-node)
  try {
    db = require('./main/db');
    console.log('✅ Módulo db cargado (sin extensión)');
  } catch (e2) {
    console.error('❌ Error cargando módulo db:', e1.message || e1);
    console.error('❌ Error secundario:', e2.message || e2);
    throw new Error('No se pudo cargar el módulo de base de datos: ' + (e1.message || e1));
  }
}

// Mantener una referencia global del objeto window
let mainWindow
const activeDownloads = new Map()

let nextServer = null
const PORT = 3000

async function startNextServer() {
  if (isDev || nextServer) return // Ya está corriendo
  
  try {
    console.log('🚀 Iniciando servidor Next.js para producción...')
    // En producción, ejecutar el servidor Next.js
    const next = require('next')
    const nextApp = next({
      dev: false,
      dir: __dirname
    })
    
    await nextApp.prepare()
    console.log('✅ Next.js preparado')
    
    const server = require('http').createServer((req, res) => {
      nextApp.getRequestHandler()(req, res)
    })
    
    await new Promise((resolve, reject) => {
      server.listen(PORT, '127.0.0.1', (err) => {
        if (err) {
          console.error('❌ Error iniciando servidor Next.js:', err)
          reject(err)
        } else {
          console.log(`✅ Servidor Next.js iniciado en http://127.0.0.1:${PORT}`)
          nextServer = server
          resolve()
        }
      })
    })
  } catch (error) {
    console.error('❌ Error al iniciar servidor Next.js:', error)
    console.error('   Detalles:', error.message)
    console.error('   Stack:', error.stack)
    throw error
  }
}

function createWindow() {
  // Crear la ventana del navegador
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    show: false, // No mostrar hasta que esté listo
  })

  // Cargar la aplicación Next.js
  const startUrl = isDev
    ? `http://localhost:${PORT}/`
    : `http://127.0.0.1:${PORT}/`

  // Cargar la URL (el servidor ya debería estar iniciado si es producción)
  mainWindow.loadURL(startUrl).then(() => {
    mainWindow.show()
  }).catch((err) => {
    console.error('Error cargando URL:', err)
    // Intentar esperar un poco más si es producción
    if (!isDev) {
      setTimeout(() => {
        mainWindow.loadURL(startUrl).then(() => {
          mainWindow.show()
        }).catch((err2) => {
          console.error('Error cargando URL después de esperar:', err2)
          mainWindow.show()
        })
      }, 2000)
    } else {
      mainWindow.show()
    }
  })

  // Abrir DevTools en desarrollo
  if (isDev) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

app.on("ready", async () => {
  // Inicializar base de datos
  try {
    if (db) {
      // Forzar inicialización de la base de datos (crea tablas si no existen)
      db.initDb()
      
      // Ejecutar limpieza de datos antiguos
      if (typeof db.pruneOldRequests === 'function') db.pruneOldRequests()
      if (typeof db.pruneOldScans === 'function') db.pruneOldScans()
      if (typeof db.clearExpiredRateLimits === 'function') db.clearExpiredRateLimits()
      
      // IMPORTANTE: Inicializar estados vacíos si la BD está vacía
      // Esto asegura que las funciones no fallen cuando no hay datos
      if (typeof db.initializeEmptyStates === 'function') {
        db.initializeEmptyStates()
      }
      
      // Verificar que las tablas existen
      const testDb = db.getDb()
      if (testDb) {
        try {
          // Intentar una consulta simple para verificar que las tablas existen
          testDb.prepare('SELECT COUNT(*) as count FROM requests').get()
          console.log('✅ Base de datos inicializada y verificada')
        } catch (tableError) {
          console.error('❌ Error verificando tablas de BD:', tableError)
          // Re-inicializar si hay error
          db.initDb()
          console.log('✅ Base de datos re-inicializada')
        }
      } else {
        console.log('✅ Base de datos inicializada')
      }
      
      // Verificar que las funciones nuevas estén disponibles después de inicializar
      console.log('🔍 Verificando funciones de detalles de backup:');
      console.log('  - getScanByPodioItemId:', typeof db.getScanByPodioItemId === 'function' ? '✅' : '❌');
      console.log('  - getScanAppsByScanId:', typeof db.getScanAppsByScanId === 'function' ? '✅' : '❌');
      console.log('  - getScanFilesByScanId:', typeof db.getScanFilesByScanId === 'function' ? '✅' : '❌');
      
      if (typeof db.getScanByPodioItemId !== 'function') {
        console.error('❌ ERROR CRÍTICO: db.getScanByPodioItemId no está disponible después de inicializar');
        console.error('Funciones disponibles en db:', Object.keys(db).filter(k => typeof db[k] === 'function'));
      }
    } else {
      console.warn('⚠️ Módulo de base de datos no disponible, continuando sin BD')
    }
  } catch (error) {
    console.error('❌ Error al inicializar base de datos:', error)
    console.error('   Detalles:', error.message)
    console.error('   Stack:', error.stack)
    // Continuar sin BD - la app funcionará pero sin persistencia de rate limits
  }
  
  // Iniciar servidor Next.js en producción antes de crear la ventana
  if (!isDev) {
    try {
      await startNextServer()
    } catch (error) {
      console.error('Error al iniciar servidor Next.js:', error)
    }
  }
  
  createWindow()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // Cerrar el servidor Next.js si está corriendo
    if (nextServer) {
      nextServer.close()
      nextServer = null
    }
    app.quit()
  }
})

// Cerrar servidor al salir
app.on("before-quit", () => {
  if (nextServer) {
    nextServer.close()
    nextServer = null
  }
})

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow()
  }
})

// Manejar la creación de carpetas
ipcMain.handle("create-directory", async (event, dirPath) => {
  try {
    console.log(`Intentando crear carpeta: ${dirPath}`)

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
      console.log(`Carpeta creada: ${dirPath}`)
    } else {
      console.log(`La carpeta ya existe: ${dirPath}`)
    }

    return { success: true, path: dirPath }
  } catch (error) {
    console.error(`Error al crear carpeta ${dirPath}:`, error)
    return { success: false, error: error.message }
  }
})

// Manejar la selección de carpeta
ipcMain.handle("select-directory", async () => {
  try {
    console.log("Solicitando selección de carpeta...")

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Selecciona la carpeta donde se guardarán los respaldos",
      buttonLabel: "Seleccionar carpeta de respaldo",
    })

    console.log("Resultado de selección de carpeta:", result)

    if (result.canceled) {
      return { canceled: true }
    }

    return { canceled: false, filePath: result.filePaths[0] }
  } catch (error) {
    console.error("Error al seleccionar carpeta:", error)
    return { canceled: true, error: error.message }
  }
})

function downloadWithRedirect(url, filePath, headers = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error('Demasiados redireccionamientos'));
    }
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    const options = { headers };

    client.get(url, options, (res) => {
      // Si es redirect, seguir la nueva ubicación
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const redirectUrl = res.headers.location;
        if (!redirectUrl) {
          return reject(new Error('Redireccionamiento sin Location'));
        }
        return resolve(downloadWithRedirect(redirectUrl, filePath, headers, maxRedirects - 1));
      }
      
      // Detectar rate limit (420/429)
      if (res.statusCode === 420 || res.statusCode === 429) {
        let bodyData = '';
        res.on('data', (chunk) => {
          bodyData += chunk.toString();
        });
        res.on('end', () => {
          let waitTime = 3600; // Default: 1 hora
          let detectedLimitType = 'general';
          
          // Intentar extraer waitTime de headers
          const retryAfterHeader = res.headers['retry-after'] || res.headers['Retry-After'];
          const resetHeader = res.headers['x-rate-limit-reset'] || res.headers['X-Rate-Limit-Reset'];
          
          if (retryAfterHeader) {
            waitTime = parseInt(retryAfterHeader, 10) || 3600;
          } else if (resetHeader) {
            const resetTime = parseInt(resetHeader, 10);
            const now = Math.floor(Date.now() / 1000);
            waitTime = Math.max(0, resetTime - now);
          } else if (bodyData) {
            // Intentar extraer de body JSON
            try {
              const errorData = JSON.parse(bodyData);
              if (errorData.error === 'rate_limit' && errorData.error_description) {
                const waitTimeMatch = errorData.error_description.match(/(\d+)\s*seconds?/i);
                if (waitTimeMatch && waitTimeMatch[1]) {
                  waitTime = parseInt(waitTimeMatch[1], 10);
                }
              }
            } catch (parseError) {
              // Intentar extraer de texto plano
              const waitTimeMatch = bodyData.match(/(\d+)\s*seconds?/i);
              if (waitTimeMatch && waitTimeMatch[1]) {
                waitTime = parseInt(waitTimeMatch[1], 10);
              }
            }
          }
          
          // Determinar tipo de límite basado en el endpoint
          // Los archivos generalmente usan rateLimited (250/hora)
          detectedLimitType = 'rateLimited';
          
          return reject(new Error(`RATE_LIMIT_ERROR:${waitTime}:${detectedLimitType}`));
        });
        return;
      }
      
      if (res.statusCode !== 200) {
        return reject(new Error(`Status code: ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(filePath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close(resolve);
      });
      fileStream.on('error', (err) => {
        fs.unlink(filePath, () => reject(err));
      });
    }).on('error', reject);
  });
}

// Reemplazar el handler de descarga de archivos
ipcMain.handle("download-file", async (event, { url, filePath, headers = {} }) => {
  try {
    console.log(`Descargando archivo desde ${url} a ${filePath}`);
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
      console.log(`Carpeta creada: ${directory}`);
    }
    await downloadWithRedirect(url, filePath, headers);
    console.log(`Archivo descargado correctamente en: ${filePath}`);
    return { success: true, path: filePath };
  } catch (error) {
    console.error(`Error al descargar archivo: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Manejar la escritura de archivos (para Excel)
ipcMain.handle("save-file", async (event, { content, filePath }) => {
  try {
    console.log(`Guardando archivo en: ${filePath}`)

    // Asegurarse de que la carpeta existe
    const directory = path.dirname(filePath)
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true })
      console.log(`Carpeta creada: ${directory}`)
    }

    // CRÍTICO: Convertir contenido de base64 a Buffer antes de escribir
    // El contenido viene como string base64 desde el renderer process
    const buffer = Buffer.from(content, 'base64')
    fs.writeFileSync(filePath, buffer)
    console.log(`Archivo guardado correctamente en: ${filePath}`)

    return { success: true, path: filePath }
  } catch (error) {
    console.error(`Error al guardar archivo: ${error.message}`)
    return { success: false, error: error.message }
  }
})

// Manejar la cancelación de todas las descargas activas
ipcMain.handle("cancel-all-downloads", async () => {
  try {
    console.log(`Cancelando todas las descargas activas (${activeDownloads.size})...`)

    // Cancelar todas las descargas activas
    for (const [id, promise] of activeDownloads.entries()) {
      // No podemos realmente cancelar las promesas, pero podemos limpiar el mapa
      console.log(`Marcando descarga ${id} como cancelada`)
    }

    // Limpiar el mapa de descargas activas
    activeDownloads.clear()

    return { success: true, message: "Todas las descargas han sido canceladas" }
  } catch (error) {
    console.error("Error al cancelar descargas:", error)
    return { success: false, error: error.message }
  }
})

// Verificar si un archivo existe
ipcMain.handle('fileSystem:existsSync', (event, filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
});

// Obtener el tamaño de un archivo en bytes
ipcMain.handle('fileSystem:getFileSize', (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
});

// Leer archivo y devolver como base64
ipcMain.handle('fileSystem:readFile', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: `Archivo no existe: ${filePath}` };
    }
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');
    return { success: true, content: base64 };
  } catch (error) {
    console.error(`Error leyendo archivo: ${error.message}`);
    return { success: false, error: error.message };
  }
});

// Eliminar un archivo
ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    console.log(`Eliminando archivo: ${filePath}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Archivo eliminado: ${filePath}`);
      return { success: true, path: filePath };
    } else {
      console.log(`El archivo no existe: ${filePath}`);
      return { success: false, error: 'Archivo no existe' };
    }
  } catch (error) {
    console.error(`Error al eliminar archivo ${filePath}:`, error);
    return { success: false, error: error.message };
  }
});

// Obtener la ruta del directorio home del usuario
ipcMain.handle('fileSystem:getHomePath', () => {
  try {
    const homePath = os.homedir();
    console.log(`Ruta home del usuario: ${homePath}`);
    return homePath;
  } catch (error) {
    console.error('Error al obtener ruta home:', error);
    return null;
  }
});

// ==================== HANDLERS DE LOGGING ====================

// Escribir log a archivo
ipcMain.handle('log:write', (event, level, message) => {
  try {
    writeLogToFile(level, message)
    return { success: true }
  } catch (error) {
    console.error('Error en log:write:', error)
    return { success: false, error: error.message }
  }
})

// Obtener ruta de carpeta de logs
ipcMain.handle('log:getLogsDirectory', () => {
  try {
    return { success: true, path: getLogsDirectory() }
  } catch (error) {
    console.error('Error obteniendo carpeta de logs:', error)
    return { success: false, error: error.message }
  }
})

// Obtener ruta del archivo de log del día actual
ipcMain.handle('log:getLogFilePath', () => {
  try {
    return { success: true, path: getLogFilePath() }
  } catch (error) {
    console.error('Error obteniendo ruta de log:', error)
    return { success: false, error: error.message }
  }
})

// ==================== HANDLERS DE BASE DE DATOS ====================

// Log de request a la API
ipcMain.handle('db:logRequest', async (event, params) => {
  try {
    db.logRequest(params);
    return { success: true };
  } catch (error) {
    console.error('Error en db:logRequest:', error);
    return { success: false, error: error.message };
  }
});

// Obtener conteos de requests desde un timestamp
ipcMain.handle('db:getRequestCountsSince', async (event, sinceMs) => {
  try {
    return db.getRequestCountsSince(sinceMs);
  } catch (error) {
    console.error('Error en db:getRequestCountsSince:', error);
    return { general: 0, rateLimited: 0 };
  }
});

// Obtener estado de rate limits (usado, remanente, cuándo resetea)
ipcMain.handle('db:getRateLimitStatus', async (event, rateType) => {
  try {
    return db.getRateLimitStatus(rateType);
  } catch (error) {
    console.error('Error en db:getRateLimitStatus:', error);
    return {
      used: 0,
      remaining: rateType === 'general' ? 1000 : 250,
      limit: rateType === 'general' ? 1000 : 250,
      resetAtMs: null,
      resetInSeconds: null
    };
  }
});

// Iniciar un nuevo escaneo
ipcMain.handle('db:beginScan', async (event, params) => {
  try {
    const scanId = db.beginScan(params);
    return { success: true, scanId };
  } catch (error) {
    console.error('Error en db:beginScan:', error);
    return { success: false, error: error.message };
  }
});

// Agregar app al escaneo
ipcMain.handle('db:addApp', async (event, scanId, params) => {
  try {
    db.addApp(scanId, params);
    return { success: true };
  } catch (error) {
    console.error('Error en db:addApp:', error);
    return { success: false, error: error.message };
  }
});

// Agregar item al escaneo
ipcMain.handle('db:addItem', async (event, scanId, appId, itemId) => {
  try {
    db.addItem(scanId, appId, itemId);
    return { success: true };
  } catch (error) {
    console.error('Error en db:addItem:', error);
    return { success: false, error: error.message };
  }
});

// Agregar archivo al escaneo
ipcMain.handle('db:addFile', async (event, scanId, params) => {
  try {
    db.addFile(scanId, params);
    return { success: true };
  } catch (error) {
    console.error('Error en db:addFile:', error);
    return { success: false, error: error.message };
  }
});

// Agregar múltiples archivos en batch
ipcMain.handle('db:addFilesBulk', async (event, scanId, files) => {
  try {
    db.addFilesBulk(scanId, files);
    return { success: true };
  } catch (error) {
    console.error('Error en db:addFilesBulk:', error);
    return { success: false, error: error.message };
  }
});

// Finalizar escaneo
ipcMain.handle('db:finalizeScan', async (event, scanId, summary) => {
  try {
    db.finalizeScan(scanId, summary);
    return { success: true };
  } catch (error) {
    console.error('Error en db:finalizeScan:', error);
    return { success: false, error: error.message };
  }
});

// Obtener último escaneo
ipcMain.handle('db:getLastScan', async (event) => {
  try {
    return db.getLastScan();
  } catch (error) {
    console.error('Error en db:getLastScan:', error);
    return null;
  }
});

// Obtener apps del último escaneo
ipcMain.handle('db:getLastScanApps', async (event) => {
  try {
    return db.getLastScanApps();
  } catch (error) {
    console.error('Error en db:getLastScanApps:', error);
    return [];
  }
});

// Obtener archivos del último escaneo
ipcMain.handle('db:getLastScanFiles', async (event) => {
  try {
    return db.getLastScanFiles();
  } catch (error) {
    console.error('Error en db:getLastScanFiles:', error);
    return [];
  }
});

// Obtener count de items del último escaneo
ipcMain.handle('db:getLastScanItemsCount', async (event) => {
  try {
    return db.getLastScanItemsCount();
  } catch (error) {
    console.error('Error en db:getLastScanItemsCount:', error);
    return 0;
  }
});

// ========== SCAN CHECKPOINTS ==========
ipcMain.handle('db:saveScanCheckpoint', async (event, scanId, checkpoint) => {
  try {
    db.saveScanCheckpoint(scanId, checkpoint);
    return { success: true };
  } catch (error) {
    console.error('Error en db:saveScanCheckpoint:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db:getScanCheckpoint', async (event, scanId) => {
  try {
    return db.getScanCheckpoint(scanId);
  } catch (error) {
    console.error('Error en db:getScanCheckpoint:', error);
    return null;
  }
});

ipcMain.handle('db:markScanAsCancelled', async (event, scanId) => {
  try {
    if (typeof db.markScanAsCancelled === 'function') {
      db.markScanAsCancelled(scanId);
      return { success: true };
    } else {
      console.error('❌ db.markScanAsCancelled no está disponible');
      return { success: false, error: 'Función no disponible' };
    }
  } catch (error) {
    console.error('Error en db:markScanAsCancelled:', error);
    return { success: false, error: error.message };
  }
});

// Verificar URLs de descarga en scan_files
ipcMain.handle('db:checkDownloadUrls', async (event, scanId) => {
  try {
    if (!db || typeof db.getScanFilesByScanId !== 'function') {
      return { success: false, error: 'Base de datos no disponible' };
    }
    
    // Obtener archivos del escaneo
    const files = db.getScanFilesByScanId(scanId);
    
    // Analizar URLs
    const total = files.length;
    const withUrl = files.filter(f => f.download_url && f.download_url.trim() !== '').length;
    const withoutUrl = total - withUrl;
    
    // Verificar tipos de URLs
    const apiUrls = files.filter(f => 
      f.download_url && f.download_url.includes('/file/') && f.download_url.includes('/download')
    ).length;
    
    // Muestra de archivos
    const sample = files.slice(0, 10).map(f => ({
      file_id: f.file_id,
      name: f.name,
      has_url: !!(f.download_url && f.download_url.trim() !== ''),
      url_preview: f.download_url ? f.download_url.substring(0, 80) + '...' : 'SIN URL',
      size: f.size || 0,
      item_id: f.item_id
    }));
    
    return {
      success: true,
      total,
      withUrl,
      withoutUrl,
      apiUrls,
      sample
    };
  } catch (error) {
    console.error('Error en db:checkDownloadUrls:', error);
    return { success: false, error: error.message };
  }
});

// ========== DOWNLOAD CHECKPOINTS ==========

// Agregar checkpoint de descarga
ipcMain.handle('db:addDownloadCheckpoint', async (event, params) => {
  try {
    db.addDownloadCheckpoint(params);
    return { success: true };
  } catch (error) {
    console.error('Error en db:addDownloadCheckpoint:', error);
    return { success: false, error: error.message };
  }
});

// Actualizar estado de descarga
ipcMain.handle('db:updateDownloadStatus', async (event, params) => {
  try {
    db.updateDownloadStatus(params);
    return { success: true };
  } catch (error) {
    console.error('Error en db:updateDownloadStatus:', error);
    return { success: false, error: error.message };
  }
});

// Verificar si archivo ya fue descargado
ipcMain.handle('db:isDownloadDone', async (event, fileId, scanId) => {
  try {
    return db.isDownloadDone(fileId, scanId);
  } catch (error) {
    console.error('Error en db:isDownloadDone:', error);
    return false;
  }
});

// Obtener descargas pendientes
ipcMain.handle('db:getPendingDownloads', async (event, scanId) => {
  try {
    return db.getPendingDownloads(scanId);
  } catch (error) {
    console.error('Error en db:getPendingDownloads:', error);
    return [];
  }
});

// Obtener descargas fallidas
ipcMain.handle('db:getFailedDownloads', async (event, scanId, maxTries) => {
  try {
    return db.getFailedDownloads(scanId, maxTries || 3);
  } catch (error) {
    console.error('Error en db:getFailedDownloads:', error);
    return [];
  }
});

// Obtener información de descarga
ipcMain.handle('db:getDownloadInfo', async (event, fileId, scanId) => {
  try {
    return db.getDownloadInfo(fileId, scanId);
  } catch (error) {
    console.error('Error en db:getDownloadInfo:', error);
    return null;
  }
});

// Obtener estadísticas de descargas
ipcMain.handle('db:getDownloadStats', async (event, scanId) => {
  try {
    return db.getDownloadStats(scanId);
  } catch (error) {
    console.error('Error en db:getDownloadStats:', error);
    return { total: 0, done: 0, pending: 0, error: 0 };
  }
});

// Detectar si hay backup incompleto
ipcMain.handle('db:hasIncompleteBackup', async (event) => {
  try {
    return db.hasIncompleteBackup();
  } catch (error) {
    console.error('Error en db:hasIncompleteBackup:', error);
    return {
      hasIncomplete: false,
      scanId: null,
      scanDate: null,
      stats: null
    };
  }
});

// Obtener estado detallado de un scan
ipcMain.handle('db:getScanStatus', async (event, scanId) => {
  try {
    return db.getScanStatus(scanId);
  } catch (error) {
    console.error('Error en db:getScanStatus:', error);
    return {
      scan: null,
      stats: { total: 0, done: 0, pending: 0, error: 0 },
      apps: []
    };
  }
});

// Guardar estado de rate limit
ipcMain.handle('db:saveRateLimitStatus', async (event, params) => {
  try {
    db.saveRateLimitStatus(params);
    return { success: true };
  } catch (error) {
    console.error('Error en db:saveRateLimitStatus:', error);
    return { success: false, error: error.message };
  }
});

// Obtener estado persistente de rate limit
ipcMain.handle('db:getRateLimitStatusFromDb', async (event, rateType) => {
  try {
    return db.getRateLimitStatusFromDb(rateType);
  } catch (error) {
    console.error('Error en db:getRateLimitStatusFromDb:', error);
    return {
      active: false,
      triggeredAtMs: null,
      resetAtMs: null,
      resetInSeconds: null,
      requestsUsed: null,
      limitValue: null
    };
  }
});

// Limpiar rate limit específico (forzar reintento)
ipcMain.handle('db:clearRateLimitStatus', async (event, rateType) => {
  try {
    db.clearRateLimitStatus(rateType);
    return { success: true };
  } catch (error) {
    console.error('Error en db:clearRateLimitStatus:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db:clearAuthenticationRequests', async (event) => {
  try {
    if (!db || typeof db.clearAuthenticationRequests !== 'function') {
      return { success: false, cleared: 0, error: 'Function not available' };
    }
    return db.clearAuthenticationRequests();
  } catch (error) {
    console.error('Error clearing authentication requests:', error);
    return { success: false, cleared: 0, error: error.message };
  }
});

ipcMain.handle('db:clearRecentRequests', async (event) => {
  try {
    if (!db || typeof db.clearRecentRequests !== 'function') {
      return { success: false, cleared: 0, error: 'Function not available' };
    }
    return db.clearRecentRequests();
  } catch (error) {
    console.error('Error clearing recent requests:', error);
    return { success: false, cleared: 0, error: error.message };
  }
});

ipcMain.handle('db:clearAllRateLimits', async (event) => {
  try {
    if (!db || typeof db.clearAllRateLimits !== 'function') {
      return { success: false, cleared: 0, error: 'Function not available' };
    }
    return db.clearAllRateLimits();
  } catch (error) {
    console.error('Error clearing all rate limits:', error);
    return { success: false, cleared: 0, error: error.message };
  }
});

ipcMain.handle('db:clearExpiredRateLimits', async (event) => {
  try {
    if (!db || typeof db.clearExpiredRateLimits !== 'function') {
      return { success: false, cleared: 0, error: 'Function not available' };
    }
    return db.clearExpiredRateLimits();
  } catch (error) {
    console.error('Error clearing expired rate limits:', error);
    return { success: false, cleared: 0, error: error.message };
  }
});

// Obtener scan por podio_backup_item_id
ipcMain.handle('db:getScanByPodioItemId', async (event, podioItemId) => {
  try {
    if (!db || typeof db.getScanByPodioItemId !== 'function') {
      console.error('❌ db.getScanByPodioItemId no está disponible');
      console.error('db:', db ? Object.keys(db) : 'null');
      return null;
    }
    console.log(`🔍 IPC: Llamando db.getScanByPodioItemId con ID: ${podioItemId}`);
    return db.getScanByPodioItemId(podioItemId);
  } catch (error) {
    console.error('❌ Error en db:getScanByPodioItemId:', error);
    return null;
  }
});

// Obtener apps de un scan específico
ipcMain.handle('db:getScanAppsByScanId', async (event, scanId) => {
  try {
    if (!db || typeof db.getScanAppsByScanId !== 'function') {
      console.error('❌ db.getScanAppsByScanId no está disponible');
      return [];
    }
    return db.getScanAppsByScanId(scanId);
  } catch (error) {
    console.error('❌ Error en db:getScanAppsByScanId:', error);
    return [];
  }
});

// Obtener archivos de un scan específico
ipcMain.handle('db:getScanFilesByScanId', async (event, scanId) => {
  try {
    if (!db || typeof db.getScanFilesByScanId !== 'function') {
      console.error('❌ db.getScanFilesByScanId no está disponible');
      return [];
    }
    return db.getScanFilesByScanId(scanId);
  } catch (error) {
    console.error('❌ Error en db:getScanFilesByScanId:', error);
    return [];
  }
});

// ==================== HANDLERS DE CACHÉ API ====================

// Obtener respuesta de API desde caché de BD
ipcMain.handle('db:getApiCache', async (event, endpoint) => {
  try {
    if (!db || typeof db.getApiCache !== 'function') {
      console.error('❌ db.getApiCache no está disponible');
      return null;
    }
    return db.getApiCache(endpoint);
  } catch (error) {
    console.error('❌ Error en db:getApiCache:', error);
    return null;
  }
});

// Guardar respuesta de API en caché de BD
ipcMain.handle('db:setApiCache', async (event, endpoint, data, ttlMs) => {
  try {
    if (!db || typeof db.setApiCache !== 'function') {
      console.error('❌ db.setApiCache no está disponible');
      return { success: false, error: 'Function not available' };
    }
    db.setApiCache(endpoint, data, ttlMs);
    return { success: true };
  } catch (error) {
    console.error('❌ Error en db:setApiCache:', error);
    return { success: false, error: error.message };
  }
});

// Limpiar caché expirado
ipcMain.handle('db:clearExpiredApiCache', async () => {
  try {
    if (!db || typeof db.clearExpiredApiCache !== 'function') {
      console.error('❌ db.clearExpiredApiCache no está disponible');
      return { success: false, error: 'Function not available' };
    }
    db.clearExpiredApiCache();
    return { success: true };
  } catch (error) {
    console.error('❌ Error en db:clearExpiredApiCache:', error);
    return { success: false, error: error.message };
  }
});

// ========================================================================
// HISTORIAL LOCAL DE BACKUPS
// ========================================================================

ipcMain.handle('db:getLocalBackupHistory', async (event, limit) => {
  try {
    if (!db || typeof db.getLocalBackupHistory !== 'function') {
      console.error('❌ db.getLocalBackupHistory no está disponible');
      return { success: false, error: 'Function not available', data: [] };
    }
    const history = db.getLocalBackupHistory(limit);
    return { success: true, data: history };
  } catch (error) {
    console.error('❌ Error en db:getLocalBackupHistory:', error);
    return { success: false, error: error.message, data: [] };
  }
});

ipcMain.handle('db:clearAllData', async () => {
  try {
    if (!db || typeof db.clearAllData !== 'function') {
      console.error('❌ db.clearAllData no está disponible');
      return { success: false, error: 'Function not available' };
    }
    return db.clearAllData();
  } catch (error) {
    console.error('❌ Error en db:clearAllData:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db:clearBackupHistory', async () => {
  try {
    if (!db || typeof db.clearBackupHistory !== 'function') {
      console.error('❌ db.clearBackupHistory no está disponible');
      return { success: false, error: 'Function not available' };
    }
    return db.clearBackupHistory();
  } catch (error) {
    console.error('❌ Error en db:clearBackupHistory:', error);
    return { success: false, error: error.message };
  }
});
