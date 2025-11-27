const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

// Obtener ruta de la base de datos
function getDbPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'podio-backup.db');
}

try {
  const dbPath = getDbPath();
  console.log(`📂 Consultando base de datos: ${dbPath}`);
  
  const db = new Database(dbPath);
  
  // Obtener último escaneo
  const lastScan = db.prepare(`
    SELECT id, created_at_ms, title, summary 
    FROM scans 
    ORDER BY created_at_ms DESC 
    LIMIT 1
  `).get();
  
  if (!lastScan) {
    console.log('❌ No hay escaneos en la base de datos');
    process.exit(0);
  }
  
  console.log(`\n📊 Último escaneo:`);
  console.log(`   ID: ${lastScan.id}`);
  console.log(`   Título: ${lastScan.title || 'N/A'}`);
  console.log(`   Fecha: ${new Date(lastScan.created_at_ms).toLocaleString()}`);
  
  // Contar items
  const itemsCount = db.prepare(`
    SELECT COUNT(DISTINCT item_id) as count 
    FROM scan_items 
    WHERE scan_id = ?
  `).get(lastScan.id);
  
  console.log(`\n📦 Items encontrados: ${itemsCount.count || 0}`);
  
  // Contar archivos
  const filesCount = db.prepare(`
    SELECT COUNT(*) as count 
    FROM scan_files 
    WHERE scan_id = ?
  `).get(lastScan.id);
  
  console.log(`\n📁 Archivos encontrados: ${filesCount.count || 0}`);
  
  // Verificar URLs de descarga
  const filesWithUrl = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN download_url IS NOT NULL AND download_url != '' THEN 1 ELSE 0 END) as with_url,
      SUM(CASE WHEN download_url IS NULL OR download_url = '' THEN 1 ELSE 0 END) as without_url
    FROM scan_files 
    WHERE scan_id = ?
  `).get(lastScan.id);
  
  console.log(`\n🔗 URLs de descarga:`);
  console.log(`   Total archivos: ${filesWithUrl.total || 0}`);
  console.log(`   ✅ Con URL: ${filesWithUrl.with_url || 0}`);
  console.log(`   ❌ Sin URL: ${filesWithUrl.without_url || 0}`);
  
  // Mostrar algunos ejemplos de archivos con sus URLs
  const sampleFiles = db.prepare(`
    SELECT file_id, name, download_url, size, item_id
    FROM scan_files 
    WHERE scan_id = ? 
    ORDER BY id 
    LIMIT 10
  `).all(lastScan.id);
  
  if (sampleFiles.length > 0) {
    console.log(`\n📋 Ejemplos de archivos guardados (primeros 10):`);
    sampleFiles.forEach((file, index) => {
      const hasUrl = file.download_url && file.download_url.trim() !== '';
      const urlPreview = hasUrl 
        ? file.download_url.substring(0, 60) + '...' 
        : '❌ SIN URL';
      console.log(`   ${index + 1}. ${file.name}`);
      console.log(`      File ID: ${file.file_id}, Item ID: ${file.item_id || 'N/A'}`);
      console.log(`      Tamaño: ${file.size ? (file.size / 1024).toFixed(2) + ' KB' : 'N/A'}`);
      console.log(`      URL: ${urlPreview}`);
      console.log('');
    });
  }
  
  // Verificar tipos de URLs
  const urlTypes = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN download_url LIKE 'https://api.podio.com/file/%/download' THEN 1 ELSE 0 END) as api_urls,
      SUM(CASE WHEN download_url LIKE 'http://%' OR download_url LIKE 'https://%' THEN 1 ELSE 0 END) as valid_urls
    FROM scan_files 
    WHERE scan_id = ? AND download_url IS NOT NULL AND download_url != ''
  `).get(lastScan.id);
  
  console.log(`\n🔍 Análisis de URLs:`);
  console.log(`   URLs de API Podio (formato esperado): ${urlTypes.api_urls || 0}`);
  console.log(`   URLs válidas (http/https): ${urlTypes.valid_urls || 0}`);
  
  db.close();
  console.log(`\n✅ Consulta completada`);
  
} catch (error) {
  console.error('❌ Error consultando base de datos:', error);
  process.exit(1);
}







