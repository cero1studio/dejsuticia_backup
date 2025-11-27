# 🔍 DEBUG: Historial de Respaldos No Se Carga

## 🎯 Objetivo

Identificar por qué el historial de respaldos no está trayendo items de Podio.

---

## 📋 Opciones de Debug

### **Opción 1: Ver Logs en la Aplicación Electron** ⭐ Recomendado

1. **Ejecuta la aplicación:**
   ```bash
   npm run electron-dev
   ```

2. **Abre DevTools:**
   - Mac: `Cmd + Option + I`
   - Windows: `Ctrl + Shift + I`

3. **Ve a la pestaña "Console"**

4. **Inicia sesión y busca estos logs:**

   **Si funciona, verás:**
   ```
   ✅ Autenticación exitosa, cargando historial...
   📋 Dashboard: Consultando historial con app ID 30233695
   📋 getBackupHistory: Consultando app ID 30233695
   📋 getBackupHistory: Respuesta COMPLETA recibida: {...}
   📋 getBackupHistory: 5 items encontrados
   📋 Item #0 - Campos disponibles: [...]
   ✅ getBackupHistory: Retornando 5 items
   📋 Dashboard: Historial recibido con 5 items
   ```

   **Si NO funciona, verás:**
   ```
   ⚠️ Respuesta vacía de Podio
   ⚠️ response.items no existe
   ⚠️ response.items no es un array
   ❌ Campo 'fecha' NO encontrado en item
   ```

5. **Copia los logs completos y envíalos**

---

### **Opción 2: Script de Prueba Independiente** 🧪

Si la aplicación no muestra nada, usa este script:

```bash
# Ejecutar el script de prueba
node test-backup-history.js
```

**El script te pedirá:**
1. Tu email de Podio
2. Tu contraseña

**Y mostrará:**
- ✅ Si la autenticación funciona
- 📋 Cuántos items encontró en la app
- 📝 Qué campos tiene cada item
- 📄 La respuesta completa de Podio

**Ejemplo de salida exitosa:**
```
🔍 TEST DE HISTORIAL DE RESPALDOS

📋 App ID a consultar: 30233695

Usuario (email): tu@email.com
Contraseña: ********

🔐 Autenticando...
✅ Autenticación exitosa
🔑 Token: AbCdEfGh1234567890...

📋 Consultando app 30233695...

✅ Respuesta recibida:
   Total items: 5
   Filtered: 5
   Total: 5

📊 Primer item:
   ID: 12345678
   Título: Respaldo del 30/10/2024
   Creado: 2024-10-30T14:30:00

📝 Campos disponibles:
   - fecha (Fecha): date
   - estado (Estado): category
   - organizaciones (Organizaciones): number
   - espacios-de-trabajo (Espacios de Trabajo): number
   - aplicaciones (Aplicaciones): number
   - items (Items): number
   - archivos (Archivos): number
   - tamano-en-gb (Tamaño en GB): text
```

---

## 🔎 Problemas Comunes

### **1. App ID Incorrecto**

**Síntoma:**
```
Total items: 0
⚠️  No se encontraron items en la app
```

**Solución:**
1. Verifica en Podio cuál es el ID correcto de la app de respaldos
2. En la URL de la app, busca algo como: `https://podio.com/dejusticia/workspace/apps/backup/30233695`
3. El número al final es el APP_ID

**Crear archivo `.env`:**
```bash
echo "NEXT_PUBLIC_PODIO_BACKUP_APP_ID=TU_APP_ID_AQUI" > .env
```

---

### **2. No Hay Items en la App**

**Síntoma:**
```
Total items: 0
Filtered: 0
Total: 0
```

**Verificar:**
- Abre la app en Podio manualmente
- ¿Hay items creados?
- ¿Tienes permisos para verlos?

---

### **3. Campos con Nombres Diferentes**

**Síntoma:**
```
⚠️ Campo 'fecha' NO encontrado en item
⚠️ Campo 'estado' NO encontrado en item
```

**El script mostrará los campos reales:**
```
📝 Campos disponibles:
   - backup-date (Fecha del Backup): date
   - status (Estado): category
   - orgs (Organizaciones): number
```

**Solución:** Necesitarás actualizar los `external_id` en el código para que coincidan.

---

### **4. Error de Autenticación**

**Síntoma:**
```
❌ Error: HTTP 401: Unauthorized
```

**Verificar:**
- Usuario y contraseña correctos
- CLIENT_ID y CLIENT_SECRET correctos en el código

---

### **5. App No Existe o Sin Permisos**

**Síntoma:**
```
❌ Error: HTTP 404: Not Found
```

**Verificar:**
- El APP_ID existe
- Tienes permisos de lectura en esa app
- La app no fue eliminada

---

## 📊 **Qué Hacer Después**

### **Caso A: El script encuentra items, pero la app Electron no**

Esto indica un problema en el código de React. Envía:
1. Los logs del script ✅
2. Los logs de la consola de Electron ❌
3. Screenshot de la tabla vacía

### **Caso B: Ni el script ni Electron encuentran items**

Esto indica:
- App ID incorrecto
- App sin items
- Problema de permisos

Verifica el APP_ID en Podio.

### **Caso C: Ambos encuentran items pero los campos no coinciden**

Los `external_id` de los campos en Podio son diferentes. 

Envía la salida del script con los **campos disponibles** y actualizaremos el código.

### **Caso D: Error de autenticación en ambos**

Problema con las credenciales o CLIENT_ID/SECRET.

---

## 🚀 **Siguiente Paso**

**Por favor ejecuta AHORA:**

1. **Opción rápida** (en Electron):
   ```bash
   npm run electron-dev
   # Abre DevTools (Cmd+Option+I)
   # Copia TODOS los logs de la consola
   ```

2. **Opción completa** (script):
   ```bash
   node test-backup-history.js
   # Ingresa tus credenciales
   # Copia TODA la salida
   ```

**Y envíame los logs completos.** 📋

---

## 🛠️ Cambios Aplicados para Debug

Los siguientes logs ya están agregados en el código:

✅ `lib/podio-service.ts`:
- Muestra la respuesta completa de Podio
- Muestra cuántos items encontró
- Muestra el primer item completo
- Muestra los campos disponibles (external_id, label, type)
- Advierte si algún campo esperado no existe

✅ `app/dashboard-electron/page.tsx`:
- Logs al cargar el historial inicial
- Logs al recargar después de un backup

✅ `test-backup-history.js`:
- Script independiente para probar la conexión
- No depende de React o Next.js
- Muestra TODO lo que Podio retorna

---

**¡Con estos logs podré ver exactamente qué está pasando!** 🎯

