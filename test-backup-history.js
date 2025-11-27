/**
 * Script de prueba para verificar la conexión a la app de respaldos en Podio
 * 
 * Ejecutar con: node test-backup-history.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Leer .env.local si existe
const envLocalPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envLocalPath)) {
  const envContent = fs.readFileSync(envLocalPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.split('=');
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').trim();
      process.env[key.trim()] = value.replace(/^["']|["']$/g, '');
    }
  });
  console.log('✅ Archivo .env.local cargado\n');
}

// Configuración
const CLIENT_ID = process.env.NEXT_PUBLIC_PODIO_CLIENT_ID || 'filepodio_lumen';
const CLIENT_SECRET = process.env.NEXT_PUBLIC_PODIO_CLIENT_SECRET || 'XOnjWcETaRLHmHgvmz4ipEite8sBttjnMmIcYSLaJKOKV1Ha8ZbsYpJYxkch4yWV';
const APP_ID = process.env.NEXT_PUBLIC_PODIO_BACKUP_APP_ID || '30233695';

// Leer credenciales del usuario
const readline = require('readline');
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('🔍 TEST DE HISTORIAL DE RESPALDOS\n');
console.log(`🔑 CLIENT_ID: ${CLIENT_ID}`);
console.log(`📱 APP_ID: ${APP_ID}\n`);

// Función para hacer peticiones a Podio
function podioRequest(path, method, data, token, isAuth = false) {
  return new Promise((resolve, reject) => {
    let postData = '';
    
    // Para autenticación, usar form-urlencoded
    if (isAuth && data) {
      postData = Object.keys(data)
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
        .join('&');
    } else if (data) {
      postData = JSON.stringify(data);
    }
    
    const options = {
      hostname: 'api.podio.com',
      path: path,
      method: method,
      headers: {
        'Content-Type': isAuth ? 'application/x-www-form-urlencoded' : 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    if (token) {
      options.headers['Authorization'] = `OAuth2 ${token}`;
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(response);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(response)}`));
          }
        } catch (e) {
          reject(new Error(`Error parsing response: ${e.message}\nBody: ${body}`));
        }
      });
    });

    req.on('error', reject);
    
    if (postData) {
      req.write(postData);
    }
    
    req.end();
  });
}

// Paso 1: Pedir credenciales
rl.question('Usuario (email): ', (username) => {
  rl.question('Contraseña: ', async (password) => {
    rl.close();
    
    try {
      console.log('\n🔐 Autenticando...');
      console.log(`   CLIENT_ID: "${CLIENT_ID}" (length: ${CLIENT_ID ? CLIENT_ID.length : 0})`);
      console.log(`   CLIENT_SECRET: "${CLIENT_SECRET ? CLIENT_SECRET.substring(0, 20) + '...' : 'VACIO'}" (length: ${CLIENT_SECRET ? CLIENT_SECRET.length : 0})`);
      console.log(`   Username: "${username}"`);
      
      const authData = {
        grant_type: 'password',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        username: username,
        password: password
      };
      
      console.log('   Enviando datos:', JSON.stringify({
        ...authData,
        password: '***',
        client_secret: '***'
      }, null, 2));
      
      // Autenticar (usar true para indicar que es autenticación)
      const authResponse = await podioRequest('/oauth/token', 'POST', authData, null, true);
      
      console.log('✅ Autenticación exitosa');
      console.log(`🔑 Token: ${authResponse.access_token.substring(0, 20)}...`);
      
      // Consultar historial
      console.log(`\n📋 Consultando app ${APP_ID}...`);
      const historyResponse = await podioRequest(`/item/app/${APP_ID}/?limit=10`, 'GET', null, authResponse.access_token);
      
      console.log(`\n✅ Respuesta recibida:`);
      console.log(`   Total items: ${historyResponse.items ? historyResponse.items.length : 0}`);
      console.log(`   Filtered: ${historyResponse.filtered || 0}`);
      console.log(`   Total: ${historyResponse.total || 0}`);
      
      if (historyResponse.items && historyResponse.items.length > 0) {
        console.log(`\n📊 Primer item:`);
        const item = historyResponse.items[0];
        console.log(`   ID: ${item.item_id}`);
        console.log(`   Título: ${item.title}`);
        console.log(`   Creado: ${item.created_on}`);
        console.log(`\n📝 Campos disponibles:`);
        
        if (item.fields) {
          item.fields.forEach(field => {
            console.log(`   - ${field.external_id} (${field.label}): ${field.type}`);
          });
        }
        
        console.log(`\n📄 RESPUESTA COMPLETA (primer item):`);
        console.log(JSON.stringify(item, null, 2));
      } else {
        console.log('\n⚠️  No se encontraron items en la app');
        console.log('📄 RESPUESTA COMPLETA:');
        console.log(JSON.stringify(historyResponse, null, 2));
      }
      
    } catch (error) {
      console.error('\n❌ Error:', error.message);
    }
  });
});

